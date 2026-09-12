import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { jobs, jobRequests, jobAttempts, providerAccounts, userApiKeys, users, webhookDeliveries as deliveries, webhookDeliveryAttempts as attempts } from "../src/db/schema.js";
import { createUser } from "../src/users/service.js";
import { createAccount } from "../src/accounts/service.js";
import { cancelJob, submitJob } from "../src/jobs/service.js";
import { claimDelivery, completeDelivery, runOnce, runWorker } from "../src/webhooks/worker.js";
import { createSender, signature } from "../src/webhooks/sender.js";

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
const signal = () => new AbortController().signal;
const transient = { httpStatus: 503, error: { code: "http_error", message: "Temporary failure", retryable: true } };

function request(path: string, method = "GET", token = first.key.secret) {
  return app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
}
async function event() {
  const job = await submitJob(db, first.user.id, { idempotencyKey: randomUUID(), previousJobId: null,
    accountId: account.id, modelId: "gpt-6-astra", messages: [], tools: [], providerOptions: {} });
  await cancelJob(db, first.user.id, job.id);
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.jobId, job.id));
  assert.ok(delivery); return delivery;
}
async function stored(id: string) {
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id));
  assert.ok(row); return row;
}
async function history(id: string) { return db.select().from(attempts).where(eq(attempts.deliveryId, id)).orderBy(attempts.attemptNumber); }
async function due(id: string) { await db.update(deliveries).set({ nextAttemptAt: new Date(0) }).where(eq(deliveries.id, id)); }
async function expired(id: string) { await db.update(deliveries).set({ leaseExpiresAt: new Date(0) }).where(eq(deliveries.id, id)); }
async function claim() { const item = await claimDelivery(db); assert.ok(item && !item.completed); return item; }

