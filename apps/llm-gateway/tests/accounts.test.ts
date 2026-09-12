import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { jobs, providerAccounts, userApiKeys, users } from "../src/db/schema.js";
import { decryptSecret } from "../src/crypto.js";
import { createUser } from "../src/users/service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
const { db, pool } = createDatabase(url);
const config = { adminApiKey: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32) };
const app = createApp(db, config);
type User = Awaited<ReturnType<typeof createUser>>;
let first: User;
let second: User;
const userIds: string[] = [];
const openAiInput = { name: "OpenAI", provider: "openai", config: { project: "project-1" }, secrets: { apiKey: "test-openai-key" } };

function request(path: string, method = "GET", body?: unknown, token = first.key.secret) {
  return app.request(path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function create(input: unknown = openAiInput, token = first.key.secret) {
  const response = await request("/v1/accounts", "POST", input, token);
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<{ id: string; userId: string; provider: string; name: string; config: Record<string, unknown>; configVersion: number; enabled: boolean }>;
}

async function stored(id: string) {
  const [row] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, id));
  assert.ok(row);
  return row;
}

function secrets(row: typeof providerAccounts.$inferSelect) {
  return JSON.parse(decryptSecret(row.secretsEncrypted, config.encryptionKey, `user:${row.userId}:account:${row.id}:${row.provider}:secrets`));
}

before(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }); });
after(async () => { await pool.end(); });

