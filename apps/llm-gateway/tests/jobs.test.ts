import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { LlmError, type AssistantResponse } from "@llm-providers/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { jobAttempts, jobRequests, jobs, providerAccounts, userApiKeys, users, webhookDeliveries } from "../src/db/schema.js";
import { createUser } from "../src/users/service.js";
import { createAccount, updateAccount } from "../src/accounts/service.js";
import { createExecutor } from "../src/jobs/provider.js";
import { claimJob, completeClaim, renewClaim, runOnce, runWorker } from "../src/jobs/worker.js";
import { cleanupRequests } from "../src/jobs/retention.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
const { db, pool } = createDatabase(url);
const config = { adminApiKey: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32) };
const app = createApp(db, config);
type User = Awaited<ReturnType<typeof createUser>>;
let first: User;
let second: User;
let account: Awaited<ReturnType<typeof createAccount>>;
const userIds: string[] = [];
const messages = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];
const signal = () => new AbortController().signal;
const response = (fields: Partial<AssistantResponse> = {}): AssistantResponse => ({
  id: "response-1", modelId: "gpt-6-astra", message: { role: "assistant", provider: "openai",
    content: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello back" }] }] },
  stopReason: "stop", durationMs: 12, timestamp: Date.now(),
  usage: { input: 10, output: 5, cacheRead: 0, cost: { input: 0.0001, output: 0.00025, cacheRead: 0, total: 0.00035 } }, ...fields,
});

function request(path: string, method = "GET", body?: unknown, token = first.key.secret) {
  return app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fresh(fields = {}) { return { idempotencyKey: randomUUID(), accountId: account.id, modelId: "gpt-6-astra", messages, ...fields }; }
async function submit(input: unknown = fresh(), token = first.key.secret) {
  const res = await request("/v1/jobs", "POST", input, token);
  assert.equal(res.status, 202, await res.clone().text());
  return res.json() as Promise<{ id: string; status: string }>;
}
async function stored(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  assert.ok(job);
  return job;
}
async function attempts(id: string) { return db.select().from(jobAttempts).where(eq(jobAttempts.jobId, id)).orderBy(jobAttempts.attemptNumber); }
async function events(id: string) { return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.jobId, id)); }
async function claim() {
  const item = await claimJob(db);
  assert.ok(item && !item.completed);
  return item;
}
async function due(id: string) { await db.update(jobs).set({ nextAttemptAt: new Date(0) }).where(eq(jobs.id, id)); }
async function expireLease(id: string) { await db.update(jobs).set({ leaseExpiresAt: new Date(0) }).where(eq(jobs.id, id)); }
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for worker state");
    await sleep(10);
  }
}

before(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }); });
after(async () => { await pool.end(); });