before(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) }); });
after(async () => { await pool.end(); });
describe("webhook API and worker", () => {
  beforeEach(async () => {
    first = await createUser(db, config.encryptionKey, { name: "First", callbackUrl: "https://example.com/callback" }); userIds.push(first.user.id);
    second = await createUser(db, config.encryptionKey, { name: "Second", callbackUrl: "https://example.com/second" }); userIds.push(second.user.id);
    account = await createAccount(db, config.encryptionKey, first.user.id, { name: "OpenAI", provider: "openai", config: {}, secrets: { apiKey: "unused-test-key" }, enabled: true });
  });
  afterEach(async () => {
    if (!userIds.length) return;
    const ownedDeliveries = db.select({ id: deliveries.id }).from(deliveries).where(inArray(deliveries.userId, userIds));
    const ownedJobs = db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.userId, userIds));
    await db.delete(attempts).where(inArray(attempts.deliveryId, ownedDeliveries));
    await db.delete(deliveries).where(inArray(deliveries.userId, userIds));
    await db.delete(jobAttempts).where(inArray(jobAttempts.jobId, ownedJobs));
    await db.delete(jobRequests).where(inArray(jobRequests.jobId, ownedJobs));
    await db.delete(jobs).where(inArray(jobs.userId, userIds));
    await db.delete(providerAccounts).where(inArray(providerAccounts.userId, userIds));
    await db.delete(userApiKeys).where(inArray(userApiKeys.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  });

  it("authenticates and scopes list, detail, and redelivery", async () => {
    const item = await event();
    for (const [method, path] of [["GET", "/v1/webhook-deliveries"], ["GET", `/v1/webhook-deliveries/${item.id}`], ["POST", `/v1/webhook-deliveries/${item.id}/redeliver`]]) {
      assert.equal((await app.request(path!, { method: method! })).status, 401);
      assert.equal((await request(path!, method!, config.adminApiKey)).status, 401);
    }
    for (const [method, suffix] of [["GET", ""], ["POST", "/redeliver"]]) assert.equal((await request(`/v1/webhook-deliveries/${item.id}${suffix}`, method!, second.key.secret)).status, 404);
    assert.deepEqual((await (await request("/v1/webhook-deliveries", "GET", second.key.secret)).json()).data, []);
    assert.equal((await request(`/v1/webhook-deliveries/${randomUUID()}`)).status, 404);
    assert.equal((await request("/v1/webhook-deliveries/not-a-uuid")).status, 400);
    await db.update(userApiKeys).set({ revokedAt: new Date() }).where(eq(userApiKeys.id, first.key.id));
    assert.equal((await request("/v1/webhook-deliveries")).status, 401);
  });

  it("lists metadata with full-precision cursors and job/status filters", async () => {
    const items = [await event(), await event(), await event()];
    for (let i = 0; i < items.length; i++) await db.execute(sql`update webhook_deliveries set created_at = ${`2026-01-01T00:00:00.00000${i + 1}Z`}::timestamptz where id = ${items[i]!.id}::uuid`);
    const one = await (await request("/v1/webhook-deliveries?limit=1&status=pending")).json();
    assert.equal(one.data[0].id, items[2]!.id);
    const two = await (await request(`/v1/webhook-deliveries?limit=1&cursor=${one.nextCursor}`)).json();
    assert.equal(two.data[0].id, items[1]!.id);
    const three = await (await request(`/v1/webhook-deliveries?limit=1&cursor=${two.nextCursor}`)).json();
    assert.equal(three.data[0].id, items[0]!.id); assert.equal(three.nextCursor, null);
    const filtered = await (await request(`/v1/webhook-deliveries?jobId=${items[0]!.jobId}`)).json();
    assert.equal(filtered.data.length, 1);
    for (const forbidden of ["payload", "leaseToken", "encryptedSecret", "cursorTime"]) assert.ok(!(forbidden in one.data[0]));
    assert.equal((await request("/v1/webhook-deliveries?status=invalid")).status, 400);
    assert.equal((await request("/v1/webhook-deliveries?limit=101")).status, 400);
    assert.equal((await request("/v1/webhook-deliveries?extra=1")).status, 400);
  });

  it("delivers signed events without changing jobs, payloads, or provider attempts", async () => {
    const item = await event();
    let calls = 0;
    await runOnce(db, createSender(config.encryptionKey, ["https://example.com"], async (url, init) => {
      calls++; assert.equal(url, item.callbackUrl);
      assert.deepEqual(JSON.parse(init?.body as string), item.payload);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-llm-gateway-signature"), signature(first.webhookSecret, item.id, headers.get("x-llm-gateway-timestamp")!, init?.body as string));
      return new Response(null, { status: 204 });
    }), signal());
    assert.equal(calls, 1);
    const row = await stored(item.id);
    assert.equal(row.status, "delivered"); assert.ok(row.deliveredAt); assert.equal(row.leaseToken, null);
    assert.deepEqual(row.payload, item.payload);
    assert.equal((await db.select().from(jobs).where(eq(jobs.id, item.jobId)))[0]!.status, "cancelled");
    assert.deepEqual(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, item.jobId)), []);
    const res = await request(`/v1/webhook-deliveries/${item.id}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.attempts.data[0].httpStatus, 204);
    assert.equal(body.attempts.nextCursor, null);
    for (const value of [first.webhookSecret, "webhookSecretEncrypted", "leaseToken", "unused-test-key"]) assert.ok(!JSON.stringify(body).includes(value));
  });

  it("honors Retry-After and terminal HTTP failures", async () => {
    const item = await event();
    await runOnce(db, async () => ({ ...transient, retryAfterMs: 90_000 }), signal());
    assert.equal((await stored(item.id)).status, "retry_wait");
    assert.ok((await stored(item.id)).nextAttemptAt.getTime() > Date.now() + 85_000);
    assert.equal(await claimDelivery(db), null);
    await due(item.id);
    await runOnce(db, async () => ({ httpStatus: 400, error: { code: "http_error", message: "Bad request", retryable: false } }), signal());
    assert.equal((await stored(item.id)).status, "failed");
    assert.equal((await history(item.id)).length, 2);
    assert.equal((await db.select().from(jobs).where(eq(jobs.id, item.jobId)))[0]!.status, "cancelled");
  });

  it("bounds cycles to eight attempts and 24 hours", async () => {
    const item = await event();
    for (let i = 0; i < 8; i++) { await due(item.id); await runOnce(db, async () => transient, signal()); }
    assert.equal((await stored(item.id)).status, "failed");
    assert.equal((await history(item.id)).length, 8);
    const old = await event();
    await db.update(deliveries).set({ retryStartedAt: new Date(0) }).where(eq(deliveries.id, old.id));
    await runOnce(db, async () => { assert.fail("Expired cycle must not send"); }, signal());
    assert.equal((await stored(old.id)).status, "failed"); assert.equal((await history(old.id)).length, 0);
    const longHint = await event();
    await runOnce(db, async () => ({ ...transient, retryAfterMs: 25 * 3_600_000 }), signal());
    assert.equal((await stored(longHint.id)).status, "failed");
  });

  it("manual redelivery resets the budget and keeps lifetime history and event identity", async () => {
    const item = await event();
    for (let i = 0; i < 8; i++) { await due(item.id); await runOnce(db, async () => transient, signal()); }
    const accepted = await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST");
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).retryFromAttempt, 9);
    await runOnce(db, async () => ({ httpStatus: 200 }), signal());
    const row = await stored(item.id); assert.equal(row.status, "delivered");
    assert.deepEqual(row.payload, item.payload); assert.equal(row.callbackUrl, item.callbackUrl);
    assert.equal((await history(item.id)).length, 9);
    const details = await (await request(`/v1/webhook-deliveries/${item.id}?attemptLimit=2`)).json();
    assert.deepEqual(details.attempts.data.map((x: { attemptNumber: number }) => x.attemptNumber), [9, 8]);
    const next = await (await request(`/v1/webhook-deliveries/${item.id}?attemptLimit=2&attemptCursor=${details.attempts.nextCursor}`)).json();
    assert.deepEqual(next.attempts.data.map((x: { attemptNumber: number }) => x.attemptNumber), [7, 6]);
    assert.equal((await request(`/v1/webhook-deliveries/${item.id}?attemptLimit=0`)).status, 400);
    await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST");
    assert.equal((await stored(item.id)).deliveredAt!.getTime(), row.deliveredAt!.getTime());
  });

  it("does not reset an active cycle and serializes simultaneous redelivery requests", async () => {
    const item = await event();
    assert.equal((await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST")).status, 409);
    const active = await claim();
    assert.equal((await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST")).status, 409);
    await completeDelivery(db, active, transient);
    assert.equal((await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST")).status, 409);
    await due(item.id); await runOnce(db, async () => ({ httpStatus: 200 }), signal());
    const results = await Promise.all([request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST"), request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST")]);
    assert.deepEqual(results.map(x => x.status).sort(), [202, 409]);
  });

  it("claims without duplication and fences stale workers after recovery", async () => {
    const one = await event(); const two = await event();
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(new Set(claims.map(x => x.delivery.id)), new Set([one.id, two.id]));
    assert.equal(await claimDelivery(db), null);
    const stale = claims[0]!;
    await expired(stale.delivery.id);
    await completeDelivery(db, stale, { httpStatus: 200 });
    assert.equal((await stored(stale.delivery.id)).status, "delivering");
    const replacement = await claim();
    assert.equal(replacement.delivery.id, stale.delivery.id);
    assert.equal((await history(stale.delivery.id))[0]!.error!.code, "lease_expired");
    await completeDelivery(db, replacement, { httpStatus: 204 });
    await completeDelivery(db, stale, transient);
    assert.equal((await stored(stale.delivery.id)).status, "delivered");
    assert.equal((await history(stale.delivery.id))[1]!.httpStatus, 204);
  });

  it("counts lost workers against the budget and permits explicit recovery", async () => {
    const item = await event();
    for (let i = 0; i < 8; i++) { await claim(); await expired(item.id); }
    assert.deepEqual(await claimDelivery(db), { completed: true });
    assert.equal((await stored(item.id)).status, "failed");
    assert.ok((await history(item.id)).every(x => x.finishedAt && x.error?.code === "lease_expired"));
    assert.equal((await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST")).status, 202);
    await runOnce(db, async () => ({ httpStatus: 200 }), signal());
    assert.equal((await stored(item.id)).status, "delivered");
  });

  it("uses current signing secrets but preserves the captured destination", async () => {
    const item = await event();
    await runOnce(db, async () => transient, signal());
    await db.update(users).set({ callbackUrl: "https://new.example.com/events" }).where(eq(users.id, first.user.id));
    const rotated = await (await request("/v1/me/webhook-secret/rotate", "POST")).json();
    await due(item.id);
    await runOnce(db, createSender(config.encryptionKey, ["https://example.com"], async (url, init) => {
      assert.equal(url, item.callbackUrl);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-llm-gateway-signature"), signature(rotated.webhookSecret, item.id, headers.get("x-llm-gateway-timestamp")!, init?.body as string));
      return new Response();
    }), signal());
    assert.equal((await stored(item.id)).status, "delivered");
  });

  it("pauses new claims for disabled users and resumes when re-enabled", async () => {
    const item = await event();
    await db.update(users).set({ enabled: false }).where(eq(users.id, first.user.id));
    assert.equal(await claimDelivery(db), null);
    assert.equal((await stored(item.id)).status, "pending");
    assert.equal((await request("/v1/webhook-deliveries")).status, 401);
    await db.update(users).set({ enabled: true }).where(eq(users.id, first.user.id));
    await runOnce(db, async () => ({ httpStatus: 200 }), signal());
    assert.equal((await stored(item.id)).status, "delivered");
  });

  it("does not leak preparation errors or send to an unapproved origin", async () => {
    const item = await event();
    let calls = 0;
    await runOnce(db, createSender(config.encryptionKey, [], async () => { calls++; return new Response(); }), signal());
    assert.equal(calls, 0); assert.equal((await stored(item.id)).status, "failed");
    assert.equal((await history(item.id))[0]!.error!.code, "destination_not_allowed");
    await request(`/v1/webhook-deliveries/${item.id}/redeliver`, "POST");
    await runOnce(db, async () => { throw new Error("private secret"); }, signal());
    const detail = await (await request(`/v1/webhook-deliveries/${item.id}`)).text();
    assert.ok(!detail.includes("private secret"));
  });

  it("keeps shutdown outcomes ambiguous for recovery and runs its independent loop", async () => {
    const item = await event();
    const controller = new AbortController();
    await runOnce(db, async (_delivery, _secret, signal) => { controller.abort(); assert.ok(signal.aborted); return { httpStatus: 200 }; }, controller.signal);
    assert.equal((await stored(item.id)).status, "delivering");
    assert.equal((await history(item.id))[0]!.finishedAt, null);
    await expired(item.id);
    await runOnce(db, async () => ({ httpStatus: 200 }), signal());
    assert.equal((await stored(item.id)).status, "delivered");
    const stopped = new AbortController(); stopped.abort();
    await runWorker(db, async () => { assert.fail("Stopped worker must not send"); }, stopped.signal);
  });
});
