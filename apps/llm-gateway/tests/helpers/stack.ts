import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../src/db/client.js";

const cwd = fileURLToPath(new URL("../../", import.meta.url));

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (done(value)) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the end-to-end state transition.");
}

/** Real compiled processes, an isolated database, and a trusted local HTTPS receiver. */
export async function startStack(receiver: RequestListener) {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL must identify a disposable PostgreSQL server with CREATE DATABASE permission.");
  const { pool: adminPool } = createDatabase(baseUrl);
  const databaseName = `llm_gateway_e2e_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const { pool } = createDatabase(databaseUrl.href);
  const temp = await mkdtemp(join(tmpdir(), "llm-gateway-e2e-"));
  const children: { process: ChildProcess; output: string }[] = [];
  let databaseCreated = false;
  let server: ReturnType<typeof createServer> | undefined;
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
    child.kill("SIGTERM");
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0, `Gateway process shutdown failed (${signal ?? code}).`);
    } finally { clearTimeout(timer); }
  };
  const close = async () => {
    try {
      await Promise.all(children.map(({ process }) => stop(process)));
    } finally {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await pool.end();
      // Only this helper's generated database is removed, never TEST_DATABASE_URL's database.
      if (databaseCreated) await adminPool.query(`drop database "${databaseName}"`);
      await adminPool.end();
      await rm(temp, { recursive: true, force: true });
    }
  };
  try {
    await adminPool.query(`create database "${databaseName}"`);
    databaseCreated = true;
    const cert = join(temp, "cert.pem");
    const key = join(temp, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", key, "-out", cert], { stdio: "ignore" });
    server = createServer({ cert: await readFile(cert), key: await readFile(key) }, receiver);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const adminKey = randomBytes(32).toString("hex");
    // Real provider keys stay in the test runner, not child environments or process arguments.
    const { LIVE_OPENAI_API_KEY: _openai, LIVE_FIREWORKS_API_KEY: _fireworks, ...inherited } = process.env;
    const env = { ...inherited, DATABASE_URL: databaseUrl.href, ADMIN_API_KEY: adminKey,
      ENCRYPTION_KEY: randomBytes(32).toString("hex"), PORT: "0", REQUEST_RETENTION_DAYS: "1",
      PROVIDER_ALLOWED_ORIGINS: origin, WEBHOOK_ALLOWED_ORIGINS: origin, NODE_EXTRA_CA_CERTS: cert };
    const launch = (file: string) => {
      const child = { process: spawn(process.execPath, [file], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }), output: "" };
      children.push(child);
      child.process.stdout!.on("data", (chunk) => { child.output += String(chunk); });
      child.process.stderr!.on("data", (chunk) => { child.output += String(chunk); });
      return child;
    };
    const api = launch("dist/index.js");
    const port = await until(async () => {
      assert.equal(api.process.exitCode, null, "API exited before listening.");
      return api.output.match(/listening on port (\d+)/)?.[1];
    }, (value) => value !== undefined);
    const url = `http://127.0.0.1:${port}`;
    const request = async (path: string, token?: string, method = "GET", body?: unknown, expected = 200) => {
      const response = await fetch(`${url}${path}`, {
        method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
      });
      // Do not include bodies in assertion failures: registration responses contain secrets.
      assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.status === 204 ? null : response.json();
    };
    await request("/healthz");
    await request("/readyz", undefined, "GET", undefined, 503); // Unmigrated database.
    for (let i = 0; i < 2; i++) {
      const migration = launch("dist/db/migrate.js");
      const [code] = await once(migration.process, "exit");
      assert.equal(code, 0, "Compiled migrations failed.");
    }
    await request("/readyz");
    const worker = () => launch("dist/worker.js").process;
    return { request, worker, stop, close, pool, origin, adminKey, url,
      logs: () => children.map((child) => child.output).join("\n") };
  } catch (error) {
    await close();
    throw error;
  }
}
