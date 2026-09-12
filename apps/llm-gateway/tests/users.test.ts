import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { userApiKeys, users } from "../src/db/schema.js";
import { decryptSecret, hashApiKey } from "../src/crypto.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
const { db, pool } = createDatabase(url);
const config = { adminApiKey: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32) };
const app = createApp(db, config);
const createdIds: string[] = [];
type Registration = {
  user: { id: string; name: string; enabled: boolean; callbackUrl: string; createdAt: string; updatedAt: string };
  key: { id: string; secret: string; keyPrefix: string };
  webhookSecret: string;
};
let first: Registration;
let second: Registration;

function request(path: string, method = "GET", token?: string, body?: unknown) {
  return app.request(path, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function register(name: string): Promise<Registration> {
  const response = await request("/v1/admin/users", "POST", config.adminApiKey, { name, callbackUrl: "https://example.com/callback" });
  assert.equal(response.status, 201);
  const result = await response.json() as Registration;
  createdIds.push(result.user.id);
  return result;
}

before(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }); });
after(async () => { await pool.end(); });

describe("user API", () => {
  beforeEach(async () => {
    first = await register("First");
    second = await register("Second");
  });
  afterEach(async () => {
    if (createdIds.length) {
      await db.delete(userApiKeys).where(inArray(userApiKeys.userId, createdIds));
      await db.delete(users).where(inArray(users.id, createdIds));
      createdIds.length = 0;
    }
  });

  it("registers a user and initial key with one-time secrets stored safely", async () => {
    const [storedUser] = await db.select().from(users).where(eq(users.id, first.user.id));
    const [storedKey] = await db.select().from(userApiKeys).where(eq(userApiKeys.id, first.key.id));
    assert.equal(storedKey!.keyHash, hashApiKey(first.key.secret));
    assert.equal(storedKey!.keyPrefix, first.key.keyPrefix);
    assert.equal(decryptSecret(storedUser!.webhookSecretEncrypted, config.encryptionKey, `user:${first.user.id}:webhook`), first.webhookSecret);
    assert.equal(first.user.enabled, true);
    assert.ok(!JSON.stringify(first).includes("keyHash"));
    assert.ok(!JSON.stringify(first).includes("webhookSecretEncrypted"));
  });

  it("rolls back registration if the transaction fails and hides internal errors", async () => {
    const beforeUsers = await db.select({ id: users.id }).from(users);
    const beforeKeys = await db.select({ id: userApiKeys.id }).from(userApiKeys);
    const failingDb = Object.create(db) as typeof db;
    failingDb.transaction = async (callback) => db.transaction(async (tx) => {
      await callback(tx);
      throw new Error("private-database-error-must-not-leak");
    });
    const response = await createApp(failingDb, config).request("/v1/admin/users", {
      method: "POST", headers: { authorization: `Bearer ${config.adminApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rolled back", callbackUrl: "https://example.com/callback" }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "internal_error", message: "Internal server error." } });
    assert.equal((await db.select({ id: users.id }).from(users)).length, beforeUsers.length);
    assert.equal((await db.select({ id: userApiKeys.id }).from(userApiKeys)).length, beforeKeys.length);
  });

  it("requires the correct credential on every admin and user endpoint", async () => {
    for (const [method, path] of [
      ["POST", "/v1/admin/users"], ["GET", "/v1/admin/users"],
      ["GET", `/v1/admin/users/${first.user.id}`], ["PATCH", `/v1/admin/users/${first.user.id}`],
      ["POST", `/v1/admin/users/${first.user.id}/keys`], ["GET", `/v1/admin/users/${first.user.id}/keys`],
      ["DELETE", `/v1/admin/users/${first.user.id}/keys/${first.key.id}`],
    ]) {
      assert.equal((await request(path!, method!, first.key.secret, method === "POST" || method === "PATCH" ? {} : undefined)).status, 401);
      assert.equal((await request(path!, method!)).status, 401);
    }
    for (const [method, path] of [["GET", "/v1/me"], ["PATCH", "/v1/me"], ["POST", "/v1/me/webhook-secret/rotate"]]) {
      assert.equal((await request(path!, method!, config.adminApiKey)).status, 401);
      assert.equal((await request(path!, method!)).status, 401);
    }
    const malformed = await app.request("/v1/me", { headers: { authorization: "Basic invalid" } });
    assert.equal(malformed.status, 401);
    assert.equal(malformed.headers.get("WWW-Authenticate"), "Bearer");
  });

  it("returns only safe user and key fields, with no-store headers", async () => {
    for (const [path, token] of [
      ["/v1/me", first.key.secret], [`/v1/admin/users/${first.user.id}`, config.adminApiKey],
      ["/v1/admin/users", config.adminApiKey], [`/v1/admin/users/${first.user.id}/keys`, config.adminApiKey],
    ]) {
      const response = await request(path!, "GET", token);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const text = await response.text();
      for (const secret of [first.key.secret, first.webhookSecret, "keyHash", "webhookSecretEncrypted", "cursorTime"]) assert.ok(!text.includes(secret));
    }
    assert.equal((await (await request("/v1/me", "GET", first.key.secret)).json()).id, first.user.id);
  });

  it("updates only the caller's settings and rejects ownership or privilege changes", async () => {
    const response = await request("/v1/me", "PATCH", first.key.secret, { name: "Renamed", callbackUrl: "https://example.com/new" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "Renamed");
    for (const body of [{ enabled: false }, { id: second.user.id }, { userId: second.user.id }, { webhookSecret: "override" }, {}]) {
      assert.equal((await request("/v1/me", "PATCH", first.key.secret, body)).status, 400);
    }
    assert.equal((await (await request("/v1/me", "GET", second.key.secret)).json()).name, "Second");
  });

  it("lets admins disable and re-enable users, affecting every key", async () => {
    const extra = await (await request(`/v1/admin/users/${first.user.id}/keys`, "POST", config.adminApiKey, {})).json();
    const path = `/v1/admin/users/${first.user.id}`;
    assert.equal((await request(path, "PATCH", config.adminApiKey, { enabled: false })).status, 200);
    for (const key of [first.key.secret, extra.secret]) assert.equal((await request("/v1/me", "GET", key)).status, 401);
    assert.equal((await request(path, "GET", config.adminApiKey)).status, 200);
    assert.equal((await request(path, "PATCH", config.adminApiKey, { enabled: true })).status, 200);
    assert.equal((await request("/v1/me", "GET", extra.secret)).status, 200);
  });

  it("mints independent keys and scopes idempotent revocation to the owning user", async () => {
    const keyResponse = await request(`/v1/admin/users/${first.user.id}/keys`, "POST", config.adminApiKey, { name: "Worker" });
    assert.equal(keyResponse.status, 201);
    const key = await keyResponse.json();
    assert.equal((await request("/v1/me", "GET", key.secret)).status, 200);
    assert.equal((await request(`/v1/admin/users/${second.user.id}/keys/${key.id}`, "DELETE", config.adminApiKey)).status, 404);
    const path = `/v1/admin/users/${first.user.id}/keys/${key.id}`;
    assert.equal((await request(path, "DELETE", config.adminApiKey)).status, 204);
    const [revoked] = await db.select().from(userApiKeys).where(eq(userApiKeys.id, key.id));
    assert.equal((await request(path, "DELETE", config.adminApiKey)).status, 204);
    const [again] = await db.select().from(userApiKeys).where(eq(userApiKeys.id, key.id));
    assert.deepEqual(again!.revokedAt, revoked!.revokedAt);
    assert.equal((await request("/v1/me", "GET", key.secret)).status, 401);
    assert.equal((await request("/v1/me", "GET", first.key.secret)).status, 200);
  });

  it("rotates the encrypted webhook secret without changing the API key or other users", async () => {
    const response = await request("/v1/me/webhook-secret/rotate", "POST", first.key.secret);
    assert.equal(response.status, 200);
    const { webhookSecret } = await response.json();
    assert.notEqual(webhookSecret, first.webhookSecret);
    const [stored] = await db.select().from(users).where(eq(users.id, first.user.id));
    assert.equal(decryptSecret(stored!.webhookSecretEncrypted, config.encryptionKey, `user:${first.user.id}:webhook`), webhookSecret);
    const [other] = await db.select().from(users).where(eq(users.id, second.user.id));
    assert.equal(decryptSecret(other!.webhookSecretEncrypted, config.encryptionKey, `user:${second.user.id}:webhook`), second.webhookSecret);
    assert.equal((await request("/v1/me", "GET", first.key.secret)).status, 200);
  });

  it("paginates users without skipping microsecond timestamps or equal-time rows", async () => {
    const third = await register("Third");
    await db.update(users).set({ createdAt: sql`'2026-01-01T00:00:00.123456Z'::timestamptz` }).where(inArray(users.id, [first.user.id, second.user.id]));
    await db.update(users).set({ createdAt: sql`'2026-01-01T00:00:00.123457Z'::timestamptz` }).where(eq(users.id, third.user.id));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(`/v1/admin/users?limit=1${cursor ? `&cursor=${cursor}` : ""}`, "GET", config.adminApiKey);
      assert.equal(response.status, 200);
      const body = await response.json();
      seen.push(...body.data.map((user: { id: string }) => user.id));
      cursor = body.nextCursor;
      assert.ok(seen.length <= 3);
    } while (cursor);
    assert.equal(seen[0], third.user.id);
    assert.deepEqual(new Set(seen), new Set(createdIds));
  });

  it("paginates key metadata within one user, including revoked keys", async () => {
    const extra = await (await request(`/v1/admin/users/${first.user.id}/keys`, "POST", config.adminApiKey, {})).json();
    await request(`/v1/admin/users/${first.user.id}/keys/${extra.id}`, "DELETE", config.adminApiKey);
    const a = await (await request(`/v1/admin/users/${first.user.id}/keys?limit=1`, "GET", config.adminApiKey)).json();
    const b = await (await request(`/v1/admin/users/${first.user.id}/keys?limit=1&cursor=${a.nextCursor}`, "GET", config.adminApiKey)).json();
    assert.deepEqual(new Set([a.data[0].id, b.data[0].id]), new Set([extra.id, first.key.id]));
    assert.equal(b.nextCursor, null);
  });

  it("rejects malformed JSON, unexpected fields, invalid URLs, IDs, and pagination", async () => {
    for (const body of [null, [], {}, { name: "", callbackUrl: "https://example.com" },
      { name: "Test", callbackUrl: "not a url" }, { name: "Test", callbackUrl: "http://example.com" },
      { name: "Test", callbackUrl: "https://user:password@example.com" },
      { name: "Test", callbackUrl: "https://example.com/#fragment" },
      { name: "Test", callbackUrl: "https://example.com", enabled: true },
    ]) assert.equal((await request("/v1/admin/users", "POST", config.adminApiKey, body)).status, 400);
    assert.equal((await app.request("/v1/admin/users", { method: "POST", headers: { authorization: `Bearer ${config.adminApiKey}`, "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await request("/v1/admin/users", "POST", config.adminApiKey)).status, 415);
    for (const suffix of ["/not-a-uuid", "?limit=0", "?limit=101", "?cursor=bad", "?unexpected=1"])
      assert.equal((await request(`/v1/admin/users${suffix}`, "GET", config.adminApiKey)).status, 400);
    assert.equal((await request("/v1/admin/users", "POST", config.adminApiKey, { name: "x".repeat(17000), callbackUrl: "https://example.com" })).status, 413);
  });

  it("returns 404 for absent users and keys while keeping implemented routes available", async () => {
    const missing = randomUUID();
    for (const [method, path, body] of [
      ["GET", `/v1/admin/users/${missing}`, undefined],
      ["PATCH", `/v1/admin/users/${missing}`, { name: "Unknown" }],
      ["POST", `/v1/admin/users/${missing}/keys`, {}],
      ["GET", `/v1/admin/users/${missing}/keys`, undefined],
      ["DELETE", `/v1/admin/users/${first.user.id}/keys/${missing}`, undefined],
    ] as const) assert.equal((await request(path, method, config.adminApiKey, body)).status, 404);
    assert.equal((await request("/v1/jobs", "GET", first.key.secret)).status, 200);
    assert.equal((await request("/")).status, 200);
  });
});
