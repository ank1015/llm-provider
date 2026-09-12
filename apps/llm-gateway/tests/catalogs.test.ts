import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { providerAccounts, userApiKeys, users } from "../src/db/schema.js";
import { createUser } from "../src/users/service.js";
import { createAccount, deleteAccount, updateAccount } from "../src/accounts/service.js";
import { getModels, PROVIDERS } from "../src/catalogs/service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
const { db, pool } = createDatabase(url);
const config = { adminApiKey: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32) };
const app = createApp(db, config);
type User = Awaited<ReturnType<typeof createUser>>;
let first: User;
let second: User;
const userIds: string[] = [];

function request(path: string, token = first.key.secret) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}
function account(provider: "openai" | "chatgpt" | "fireworks", userId = first.user.id) {
  return createAccount(db, config.encryptionKey, userId, { name: provider, provider, enabled: true,
    config: provider === "chatgpt" ? { accountId: "test-provider-account" } : {},
    secrets: provider === "chatgpt" ? { accessToken: "unused-test-token" } : { apiKey: "unused-test-key" },
  });
}
before(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }); });
after(async () => { await pool.end(); });
describe("catalog API", () => {
  beforeEach(async () => {
    first = await createUser(db, config.encryptionKey, { name: "First", callbackUrl: "https://example.com/events" }); userIds.push(first.user.id);
    second = await createUser(db, config.encryptionKey, { name: "Second", callbackUrl: "https://example.com/events" }); userIds.push(second.user.id);
  });
  afterEach(async () => {
    if (!userIds.length) return;
    await db.delete(providerAccounts).where(inArray(providerAccounts.userId, userIds));
    await db.delete(userApiKeys).where(inArray(userApiKeys.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds)); userIds.length = 0;
  });

  it("returns all providers and exact model shapes without requiring accounts", async () => {
    assert.deepEqual(await (await request("/v1/providers")).json(), { data: PROVIDERS });
    assert.deepEqual(await (await request("/v1/models")).json(), { data: getModels() });
    for (const { id } of PROVIDERS) {
      assert.deepEqual(await (await request(`/v1/models?provider=${id}`)).json(), { data: getModels(id) });
    }
  });

  it("requires active user credentials on every catalog endpoint", async () => {
    const own = await account("openai");
    const paths = ["/v1/providers", "/v1/models", `/v1/accounts/${own.id}/models`];
    for (const path of paths) {
      assert.equal((await app.request(path)).status, 401);
      assert.equal((await request(path, config.adminApiKey)).status, 401);
      assert.equal((await request(path, "invalid")).status, 401);
    }
    await db.update(users).set({ enabled: false }).where(eq(users.id, first.user.id));
    for (const path of paths) assert.equal((await request(path)).status, 401);
    await db.update(users).set({ enabled: true }).where(eq(users.id, first.user.id));
    await db.update(userApiKeys).set({ revokedAt: new Date() }).where(eq(userApiKeys.id, first.key.id));
    for (const path of paths) assert.equal((await request(path)).status, 401);
  });

  it("resolves each owned account's provider without contacting upstream services", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No upstream calls expected"); });
    for (const { id } of PROVIDERS) {
      const own = await account(id);
      const response = await request(`/v1/accounts/${own.id}/models`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: getModels(id) });
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("hides missing, foreign, and deleted accounts, while allowing disabled accounts", async () => {
    const own = await account("openai");
    const foreign = await account("chatgpt", second.user.id);
    assert.equal((await request(`/v1/accounts/${foreign.id}/models`)).status, 404);
    assert.equal((await request(`/v1/accounts/${randomUUID()}/models`)).status, 404);
    await updateAccount(db, config.encryptionKey, first.user.id, own.id, { enabled: false });
    assert.equal((await request(`/v1/accounts/${own.id}/models`)).status, 200);
    await deleteAccount(db, first.user.id, own.id);
    assert.equal((await request(`/v1/accounts/${own.id}/models`)).status, 404);
  });

  it("rejects invalid filters, unknown fields, and malformed account IDs", async () => {
    const own = await account("openai");
    for (const path of ["/v1/providers?provider=openai", "/v1/models?provider=other", "/v1/models?provider=", "/v1/models?limit=1",
      "/v1/accounts/not-a-uuid/models", `/v1/accounts/${own.id}/models?provider=fireworks`]) {
      assert.equal((await request(path)).status, 400);
    }
  });

  it("never exposes account secrets and authenticates account catalog reads only once", async (t) => {
    const own = await account("openai");
    const select = t.mock.method(db, "select");
    const response = await request(`/v1/accounts/${own.id}/models`);
    assert.equal(select.mock.callCount(), 2); // One authentication lookup, one owned account lookup.
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    for (const value of ["unused-test-key", "secretsEncrypted", "configVersion", first.key.secret]) assert.ok(!body.includes(value));
    for (const path of ["/v1/providers", "/v1/models"]) assert.equal((await request(path)).headers.get("cache-control"), "no-store");
  });
});
