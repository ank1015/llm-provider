import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { jobs, jobAttempts, jobRequests, providerAccounts, userApiKeys, users } from "../src/db/schema.js";
import { createAccount, deleteAccount } from "../src/accounts/service.js";
import { createUser } from "../src/users/service.js";
import type { getUsage } from "../src/usage/service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
const { db, pool } = createDatabase(url);
const config = { adminApiKey: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32) };
const app = createApp(db, config);
type User = Awaited<ReturnType<typeof createUser>>;
type Account = Awaited<ReturnType<typeof createAccount>>;
let first: User;
let second: User;
let openai: Account;
let chatgpt: Account;
let fireworks: Account;
let foreign: Account;
const userIds: string[] = [];
const day1 = new Date("2026-01-01T23:59:59Z");
const day2 = new Date("2026-01-02T00:00:00Z");
const day3 = new Date("2026-01-03T00:00:00Z");
type Report = Awaited<ReturnType<typeof getUsage>>;

function request(query = "", token = first.key.secret) {
  return app.request(`/v1/usage${query ? `?${query}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
}
async function report(query = "", token = first.key.secret): Promise<Report> {
  const response = await request(query, token);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function job(account = openai, patch: Partial<typeof jobs.$inferInsert> = {}) {
  const status = patch.status ?? "queued";
  const [row] = await db.insert(jobs).values({
    userId: account.userId, accountId: account.id, idempotencyKey: randomUUID(), requestHash: "fixture", modelId: "shared-model",
    createdAt: day1, ...patch, status,
    finishedAt: ["succeeded", "failed", "cancelled"].includes(status) ? day3 : null,
    response: status === "succeeded" ? { id: "not-for-usage", modelId: "shared-model", stopReason: "stop", timestamp: day3.getTime(), durationMs: 5,
      message: { role: "assistant", provider: account.provider, content: ["not-for-usage"] }, usage: { input: 999_999 } } : null,
    error: status === "failed" ? { message: "not-for-usage" } : null,
  }).returning();
  return row!;
}
async function attempt(jobId: string, patch: Partial<typeof jobAttempts.$inferInsert> = {}) {
  const status = patch.status ?? "succeeded";
  const [row] = await db.insert(jobAttempts).values({ jobId, attemptNumber: 1, accountConfigVersion: 1, startedAt: day2,
    ...patch, status, finishedAt: status === "running" ? null : day3,
  }).returning();
  return row!;
}

before(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }); });
after(async () => { await pool.end(); });
describe("usage API", () => {
  beforeEach(async () => {
    first = await createUser(db, config.encryptionKey, { name: "First", callbackUrl: "https://example.com/events" }); userIds.push(first.user.id);
    second = await createUser(db, config.encryptionKey, { name: "Second", callbackUrl: "https://example.com/events" }); userIds.push(second.user.id);
    const account = (provider: "openai" | "chatgpt" | "fireworks", userId = first.user.id) => createAccount(db, config.encryptionKey, userId, {
      name: provider, provider, enabled: true, config: provider === "chatgpt" ? { accountId: "test" } : {},
      secrets: provider === "chatgpt" ? { accessToken: "secret-token" } : { apiKey: "secret-key" },
    });
    openai = await account("openai"); chatgpt = await account("chatgpt"); fireworks = await account("fireworks"); foreign = await account("openai", second.user.id);
  });
  afterEach(async () => {
    if (!userIds.length) return;
    const owned = db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.userId, userIds));
    await db.delete(jobAttempts).where(inArray(jobAttempts.jobId, owned));
    await db.delete(jobRequests).where(inArray(jobRequests.jobId, owned));
    await db.delete(jobs).where(inArray(jobs.userId, userIds));
    await db.delete(providerAccounts).where(inArray(providerAccounts.userId, userIds));
    await db.delete(userApiKeys).where(inArray(userApiKeys.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds)); userIds.length = 0;
  });

  it("returns zero counts and explicit lack of observations for an empty report", async () => {
    const value = await report();
    assert.equal(value.groupBy, null); assert.deepEqual(value.period, { from: null, to: null, timeZone: "UTC" });
    assert.equal(value.summary.jobs.total, "0"); assert.equal(value.summary.attempts.total, "0");
    for (const bucket of [...Object.values(value.summary.tokens), ...Object.values(value.summary.costUsd)]) {
      assert.deepEqual(bucket, { knownTotal: null, knownAttempts: "0", missingAttempts: "0" });
    }
    assert.deepEqual(value.data, []); assert.equal(value.nextCursor, null);
    assert.deepEqual((await report("groupBy=account")).data, []);
  });

  it("authenticates and isolates all filters and aggregates by user", async () => {
    await attempt((await job()).id, { inputTokens: 10n });
    await attempt((await job(foreign)).id, { inputTokens: 900n });
    assert.equal((await app.request("/v1/usage")).status, 401);
    assert.equal((await request("", config.adminApiKey)).status, 401);
    assert.equal((await report()).summary.tokens.input.knownTotal, "10");
    assert.equal((await report("", second.key.secret)).summary.tokens.input.knownTotal, "900");
    assert.equal((await report(`accountId=${foreign.id}`)).summary.jobs.total, "0");
    assert.equal((await report(`accountId=${randomUUID()}`)).summary.jobs.total, "0");
    assert.equal((await request(`userId=${second.user.id}`)).status, 400);
    await db.update(users).set({ enabled: false }).where(eq(users.id, first.user.id));
    assert.equal((await request()).status, 401);
    await db.update(users).set({ enabled: true }).where(eq(users.id, first.user.id));
    await db.update(userApiKeys).set({ revokedAt: new Date() }).where(eq(userApiKeys.id, first.key.id));
    assert.equal((await request()).status, 401);
  });

  it("counts jobs once while summing every observed retry, even on failed/cancelled jobs", async () => {
    const success = await job(openai, { status: "succeeded" });
    await attempt(success.id, { status: "failed", inputTokens: 3n, inputCostUsd: "0.1", totalCostUsd: "0.1" });
    await attempt(success.id, { attemptNumber: 2, inputTokens: 7n, outputTokens: 2n, totalCostUsd: "0.2" });
    const cancelled = await job(openai, { status: "cancelled" });
    await attempt(cancelled.id, { status: "succeeded", inputTokens: 5n, totalCostUsd: "0.3" });
    await job(openai, { status: "queued" });
    const value = (await report()).summary;
    assert.equal(value.jobs.total, "3"); assert.equal(value.jobs.succeeded, "1"); assert.equal(value.jobs.cancelled, "1"); assert.equal(value.jobs.queued, "1");
    assert.equal(value.attempts.total, "3"); assert.equal(value.attempts.failed, "1"); assert.equal(value.attempts.succeeded, "2");
    assert.deepEqual(value.tokens.input, { knownTotal: "15", knownAttempts: "3", missingAttempts: "0" });
    assert.equal(value.costUsd.total.knownTotal, "0.600000000000");
    assert.equal(value.tokens.output.missingAttempts, "2");
  });

  it("tracks coverage separately for every token and cost bucket without inventing totals", async () => {
    const item = await job(openai, { status: "running" });
    await attempt(item.id, { inputTokens: 0n, outputTokens: 10n, cacheReadTokens: 20n,
      inputCostUsd: "0", outputCostUsd: "0.5", totalCostUsd: "0.5" });
    await attempt(item.id, { attemptNumber: 2, status: "unknown", cacheWriteTokens: 1n, cacheWriteCostUsd: "0.125" });
    await attempt(item.id, { attemptNumber: 3, status: "running" });
    const value = (await report()).summary;
    assert.equal(value.attempts.unknown, "1"); assert.equal(value.attempts.running, "1");
    assert.deepEqual(value.tokens.input, { knownTotal: "0", knownAttempts: "1", missingAttempts: "2" });
    assert.deepEqual(value.tokens.cacheWrite, { knownTotal: "1", knownAttempts: "1", missingAttempts: "2" });
    assert.deepEqual(value.costUsd.cacheRead, { knownTotal: null, knownAttempts: "0", missingAttempts: "3" });
    assert.deepEqual(value.costUsd.input, { knownTotal: "0.000000000000", knownAttempts: "1", missingAttempts: "2" });
    assert.equal(value.costUsd.total.knownTotal, "0.500000000000");
  });

  it("preserves bigint and decimal precision beyond JavaScript safe integers", async () => {
    const item = await job();
    await attempt(item.id, { inputTokens: 9_223_372_036_854_775_807n, totalCostUsd: "9007199254740993.123456789012" });
    await attempt(item.id, { attemptNumber: 2, inputTokens: 9_223_372_036_854_775_807n, totalCostUsd: "0.000000000001" });
    const value = (await report()).summary;
    assert.equal(value.tokens.input.knownTotal, "18446744073709551614");
    assert.equal(value.costUsd.total.knownTotal, "9007199254740993.123456789013");
  });

  it("filters job creation and attempt starts independently using [from, to)", async () => {
    const item = await job(openai, { createdAt: day1 });
    await attempt(item.id, { startedAt: day1, inputTokens: 1n });
    await attempt(item.id, { attemptNumber: 2, startedAt: day2, inputTokens: 2n });
    await attempt(item.id, { attemptNumber: 3, startedAt: day3, inputTokens: 4n });
    const query = `from=${day2.toISOString()}&to=${day3.toISOString()}`;
    const value = (await report(query)).summary;
    assert.equal(value.jobs.total, "0"); assert.equal(value.attempts.total, "1"); assert.equal(value.tokens.input.knownTotal, "2");
    const justJobs = (await report(`to=${day2.toISOString()}`)).summary;
    assert.equal(justJobs.jobs.total, "1"); assert.equal(justJobs.tokens.input.knownTotal, "1");
    assert.equal((await report(`from=${day3.toISOString()}`)).summary.tokens.input.knownTotal, "4");
    assert.equal((await report(`from=${day2.toISOString()}&to=${day2.toISOString()}`)).summary.attempts.total, "0");
  });

  it("uses UTC days even with a non-UTC PostgreSQL timezone", async () => {
    const item = await job();
    await attempt(item.id, { startedAt: day2, inputTokens: 11n });
    await attempt(item.id, { attemptNumber: 2, startedAt: day3, inputTokens: 13n });
    const value = await report("groupBy=day");
    assert.deepEqual(value.data.map(x => x.group), [{ day: "2026-01-01" }, { day: "2026-01-02" }, { day: "2026-01-03" }]);
    assert.deepEqual(value.data.map(x => x.jobs.total), ["1", "0", "0"]);
    assert.deepEqual(value.data.map(x => x.tokens.input.knownTotal), [null, "11", "13"]);
    assert.equal(value.summary.jobs.total, "1"); assert.equal(value.summary.attempts.total, "2");
  });

  it("filters at microsecond boundaries without JavaScript timestamp truncation", async () => {
    const item = await job();
    const one = await attempt(item.id, { inputTokens: 1n });
    const two = await attempt(item.id, { attemptNumber: 2, inputTokens: 2n });
    await db.execute(sql`update job_attempts set started_at = '2026-01-02T00:00:00.000001Z'::timestamptz where id = ${one.id}::uuid`);
    await db.execute(sql`update job_attempts set started_at = '2026-01-02T00:00:00.000002Z'::timestamptz where id = ${two.id}::uuid`);
    const value = await report("from=2026-01-02T00:00:00.000001Z&to=2026-01-02T00:00:00.000002Z");
    assert.equal(value.summary.tokens.input.knownTotal, "1");
    assert.equal((await request("from=2026-01-02T00:00:00.000002Z&to=2026-01-02T00:00:00.000001Z")).status, 400);
  });

  it("groups accounts/providers/models and keeps identical model IDs under different providers separate", async () => {
    for (const [account, count] of [[openai, 1n], [chatgpt, 2n], [fireworks, 3n]] as const) await attempt((await job(account)).id, { inputTokens: count });
    const models = await report("groupBy=model");
    assert.deepEqual(models.data.map(x => x.group), [
      { provider: "chatgpt", modelId: "shared-model" }, { provider: "fireworks", modelId: "shared-model" }, { provider: "openai", modelId: "shared-model" },
    ]);
    const providers = await report("groupBy=provider");
    assert.deepEqual(providers.data.map(x => x.tokens.input.knownTotal), ["2", "3", "1"]);
    const accounts = await report("groupBy=account");
    assert.equal(accounts.data.length, 3);
    const filtered = await report(`groupBy=account&accountId=${openai.id}&provider=openai&modelId=shared-model`);
    assert.deepEqual(filtered.data[0]!.group, { accountId: openai.id, provider: "openai" });
    assert.equal(filtered.summary.tokens.input.knownTotal, "1");
    assert.equal((await report(`accountId=${openai.id}&provider=fireworks`)).summary.jobs.total, "0");
  });

  it("paginates complete groups without narrowing summary totals", async () => {
    for (const account of [openai, chatgpt, fireworks]) await attempt((await job(account)).id, { inputTokens: 1n });
    let cursor: string | null = null;
    const groups: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const value = await report(`groupBy=model&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(value.summary.jobs.total, "3"); assert.equal(value.summary.tokens.input.knownTotal, "3");
      assert.equal(value.data.length, 1); groups.push(value.data[0]!.group); cursor = value.nextCursor;
    }
    assert.equal(cursor, null); assert.equal(new Set(groups.map(x => JSON.stringify(x))).size, 3);
    const firstPage = await report("groupBy=model&limit=1");
    assert.equal((await request(`groupBy=day&cursor=${firstPage.nextCursor}`)).status, 400);
  });

  it("includes soft-deleted/disabled accounts and survives input cleanup", async () => {
    const item = await job(openai, { status: "cancelled" });
    await attempt(item.id, { inputTokens: 12n, totalCostUsd: "0.123" });
    await db.insert(jobRequests).values({ jobId: item.id, request: { messages: [] } });
    const before = await report(`accountId=${openai.id}`);
    await deleteAccount(db, first.user.id, openai.id);
    await db.delete(jobRequests).where(eq(jobRequests.jobId, item.id));
    assert.deepEqual(await report(`accountId=${openai.id}`), before);
  });

  it("reports current status counts without inferring usage from responses or exposing payloads", async () => {
    for (const status of ["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"] as const) await job(openai, { status });
    const response = await request(); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text(); const value = JSON.parse(body) as Report;
    assert.equal(value.summary.jobs.total, "6");
    for (const status of ["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"] as const) assert.equal(value.summary.jobs[status], "1");
    assert.equal(value.summary.attempts.total, "0"); assert.equal(value.summary.tokens.input.knownTotal, null);
    for (const secret of ["not-for-usage", "secret-key", "secret-token", "999999", "requestHash", "leaseToken", "secretsEncrypted", first.key.secret]) assert.ok(!body.includes(secret));
  });

  it("rejects malformed queries and parameterizes model filters", async () => {
    for (const query of ["groupBy=week", "limit=101", "from=nope", "accountId=bad", "cursor=abc", "groupBy=day&cursor=abc", "extra=1"]) assert.equal((await request(query)).status, 400);
    assert.equal((await report(`modelId=${encodeURIComponent("'; select * from users; --")}`)).summary.jobs.total, "0");
    assert.equal((await request()).status, 200);
  });
});