describe("account API", () => {
  beforeEach(async () => {
    first = await createUser(db, config.encryptionKey, { name: "First", callbackUrl: "https://example.com/callback" });
    userIds.push(first.user.id);
    second = await createUser(db, config.encryptionKey, { name: "Second", callbackUrl: "https://example.com/callback" });
    userIds.push(second.user.id);
  });
  afterEach(async () => {
    if (userIds.length) {
      await db.delete(jobs).where(inArray(jobs.userId, userIds));
      await db.delete(providerAccounts).where(inArray(providerAccounts.userId, userIds));
      await db.delete(userApiKeys).where(inArray(userApiKeys.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
      userIds.length = 0;
    }
  });

  it("creates all three providers and multiple accounts per provider without network calls", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No provider calls expected"); });
    const openai = await create();
    const chatgpt = await create({ name: "ChatGPT", provider: "chatgpt", config: { accountId: "provider-account" }, secrets: { accessToken: "test-access-token" } });
    const fireworks = await create({ name: "Fireworks", provider: "fireworks", secrets: { apiKey: "test-fireworks-key" } });
    const another = await create();
    assert.notEqual(openai.id, another.id);
    assert.notEqual(chatgpt.id, chatgpt.config.accountId);
    assert.equal(chatgpt.config.accountId, "provider-account");
    assert.deepEqual(fireworks.config, {});
    for (const account of [openai, chatgpt, fireworks, another]) {
      assert.equal(account.userId, first.user.id);
      assert.equal(account.configVersion, 1);
      assert.equal(account.enabled, true);
      assert.ok(!(await stored(account.id)).secretsEncrypted.includes(Buffer.from("test-")));
    }
    assert.deepEqual(secrets(await stored(openai.id)), openAiInput.secrets);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("requires active user credentials on every account endpoint", async () => {
    const id = (await create()).id;
    for (const [method, path] of [["GET", "/v1/accounts"], ["POST", "/v1/accounts"], ["GET", `/v1/accounts/${id}`], ["PATCH", `/v1/accounts/${id}`], ["DELETE", `/v1/accounts/${id}`]]) {
      assert.equal((await request(path!, method!, undefined, config.adminApiKey)).status, 401);
      assert.equal((await app.request(path!, { method: method! })).status, 401);
    }
    await db.update(users).set({ enabled: false }).where(eq(users.id, first.user.id));
    assert.equal((await request("/v1/accounts")).status, 401);
    await db.update(users).set({ enabled: true }).where(eq(users.id, first.user.id));
    await db.update(userApiKeys).set({ revokedAt: new Date() }).where(eq(userApiKeys.id, first.key.id));
    assert.equal((await request("/v1/accounts")).status, 401);
  });

  it("isolates list, get, update, and deletion by owner", async () => {
    const own = await create();
    const foreign = await create(openAiInput, second.key.secret);
    const list = await (await request("/v1/accounts")).json();
    assert.deepEqual(list.data.map((item: { id: string }) => item.id), [own.id]);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      assert.equal((await request(`/v1/accounts/${foreign.id}`, method, method === "PATCH" ? { name: "Stolen" } : undefined)).status, 404);
    }
    assert.equal((await stored(foreign.id)).name, openAiInput.name);
    assert.equal((await stored(foreign.id)).deletedAt, null);
  });

  it("never returns secrets or ciphertext on create, read, list, or update", async () => {
    const creation = await request("/v1/accounts", "POST", openAiInput);
    const account = await creation.clone().json();
    const responses = [creation, await request(`/v1/accounts/${account.id}`), await request("/v1/accounts"),
      await request(`/v1/accounts/${account.id}`, "PATCH", { secrets: { apiKey: "replacement-secret" } })];
    for (const response of responses) {
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const text = await response.text();
      for (const value of ["test-openai-key", "replacement-secret", "secretsEncrypted", '"secrets"', "cursorTime"])
        assert.ok(!text.includes(value));
    }
  });

  it("merges config and secrets, preserving omitted settings and incrementing versions only for changes", async () => {
    const account = await create({ ...openAiInput, config: { project: "project-1", organization: "org-1" } });
    const path = `/v1/accounts/${account.id}`;
    const original = await stored(account.id);
    const configured = await (await request(path, "PATCH", { config: { timeoutMs: 120000 } })).json();
    assert.deepEqual(configured.config, { project: "project-1", organization: "org-1", timeoutMs: 120000 });
    assert.equal(configured.configVersion, 2);
    assert.deepEqual((await stored(account.id)).secretsEncrypted, original.secretsEncrypted);
    const rotated = await (await request(path, "PATCH", { secrets: { apiKey: "rotated-key" } })).json();
    assert.equal(rotated.configVersion, 3);
    assert.deepEqual(secrets(await stored(account.id)), { apiKey: "rotated-key" });
    const repeated = await (await request(path, "PATCH", { config: { timeoutMs: 120000 }, secrets: { apiKey: "rotated-key" } })).json();
    assert.equal(repeated.configVersion, 3);
    const renamed = await (await request(path, "PATCH", { name: "Renamed", enabled: false })).json();
    assert.equal(renamed.configVersion, 3);
    assert.equal(renamed.enabled, false);
    assert.equal((await request(path)).status, 200);
    assert.equal((await request("/v1/accounts")).status, 200);
    const enabled = await (await request(path, "PATCH", { enabled: true })).json();
    assert.equal(enabled.enabled, true);
  });

  it("merges concurrent config and credential updates without losing either change", async () => {
    const account = await create();
    const results = await Promise.all([
      request(`/v1/accounts/${account.id}`, "PATCH", { config: { timeoutMs: 5000 } }),
      request(`/v1/accounts/${account.id}`, "PATCH", { secrets: { apiKey: "concurrent-key" } }),
    ]);
    for (const result of results) assert.equal(result.status, 200);
    const row = await stored(account.id);
    assert.deepEqual(row.config, { project: "project-1", timeoutMs: 5000 });
    assert.deepEqual(secrets(row), { apiKey: "concurrent-key" });
    assert.equal(row.configVersion, 3);
  });

  it("preserves required ChatGPT fields when patching config or credentials", async () => {
    const account = await create({ name: "ChatGPT", provider: "chatgpt", config: { accountId: "provider-id", timeoutMs: 3000 }, secrets: { accessToken: "token-1" } });
    const path = `/v1/accounts/${account.id}`;
    assert.equal((await request(path, "PATCH", { config: { baseUrl: "https://chatgpt.com/backend-api/codex" }, secrets: { accessToken: "token-2" } })).status, 200);
    const row = await stored(account.id);
    assert.equal(row.config.accountId, "provider-id");
    assert.equal(row.config.timeoutMs, 3000);
    assert.deepEqual(secrets(row), { accessToken: "token-2" });
  });

  it("rejects forbidden and invalid patches without modifying the stored account", async () => {
    const account = await create();
    const original = await stored(account.id);
    for (const patch of [
      {}, { config: {} }, { secrets: {} }, { provider: "fireworks" }, { userId: second.user.id },
      { id: randomUUID() }, { configVersion: 900 }, { deletedAt: new Date().toISOString() },
      { config: { apiKey: "plaintext" } }, { config: { headers: { Authorization: "secret" } } },
      { secrets: { accessToken: "wrong-provider" } }, { secrets: { apiKey: "" } },
      { config: { timeoutMs: 0 } }, { config: { baseUrl: "not a url" } },
      { config: null }, { config: { project: null } }, { secrets: { apiKey: null } },
    ]) assert.equal((await request(`/v1/accounts/${account.id}`, "PATCH", patch)).status, 400);
    assert.deepEqual(await stored(account.id), original);
  });

  it("validates client settings and rejects unknown fields without leaking credentials", async () => {
    for (const input of [
      { ...openAiInput, provider: "unknown" }, { ...openAiInput, name: " " },
      { ...openAiInput, userId: second.user.id }, { ...openAiInput, config: { timeoutMs: "1000" } },
      { ...openAiInput, config: { timeoutMs: 1.5 } }, { ...openAiInput, config: { timeoutMs: 2147483648 } },
      { ...openAiInput, config: { baseUrl: "http://example.com" } },
      { ...openAiInput, config: { baseUrl: "https://user:pass@example.com" } },
      { ...openAiInput, config: { baseUrl: "https://example.com?query=1" } },
      { ...openAiInput, config: { baseUrl: "https://example.com#fragment" } },
      { ...openAiInput, config: { organization: "bad\r\nheader" } },
      { ...openAiInput, secrets: { apiKey: "private-secret\r\nvalue" } },
      { ...openAiInput, secrets: { apiKey: " " } }, { ...openAiInput, secrets: {} },
      { ...openAiInput, config: { fetch: "not allowed" } },
      { name: "ChatGPT", provider: "chatgpt", secrets: { accessToken: "token" } },
      { name: "ChatGPT", provider: "chatgpt", config: { accountId: " " }, secrets: { accessToken: "token" } },
      { name: "Fireworks", provider: "fireworks", config: { project: "wrong-provider" }, secrets: { apiKey: "key" } },
    ]) {
      const response = await request("/v1/accounts", "POST", input);
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes("private-secret"));
    }
    assert.equal((await db.select().from(providerAccounts).where(eq(providerAccounts.userId, first.user.id))).length, 0);
  });

  it("accepts the provider clients' loopback development URL and disabled creation", async () => {
    const account = await create({ ...openAiInput, config: { baseUrl: "http://localhost:9876/v1" }, enabled: false });
    assert.equal(account.enabled, false);
    assert.equal(account.config.baseUrl, "http://localhost:9876/v1");
  });

  it("soft-deletes idempotently, preserves job history, and cannot be restored via PATCH", async () => {
    const account = await create();
    await db.insert(jobs).values({ userId: first.user.id, accountId: account.id, modelId: "test", idempotencyKey: "history", requestHash: "hash" });
    const path = `/v1/accounts/${account.id}`;
    const original = await stored(account.id);
    assert.equal((await request(path, "DELETE")).status, 204);
    const deleted = await stored(account.id);
    assert.ok(deleted.deletedAt instanceof Date);
    assert.equal(deleted.enabled, false);
    assert.deepEqual(deleted.secretsEncrypted, original.secretsEncrypted);
    assert.equal((await request(path, "DELETE")).status, 204);
    assert.deepEqual(await stored(account.id), deleted);
    assert.equal((await request(path)).status, 404);
    assert.equal((await request(path, "PATCH", { enabled: true })).status, 404);
    assert.equal((await (await request("/v1/accounts")).json()).data.length, 0);
    assert.equal((await db.select().from(jobs).where(eq(jobs.accountId, account.id))).length, 1);
  });

  it("paginates and filters live owned accounts without losing timestamp precision", async () => {
    const firstAccount = await create();
    const secondAccount = await create();
    const otherProvider = await create({ name: "Fireworks", provider: "fireworks", secrets: { apiKey: "key" } });
    const deleted = await create();
    await create(openAiInput, second.key.secret);
    await request(`/v1/accounts/${deleted.id}`, "DELETE");
    await db.update(providerAccounts).set({ createdAt: sql`'2026-01-01T00:00:00.123456Z'::timestamptz` }).where(inArray(providerAccounts.id, [firstAccount.id, secondAccount.id]));
    const a = await (await request("/v1/accounts?provider=openai&limit=1")).json();
    const b = await (await request(`/v1/accounts?provider=openai&limit=1&cursor=${a.nextCursor}`)).json();
    assert.deepEqual(new Set([a.data[0].id, b.data[0].id]), new Set([firstAccount.id, secondAccount.id]));
    assert.equal(b.nextCursor, null);
    assert.equal((await (await request("/v1/accounts?provider=fireworks")).json()).data[0].id, otherProvider.id);
    assert.equal((await (await request("/v1/accounts")).json()).data.length, 3);
  });

  it("validates JSON, IDs, query parameters, and management body limits", async () => {
    assert.equal((await request("/v1/accounts", "POST")).status, 415);
    assert.equal((await app.request("/v1/accounts", { method: "POST", headers: { authorization: `Bearer ${first.key.secret}`, "content-type": "application/json" }, body: "{" })).status, 400);
    for (const body of [null, [], {}]) assert.equal((await request("/v1/accounts", "POST", body)).status, 400);
    for (const query of ["?provider=unknown", "?limit=0", "?limit=101", "?cursor=bad", "?unknown=1"])
      assert.equal((await request(`/v1/accounts${query}`)).status, 400);
    assert.equal((await request("/v1/accounts/not-a-uuid")).status, 400);
    assert.equal((await request(`/v1/accounts/${randomUUID()}`)).status, 404);
    assert.equal((await request("/v1/accounts", "POST", { ...openAiInput, name: "x".repeat(17000) })).status, 413);
    const account = await create();
    assert.equal((await request(`/v1/accounts/${account.id}/models`)).status, 200);
  });

  it("binds ciphertext to user, account, provider, and purpose", async () => {
    const account = await create();
    const row = await stored(account.id);
    for (const context of [
      `user:${second.user.id}:account:${account.id}:openai:secrets`,
      `user:${first.user.id}:account:${randomUUID()}:openai:secrets`,
      `user:${first.user.id}:account:${account.id}:fireworks:secrets`,
      `user:${first.user.id}:webhook`,
    ]) assert.throws(() => decryptSecret(row.secretsEncrypted, config.encryptionKey, context));
  });
});