describe("jobs API and worker", () => {
  beforeEach(async () => {
    first = await createUser(db, config.encryptionKey, { name: "First", callbackUrl: "https://example.com/callback" });
    userIds.push(first.user.id);
    second = await createUser(db, config.encryptionKey, { name: "Second", callbackUrl: "https://example.com/second" });
    userIds.push(second.user.id);
    account = await createAccount(db, config.encryptionKey, first.user.id, { name: "OpenAI", provider: "openai", config: {}, secrets: { apiKey: "test-provider-key" }, enabled: true });
  });
  afterEach(async () => {
    if (!userIds.length) return;
    const ownedJobs = db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.userId, userIds));
    await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.userId, userIds));
    await db.delete(jobAttempts).where(inArray(jobAttempts.jobId, ownedJobs));
    await db.delete(jobRequests).where(inArray(jobRequests.jobId, ownedJobs));
    await db.delete(jobs).where(inArray(jobs.userId, userIds));
    await db.delete(providerAccounts).where(inArray(providerAccounts.userId, userIds));
    await db.delete(userApiKeys).where(inArray(userApiKeys.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  it("accepts durable jobs without calling a provider in the HTTP handler", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected"); });
    const input = fresh({ instructions: "Be concise.", providerOptions: { temperature: 0.2 } });
    const job = await submit(input);
    assert.equal(job.status, "queued");
    const details = await (await request(`/v1/jobs/${job.id}`)).json();
    assert.equal(details.previousJobId, null);
    assert.equal(details.requestStatus, "retained");
    assert.deepEqual(details.request.messages, messages);
    assert.equal(details.requestExpiresAt, null);
    assert.deepEqual(await attempts(job.id), []);
    assert.deepEqual(await events(job.id), []);
    assert.equal(fetch.mock.callCount(), 0);
    const text = JSON.stringify(details);
    for (const secret of ["test-provider-key", "requestHash", "leaseToken", "secretsEncrypted"]) assert.ok(!text.includes(secret));
  });

  it("serializes concurrent equal submissions and rejects conflicting fingerprints", async () => {
    const input = fresh();
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(input)));
    assert.equal(new Set(results.map((job) => job.id)).size, 1);
    const duplicate = await submit({ ...input, previousJobId: null, tools: [], providerOptions: {} });
    assert.equal(duplicate.id, results[0]!.id);
    const conflict = await request("/v1/jobs", "POST", { ...input, instructions: "changed" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "idempotency_conflict");
    const rows = await db.select().from(jobRequests).where(eq(jobRequests.jobId, duplicate.id));
    assert.equal(rows.length, 1);
  });

  it("preserves escaped Unicode through requests, responses, callbacks, and continuations", async () => {
    const text = "NUL:\u0000 high:\ud800 low:\udfff emoji:🦊";
    const native = { type: "future_item", [text]: text, nested: [text] };
    const input = fresh({ instructions: text,
      messages: [{ role: "user", content: [{ type: "text", text }], metadata: { [text]: text } }],
      providerOptions: { native } });
    const job = await submit(input);
    assert.equal((await submit(input)).id, job.id);
    const result = response({ message: { role: "assistant", provider: "openai", content: [native] } });
    await runOnce(db, async (_account, _model, payload) => {
      assert.deepEqual(payload.messages, input.messages);
      assert.equal(payload.instructions, text);
      assert.deepEqual(payload.providerOptions, { native });
      return result;
    }, signal());
    const details = await (await request(`/v1/jobs/${job.id}`)).json();
    assert.equal(details.status, "succeeded");
    assert.deepEqual(details.response, result);
    assert.deepEqual((await events(job.id))[0]!.payload.response, result);
    const listing = await request("/v1/jobs");
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).data[0].usage, result.usage);
    const child = await submit({ previousJobId: job.id, idempotencyKey: randomUUID(), messages });
    const continued = await (await request(`/v1/jobs/${child.id}`)).json();
    assert.deepEqual(continued.request.messages, [...input.messages, result.message, ...messages]);
  });

  it("aborts provider work when a database lock prevents heartbeat renewal", { timeout: 20_000 }, async () => {
    const job = await submit();
    const blocker = await pool.connect();
    try {
      await runOnce(db, async (_account, _model, _payload, callSignal) => {
        await blocker.query("BEGIN");
        await blocker.query("select id from jobs where id = $1 for update", [job.id]);
        const started = Date.now();
        await new Promise<void>((resolve) => callSignal.addEventListener("abort", () => resolve(), { once: true }));
        assert.ok(Date.now() - started < 18_000);
        throw new Error("Provider aborted after renewal timeout");
      }, signal());
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    assert.equal((await stored(job.id)).status, "running");
    assert.equal((await attempts(job.id))[0]!.status, "running");
    assert.deepEqual(await events(job.id), []);
  });

  it("locally aborts provider work at the job deadline", { timeout: 5_000 }, async () => {
    const job = await submit();
    await db.update(jobs).set({ createdAt: new Date(Date.now() - 30 * 60_000 + 500) }).where(eq(jobs.id, job.id));
    await runOnce(db, async (_account, _model, _payload, callSignal) => {
      await new Promise<void>((resolve) => {
        if (callSignal.aborted) resolve();
        else callSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new LlmError("Deadline reached", { provider: "openai", kind: "timeout" });
    }, signal());
    assert.equal((await stored(job.id)).status, "failed");
    assert.equal((await attempts(job.id)).length, 1);
  });

  it("authenticates and isolates every endpoint and continuation by user", async () => {
    const job = await submit();
    for (const [method, path] of [["GET", "/v1/jobs"], ["POST", "/v1/jobs"], ["GET", `/v1/jobs/${job.id}`],
      ["GET", `/v1/jobs/${job.id}/attempts`], ["POST", `/v1/jobs/${job.id}/cancel`]]) {
      assert.equal((await app.request(path!, { method: method! })).status, 401);
      assert.equal((await request(path!, method!, undefined, config.adminApiKey)).status, 401);
    }
    for (const [method, path] of [["GET", `/v1/jobs/${job.id}`], ["GET", `/v1/jobs/${job.id}/attempts`], ["POST", `/v1/jobs/${job.id}/cancel`]])
      assert.equal((await request(path!, method!, undefined, second.key.secret)).status, 404);
    assert.deepEqual((await (await request("/v1/jobs", "GET", undefined, second.key.secret)).json()).data, []);
    assert.equal((await request("/v1/jobs", "POST", fresh(), second.key.secret)).status, 404);
    assert.equal((await request("/v1/jobs", "POST", { idempotencyKey: "child", previousJobId: job.id, messages: [] }, second.key.secret)).status, 404);
    await db.update(users).set({ enabled: false }).where(eq(users.id, first.user.id));
    assert.equal((await request("/v1/jobs")).status, 401);
  });

  it("rejects invalid shapes, models, unavailable accounts, and untrusted destinations before acceptance", async () => {
    for (const input of [fresh({ modelId: "made-up" }), fresh({ apiKey: "secret" }), fresh({ messages: null }), fresh({ messages: [{ role: "bad" }] })])
      assert.equal((await request("/v1/jobs", "POST", input)).status, 400);
    assert.equal((await request("/v1/jobs", "POST", fresh({ accountId: randomUUID() }))).status, 404);
    assert.equal((await app.request("/v1/jobs", { method: "POST", headers: { authorization: `Bearer ${first.key.secret}` }, body: "{}" })).status, 415);
    assert.equal((await app.request("/v1/jobs", { method: "POST", headers: { authorization: `Bearer ${first.key.secret}`, "content-type": "application/json" }, body: "{" })).status, 400);
    await updateAccount(db, config.encryptionKey, first.user.id, account.id, { enabled: false });
    assert.equal((await request("/v1/jobs", "POST", fresh())).status, 409);
    await updateAccount(db, config.encryptionKey, first.user.id, account.id, { enabled: true, config: { baseUrl: "https://untrusted.example/v1" } });
    assert.equal((await request("/v1/jobs", "POST", fresh())).status, 400);
    assert.equal((await db.select().from(jobs).where(eq(jobs.userId, first.user.id))).length, 0);
  });

  it("accepts contexts larger than management bodies and caps HTTP/assembled input at 16 MiB", async () => {
    await submit(fresh({ instructions: "x".repeat(20_000) }));
    const res = await request("/v1/jobs", "POST", fresh({ instructions: "x".repeat(16 * 1024 * 1024) }));
    assert.equal(res.status, 413);
  });

  it("saves response, usage, expiry, and exactly one destination-snapshotted event atomically", async () => {
    const job = await submit();
    const item = await claim();
    await db.update(users).set({ callbackUrl: "https://example.com/new" }).where(eq(users.id, first.user.id));
    const result = response();
    await completeClaim(db, item, { response: result });
    await completeClaim(db, item, { response: response({ id: "stale" }) });
    const finished = await stored(job.id);
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.response, result);
    assert.equal(finished.leaseToken, null);
    const [payload] = await db.select().from(jobRequests).where(eq(jobRequests.jobId, job.id));
    assert.equal(payload!.expiresAt!.getTime() - finished.finishedAt!.getTime(), 7 * 86_400_000);
    const [attempt] = await attempts(job.id);
    assert.equal(attempt!.inputTokens, 10n);
    assert.equal(attempt!.cacheReadTokens, 0n);
    assert.equal(attempt!.cacheWriteTokens, null);
    assert.equal(attempt!.totalCostUsd, "0.000350000000");
    const callback = await events(job.id);
    assert.equal(callback.length, 1);
    assert.equal(callback[0]!.callbackUrl, "https://example.com/new");
    assert.equal(callback[0]!.payload.eventId, callback[0]!.id);
    assert.deepEqual(callback[0]!.payload.response, result);
    assert.equal(callback[0]!.status, "pending");
    const serialized = await (await request(`/v1/jobs/${job.id}/attempts`)).json();
    assert.equal(serialized.data[0].inputTokens, "10");
    assert.equal(serialized.data[0].totalCostUsd, "0.000350000000");
  });

  it("rolls back completion when the callback write fails", async () => {
    const job = await submit();
    const item = await claim();
    // A duplicate event forces the final transaction to fail its unique constraint.
    await db.insert(webhookDeliveries).values({ jobId: job.id, userId: first.user.id, eventType: "job.failed", callbackUrl: first.user.callbackUrl, payload: {} });
    await assert.rejects(completeClaim(db, item, { response: response() }));
    assert.equal((await stored(job.id)).status, "running");
    assert.equal((await attempts(job.id))[0]!.status, "running");
    const [payload] = await db.select().from(jobRequests).where(eq(jobRequests.jobId, job.id));
    assert.equal(payload!.expiresAt, null);
  });

  it("creates independent continuation snapshots and deduplicates after parent cleanup", async () => {
    const parent = await submit(fresh({ instructions: "Keep these", providerOptions: { temperature: 0.2 } }));
    const result = response();
    await runOnce(db, async () => result, signal());
    const extra = [{ role: "user", content: [{ type: "text", text: "Next" }] }];
    const input = { idempotencyKey: "next", previousJobId: parent.id, messages: extra };
    const child = await submit(input);
    const sibling = await submit({ ...input, idempotencyKey: "branch", messages: [] });
    const details = await (await request(`/v1/jobs/${child.id}`)).json();
    assert.equal(details.accountId, account.id);
    assert.equal(details.previousJobId, parent.id);
    assert.equal(details.request.instructions, "Keep these");
    assert.deepEqual(details.request.providerOptions, { temperature: 0.2 });
    assert.deepEqual(details.request.messages, [...messages, result.message, ...extra]);
    await db.update(jobRequests).set({ expiresAt: new Date(0) }).where(eq(jobRequests.jobId, parent.id));
    assert.equal(await cleanupRequests(db), 1);
    assert.equal((await submit(input)).id, child.id);
    assert.equal((await request("/v1/jobs", "POST", { ...input, idempotencyKey: "new-child" })).status, 410);
    assert.equal((await (await request(`/v1/jobs/${parent.id}`)).json()).requestStatus, "expired");
    assert.equal((await (await request(`/v1/jobs/${sibling.id}`)).json()).requestStatus, "retained");
    assert.deepEqual((await stored(parent.id)).response, result);
  });

  it("rejects unfinished/expired parents and overrides without inserting children", async () => {
    const parent = await submit();
    const input = { idempotencyKey: "next", previousJobId: parent.id, messages: [] };
    assert.equal((await request("/v1/jobs", "POST", input)).status, 409);
    for (const override of [{ messages: null }, { instructions: "change" }, { tools: [] }, { accountId: account.id }])
      assert.equal((await request("/v1/jobs", "POST", { ...input, ...override })).status, 400);
    await runOnce(db, async () => response(), signal());
    await db.update(jobRequests).set({ expiresAt: new Date(0) }).where(eq(jobRequests.jobId, parent.id));
    assert.equal((await request("/v1/jobs", "POST", input)).status, 410);
    assert.equal((await (await request(`/v1/jobs/${parent.id}`)).json()).request, null);
  });

  it("retries transient errors with fresh credentials and records each attempt without leaking errors", async () => {
    const job = await submit();
    await runOnce(db, async () => { throw new LlmError("test-provider-key prompt", { provider: "openai", kind: "provider_error", httpStatus: 429, retryAfterMs: 60_000 }); }, signal());
    const waiting = await stored(job.id);
    assert.equal(waiting.status, "retry_wait");
    assert.ok(waiting.nextAttemptAt.getTime() > Date.now() + 55_000);
    assert.equal(await runOnce(db, async () => response(), signal()), false);
    assert.equal((await events(job.id)).length, 0);
    assert.ok(!JSON.stringify((await attempts(job.id))[0]!.error).includes("test-provider-key"));
    await updateAccount(db, config.encryptionKey, first.user.id, account.id, { secrets: { apiKey: "rotated-key" } });
    await due(job.id);
    const execute = createExecutor(config.encryptionKey, [], async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-key");
      return Response.json({ id: "resp-ok", object: "response", model: "gpt-6-astra", status: "completed", output: [] });
    });
    await runOnce(db, execute, signal());
    assert.equal((await stored(job.id)).status, "succeeded");
    const history = await attempts(job.id);
    assert.deepEqual(history.map((row) => row.accountConfigVersion), [1, 2]);
    assert.deepEqual(history.map((row) => row.status), ["failed", "succeeded"]);
    assert.equal(history[1]!.inputTokens, null);
  });

  it("bounds attempts and deadlines, and does not retry permanent or incomplete responses", async () => {
    const job = await submit();
    for (let i = 0; i < 3; i++) {
      await due(job.id);
      await runOnce(db, async () => { throw new LlmError("failure", { provider: "openai", kind: "network_error" }); }, signal());
    }
    assert.equal((await stored(job.id)).status, "failed");
    assert.equal((await attempts(job.id)).length, 3);
    const expired = await submit();
    await db.update(jobs).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(jobs.id, expired.id));
    await runOnce(db, async () => { assert.fail("Expired job must not dispatch"); }, signal());
    assert.equal((await stored(expired.id)).error!.code, "job_deadline_exceeded");
    assert.equal((await attempts(expired.id)).length, 0);
    const permanent = await submit();
    await runOnce(db, async () => { throw new LlmError("failure", { provider: "openai", kind: "provider_error", httpStatus: 401 }); }, signal());
    assert.equal((await stored(permanent.id)).status, "failed");
    const incomplete = await submit();
    await runOnce(db, async () => response({ stopReason: "length" }), signal());
    assert.equal((await stored(incomplete.id)).status, "succeeded");
  });

  it("finishes immediately when Retry-After exceeds the job deadline", async () => {
    const job = await submit();
    await runOnce(db, async () => { throw new LlmError("later", { provider: "openai", kind: "provider_error", httpStatus: 503, retryAfterMs: 3_600_000 }); }, signal());
    assert.equal((await stored(job.id)).status, "failed");
    assert.equal((await attempts(job.id)).length, 1);
  });

  it("cancels queued/retry work immediately and keeps terminal outcomes stable", async () => {
    for (const retry of [false, true]) {
      const job = await submit();
      if (retry) await runOnce(db, async () => { throw new LlmError("later", { provider: "openai", kind: "timeout" }); }, signal());
      const firstCancel = await (await request(`/v1/jobs/${job.id}/cancel`, "POST")).json();
      assert.equal(firstCancel.status, "cancelled");
      assert.deepEqual(await (await request(`/v1/jobs/${job.id}/cancel`, "POST")).json(), firstCancel);
      assert.equal((await events(job.id)).length, 1);
    }
    const success = await submit();
    await runOnce(db, async () => response(), signal());
    assert.equal((await (await request(`/v1/jobs/${success.id}/cancel`, "POST")).json()).status, "succeeded");
  });

  it("honors cancellation of running work and preserves any observed usage", async () => {
    const job = await submit();
    const item = await claim();
    const cancelled = await (await request(`/v1/jobs/${job.id}/cancel`, "POST")).json();
    assert.equal(cancelled.status, "running");
    assert.ok((await renewClaim(db, item))!.cancelRequestedAt);
    await completeClaim(db, item, { response: response() });
    assert.equal((await stored(job.id)).status, "cancelled");
    assert.equal((await stored(job.id)).response, null);
    assert.equal((await attempts(job.id))[0]!.inputTokens, 10n);
    assert.equal((await events(job.id))[0]!.eventType, "job.cancelled");
  });

  it("aborts in-flight provider I/O when the heartbeat observes cancellation", { timeout: 20_000 }, async () => {
    const job = await submit();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const running = runOnce(db, async (_account, _model, _input, callSignal) => {
      started();
      return new Promise<AssistantResponse>((_resolve, reject) => {
        callSignal.addEventListener("abort", () => reject(new LlmError("cancelled", { provider: "openai", kind: "cancelled" })), { once: true });
      });
    }, signal());
    await ready;
    await request(`/v1/jobs/${job.id}/cancel`, "POST");
    await running;
    assert.equal((await stored(job.id)).status, "cancelled");
    assert.equal((await attempts(job.id))[0]!.status, "cancelled");
    assert.equal((await events(job.id)).length, 1);
  });

  it("claims concurrently without duplication and fences expired/stale results", async () => {
    const firstJob = await submit();
    const secondJob = await submit();
    const claims = await Promise.all([claim(), claim()]);
    assert.notEqual(claims[0]!.job.id, claims[1]!.job.id);
    assert.deepEqual(new Set(claims.map((item) => item.job.id)), new Set([firstJob.id, secondJob.id]));
    assert.equal(await claimJob(db), null);
    const stale = claims[0]!;
    assert.ok(await renewClaim(db, stale));
    await expireLease(stale.job.id);
    assert.equal(await renewClaim(db, stale), undefined);
    await completeClaim(db, stale, { response: response({ id: "too-late" }) });
    assert.equal((await stored(stale.job.id)).response, null);
    const replacement = await claim();
    assert.equal(replacement.job.id, stale.job.id);
    assert.notEqual(replacement.leaseToken, stale.leaseToken);
    await completeClaim(db, stale, { response: response({ id: "stale" }) });
    await completeClaim(db, replacement, { response: response({ id: "replacement" }) });
    assert.equal((await stored(stale.job.id)).response!.id, "replacement");
    assert.deepEqual((await attempts(stale.job.id)).map((row) => row.status), ["unknown", "succeeded"]);
  });

  for (const concurrency of [undefined, 3, 32]) {
    it(`bounds worker execution to ${concurrency ?? "the default single"} slot(s) and keeps processing after a failure`, { timeout: 10_000 }, async () => {
      const slots = concurrency ?? 1;
      const count = slots * 2 + 1;
      const queued = await Promise.all(Array.from({ length: count }, (_,i) => submit(fresh({ instructions: String(i) }))));
      const controller = new AbortController();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let active = 0;
      let peak = 0;
      const calls: string[] = [];
      const running = runWorker(db, async (_account, _model, input, callSignal) => {
        calls.push(input.instructions!);
        peak = Math.max(peak, ++active);
        try {
          await gate;
          await sleep(10, undefined, { signal: callSignal });
          if (input.instructions === "0") throw new LlmError("Fixture failure", { provider: "openai", kind: "invalid_request" });
          return response();
        } finally { active--; }
      }, controller.signal, 7, concurrency);
      try {
        await until(async () => calls.length >= slots);
        await sleep(50);
        assert.equal(calls.length, slots, "Queued jobs must not start while all slots are occupied");
        release();
        await until(async () => (await db.select({ status: jobs.status }).from(jobs).where(inArray(jobs.id, queued.map(job => job.id))))
          .every(job => job.status === "succeeded" || job.status === "failed"));
        assert.equal(peak, slots);
        assert.equal(calls.length, count);
        assert.equal(new Set(calls).size, count);
        for (let i = 0; i < queued.length; i++) {
          assert.equal((await stored(queued[i]!.id)).status, i === 0 ? "failed" : "succeeded");
          assert.equal((await attempts(queued[i]!.id)).length, 1);
          assert.equal((await events(queued[i]!.id)).length, 1);
        }
      } finally {
        controller.abort();
        release();
        await running;
      }
    });
  }

  it("cleans expired input while slots are busy and aborts every active call on shutdown", { timeout: 10_000 }, async () => {
    const expired = await submit();
    await completeClaim(db, await claim(), { response: response() });
    await db.update(jobRequests).set({ expiresAt: new Date(0) }).where(eq(jobRequests.jobId, expired.id));
    const queued = await Promise.all(Array.from({ length: 7 }, () => submit()));
    const controller = new AbortController();
    let started = 0;
    let aborted = 0;
    const running = runWorker(db, async (_account, _model, _input, callSignal) => {
      started++;
      try { await sleep(60_000, undefined, { signal: callSignal }); }
      finally { if (callSignal.aborted) aborted++; }
      return response();
    }, controller.signal, 7, 3);
    try {
      await until(async () => started === 3);
      await until(async () => (await db.select().from(jobRequests).where(eq(jobRequests.jobId, expired.id))).length === 0);
    } finally {
      controller.abort();
      await running;
    }
    assert.equal(started, 3);
    assert.equal(aborted, 3);
    const rows = await db.select().from(jobs).where(inArray(jobs.id, queued.map(job => job.id)));
    assert.equal(rows.filter(job => job.status === "running").length, 3);
    assert.equal(rows.filter(job => job.status === "queued").length, 4);
    assert.ok(rows.every(job => job.cancelRequestedAt === null && job.response === null));
    for (const job of queued) assert.equal((await events(job.id)).length, 0);
    await runWorker(db, async () => { assert.fail("Stopped workers must not dispatch"); }, controller.signal, 7, 3);
  });

  it("recovers cancellation and exhausted crashed attempts without another provider call", async () => {
    const cancelled = await submit();
    await claim();
    await request(`/v1/jobs/${cancelled.id}/cancel`, "POST");
    await expireLease(cancelled.id);
    assert.deepEqual(await claimJob(db), { completed: true });
    assert.equal((await stored(cancelled.id)).status, "cancelled");
    const exhausted = await submit();
    for (let i = 0; i < 3; i++) { await claim(); await expireLease(exhausted.id); }
    assert.deepEqual(await claimJob(db), { completed: true });
    assert.equal((await stored(exhausted.id)).error!.code, "attempts_exhausted");
    assert.equal((await events(exhausted.id)).length, 1);
  });

  it("checks lease expiry after waiting for a job row lock", async () => {
    const job = await submit();
    const item = await claim();
    await db.update(jobs).set({ leaseExpiresAt: new Date(Date.now() + 500) }).where(eq(jobs.id, job.id));
    let completing!: Promise<void>;
    await db.transaction(async (tx) => {
      await tx.select().from(jobs).where(eq(jobs.id, job.id)).for("update");
      completing = completeClaim(db, item, { response: response() });
      await sleep(750);
    });
    await completing;
    assert.equal((await stored(job.id)).status, "running");
    assert.equal((await events(job.id)).length, 0);
  });

  it("uses shutdown as lease recovery, not a user cancellation", async () => {
    const job = await submit();
    const controller = new AbortController();
    await runOnce(db, async (_account, _model, _input, callSignal) => {
      controller.abort();
      assert.ok(callSignal.aborted);
      throw new Error("shutdown");
    }, controller.signal);
    assert.equal((await stored(job.id)).status, "running");
    assert.equal((await stored(job.id)).cancelRequestedAt, null);
    assert.equal((await events(job.id)).length, 0);
    await expireLease(job.id);
    await runOnce(db, async () => response(), signal());
    assert.equal((await stored(job.id)).status, "succeeded");
  });

  it("does not dispatch a provider call when shutdown arrives during a pending claim", { timeout: 10_000 }, async () => {
    const job = await submit();
    const controller = new AbortController();
    const clients = await Promise.all(Array.from({ length: pool.options.max! }, () => pool.connect()));
    const running = runOnce(db, async () => { assert.fail("Shutdown must prevent provider dispatch"); }, controller.signal);
    try {
      await until(async () => pool.waitingCount > 0);
    } finally {
      controller.abort();
      for (const client of clients) client.release();
      await running;
    }
    assert.equal((await stored(job.id)).status, "running");
    assert.equal((await attempts(job.id)).length, 1);
    assert.equal((await events(job.id)).length, 0);
  });

  it("blocks new attempts after disable/delete but lets an existing claim complete", async () => {
    const running = await submit();
    const queued = await submit();
    await due(running.id);
    const item = await claim();
    assert.equal(item.job.id, running.id);
    await request(`/v1/accounts/${account.id}`, "DELETE");
    await completeClaim(db, item, { response: response() });
    assert.equal((await stored(running.id)).status, "succeeded");
    await runOnce(db, async () => { assert.fail("Deleted account must not dispatch"); }, signal());
    assert.equal((await stored(queued.id)).error!.code, "account_unavailable");
    assert.equal((await attempts(queued.id)).length, 0);
    assert.equal((await request(`/v1/jobs/${running.id}`)).status, 200);
  });

  it("lists metadata with filters and lossless microsecond pagination", async () => {
    const created = await Promise.all([submit(), submit(), submit()]);
    for (let i = 0; i < created.length; i++) await db.execute(sql`update jobs set created_at = ${`2026-01-01T00:00:00.00000${i + 1}Z`}::timestamptz where id = ${created[i]!.id}::uuid`);
    const page = await (await request("/v1/jobs?limit=1&provider=openai&status=queued&from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z")).json();
    assert.equal(page.data[0].id, created[2]!.id);
    assert.ok(!("request" in page.data[0]));
    assert.ok(!("response" in page.data[0]));
    const next = await (await request(`/v1/jobs?limit=1&cursor=${page.nextCursor}`)).json();
    assert.equal(next.data[0].id, created[1]!.id);
    const final = await (await request(`/v1/jobs?limit=1&cursor=${next.nextCursor}`)).json();
    assert.equal(final.data[0].id, created[0]!.id);
    assert.equal(final.nextCursor, null);
    assert.deepEqual((await (await request("/v1/jobs?provider=fireworks")).json()).data, []);
    assert.equal((await request("/v1/jobs?unknown=true")).status, 400);
    assert.equal((await request("/v1/jobs?cursor=invalid")).status, 400);
    const key = (await stored(created[0]!.id)).idempotencyKey;
    assert.equal((await (await request(`/v1/jobs?accountId=${account.id}&modelId=gpt-6-astra&idempotencyKey=${key}`)).json()).data.length, 1);
  });

  it("cleans only expired terminal requests, skipping locked parents", async () => {
    const terminal = await submit();
    await runOnce(db, async () => response(), signal());
    const pending = await submit();
    await db.update(jobRequests).set({ expiresAt: new Date(0) }).where(inArray(jobRequests.jobId, [terminal.id, pending.id]));
    await db.transaction(async (tx) => {
      await tx.select().from(jobs).where(eq(jobs.id, terminal.id)).for("update");
      assert.equal(await cleanupRequests(db), 0);
    });
    assert.equal(await cleanupRequests(db), 1);
    assert.equal((await db.select().from(jobRequests).where(eq(jobRequests.jobId, pending.id))).length, 1);
    assert.equal((await attempts(terminal.id)).length, 1);
    assert.equal((await events(terminal.id)).length, 1);
  });

  it("limits cleanup batches and rejects oversized reconstructed continuations", async () => {
    const rows = Array.from({ length: 101 }, () => ({ id: randomUUID(), userId: first.user.id, accountId: account.id,
      modelId: "gpt-6-astra", idempotencyKey: randomUUID(), requestHash: "fixture", status: "cancelled" as const, finishedAt: new Date() }));
    await db.insert(jobs).values(rows);
    await db.insert(jobRequests).values(rows.map((row) => ({ jobId: row.id, request: { messages: [] }, expiresAt: new Date(0) })));
    assert.equal(await cleanupRequests(db), 100);
    assert.equal(await cleanupRequests(db), 1);
    const parent = await submit(fresh({ instructions: "x".repeat(9 * 1024 * 1024) }));
    await runOnce(db, async () => response({ message: { role: "assistant", provider: "openai", content: ["x".repeat(8 * 1024 * 1024)] } }), signal());
    const rejected = await request("/v1/jobs", "POST", { idempotencyKey: "too-large-child", previousJobId: parent.id, messages: [] });
    assert.equal(rejected.status, 413);
    assert.equal((await db.select().from(jobs).where(eq(jobs.idempotencyKey, "too-large-child"))).length, 0);
  });

  it("rechecks changed destinations and user availability before another attempt", async () => {
    const job = await submit();
    await updateAccount(db, config.encryptionKey, first.user.id, account.id, { config: { baseUrl: "https://untrusted.example/v1" } });
    let calls = 0;
    await runOnce(db, createExecutor(config.encryptionKey, [], async () => { calls++; return new Response(); }), signal());
    assert.equal((await stored(job.id)).status, "failed");
    assert.equal(calls, 0);
    await updateAccount(db, config.encryptionKey, first.user.id, account.id, { config: { baseUrl: "https://api.openai.com/v1" } });
    const pending = await submit();
    await db.update(users).set({ enabled: false }).where(eq(users.id, first.user.id));
    await runOnce(db, async () => { assert.fail("Disabled user must not dispatch"); }, signal());
    assert.equal((await stored(pending.id)).error!.code, "account_unavailable");
    assert.equal((await attempts(pending.id)).length, 0);
  });

  it("connects all three clients through their existing request and response adapters", async () => {
    for (const provider of ["openai", "chatgpt", "fireworks"] as const) {
      const selected = provider === "openai" ? account : await createAccount(db, config.encryptionKey, first.user.id, {
        name: provider, provider, enabled: true, config: provider === "chatgpt" ? { accountId: "chatgpt-account" } : {},
        secrets: provider === "chatgpt" ? { accessToken: "access-token" } : { apiKey: "fireworks-key" },
      });
      const modelId = provider === "fireworks" ? "accounts/fireworks/models/deepseek-v4p1-flash" : "gpt-6-astra";
      const job = await submit(fresh({ accountId: selected.id, modelId }));
      let calls = 0;
      const executor = createExecutor(config.encryptionKey, [], async (url, init) => {
        calls++;
        assert.equal(init?.redirect, "error");
        const body = JSON.parse(init?.body as string);
        assert.equal(body.model, modelId);
        if (provider === "fireworks") {
          assert.equal(String(url), "https://api.fireworks.ai/inference/v1/chat/completions");
          return Response.json({ id: "fw-response", object: "chat.completion", model: modelId, choices: [{ index: 0, message: { role: "assistant", content: "Hi", reasoning_content: "Thinking" }, finish_reason: "stop" }] });
        }
        const native = { id: "native-response", object: "response", model: modelId, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }] };
        if (provider === "chatgpt") {
          assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
          assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "chatgpt-account");
          return new Response(`data: ${JSON.stringify({ type: "response.completed", response: native })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json(native);
      });
      await runOnce(db, executor, signal());
      const result = await stored(job.id);
      assert.equal(result.status, "succeeded", `${provider}: ${JSON.stringify(result.error)}`);
      assert.equal(result.response!.message.provider, provider);
      assert.equal(calls, 1);
    }
  });
});
