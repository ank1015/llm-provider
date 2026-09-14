import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PoolClient } from "pg";
import { createDatabase } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";

// Explicit opt-in: migrations run here, so use a disposable test database only.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database.");
const { db, pool } = createDatabase(url);
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
let client: PoolClient;
let userId: string;
let otherUserId: string;
let accountId: string;
let jobId: string;

async function expectConstraint(query: string, values: unknown[], code: string) {
  await client.query("SAVEPOINT expected_failure");
  try {
    await assert.rejects(client.query(query, values), { code });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    await client.query("RELEASE SAVEPOINT expected_failure");
  }
}

before(async () => {
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder });
});
after(async () => { await pool.end(); });

describe("gateway database", () => {
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    userId = randomUUID();
    otherUserId = randomUUID();
    accountId = randomUUID();
    jobId = randomUUID();
    await client.query(`insert into users (id, name, callback_url, webhook_secret_encrypted)
      values ($1, 'First', 'https://example.com/callback', $3), ($2, 'Second', 'https://example.com/callback', $3)`,
    [userId, otherUserId, Buffer.from("test-ciphertext")]);
    await client.query(`insert into provider_accounts (id, user_id, name, provider, secrets_encrypted)
      values ($1, $2, 'Test', 'openai', $3)`, [accountId, userId, Buffer.from("test-ciphertext")]);
    await client.query(`insert into jobs (id, user_id, account_id, model_id, idempotency_key, request_hash)
      values ($1, $2, $3, 'test-model', 'turn-1', 'hash-1')`, [jobId, userId, accountId]);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("applies each migration only once and creates all eight tables", async () => {
    const result = await client.query(`select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name = any($1)`, [[
      "users", "user_api_keys", "provider_accounts", "jobs", "job_requests", "job_attempts",
      "webhook_deliveries", "webhook_delivery_attempts",
    ]]);
    assert.equal(result.rows[0].count, 8);
    assert.equal((await client.query('select count(*)::int as count from drizzle.__drizzle_migrations')).rows[0].count, readMigrationFiles({ migrationsFolder }).length);
  });

  it("bounds lock and statement waits and rolls back timed-out transactions", { timeout: 12_000 }, async () => {
    const settings = await client.query(`select current_setting('lock_timeout') as lock,
      current_setting('statement_timeout') as statement,
      current_setting('idle_in_transaction_session_timeout') as idle`);
    assert.deepEqual(settings.rows[0], { lock: "3s", statement: "5s", idle: "30s" });
    assert.equal(pool.options.query_timeout, 10_000);
    assert.equal(pool.options.connectionTimeoutMillis, 5_000);
    await client.query("select pg_advisory_xact_lock(918273645)");
    const started = Date.now();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(918273645)`);
    }), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "55P03");
    assert.ok(Date.now() - started < 5_000);
    await expectConstraint("select pg_sleep(6)", [], "57014");
    assert.equal((await pool.query("select 1 as ok")).rows[0].ok, 1);
  });

  it("upgrades existing JSONB payloads and backfills listing usage without losing data", async () => {
    // Transaction-local tables shadow the real ones, exercising the upgrade SQL on old data.
    await client.query(`create temporary table job_requests (request jsonb not null,
      constraint job_requests_messages_check check (jsonb_typeof(request->'messages') = 'array')) on commit drop;
      create temporary table jobs (response jsonb) on commit drop;
      create temporary table webhook_deliveries (payload jsonb) on commit drop`);
    const request = { messages: [], providerOptions: { nested: ["preserved"] } };
    const response = { message: { content: [{ type: "future_item" }] }, usage: { input: 12, output: 3 } };
    const payload = { eventId: "unchanged", nested: { value: "preserved" } };
    await client.query("insert into job_requests values ($1)", [request]);
    await client.query("insert into jobs values ($1), (null)", [response]);
    await client.query("insert into webhook_deliveries values ($1)", [payload]);
    await client.query(await readFile(new URL("../migrations/0005_lossless_payloads.sql", import.meta.url), "utf8"));
    assert.deepEqual((await client.query("select request from job_requests")).rows, [{ request }]);
    assert.deepEqual((await client.query("select response, usage from jobs order by response is null")).rows,
      [{ response, usage: response.usage }, { response: null, usage: null }]);
    assert.deepEqual((await client.query("select payload from webhook_deliveries")).rows, [{ payload }]);
    assert.equal((await client.query("select pg_typeof(request)::text as type from job_requests")).rows[0].type, "json");
  });

  it("normalizes existing webhook events to the canonical lightweight payload", async () => {
    // Transaction-local tables shadow the real ones, exercising the data migration on legacy rows.
    await client.query(`create temporary table jobs (id uuid primary key, finished_at timestamptz not null) on commit drop;
      create temporary table webhook_deliveries (id uuid primary key, job_id uuid not null, event_type text not null,
        payload json not null) on commit drop`);
    const deliveryId = randomUUID();
    const legacyJobId = randomUUID();
    await client.query("insert into jobs values ($1, $2)", [legacyJobId, "2026-01-02T03:04:05.678Z"]);
    await client.query("insert into webhook_deliveries values ($1, $2, 'job.succeeded', $3)",
      [deliveryId, legacyJobId, { eventId: deliveryId, type: "job.succeeded", jobId: legacyJobId,
        completedAt: "2026-01-02T03:04:05.678Z", response: { message: "legacy" } }]);
    await client.query(await readFile(new URL("../migrations/0006_lightweight_webhook_events.sql", import.meta.url), "utf8"));
    assert.deepEqual((await client.query("select payload from webhook_deliveries")).rows[0].payload,
      { eventId: deliveryId, type: "job.succeeded", jobId: legacyJobId, completedAt: "2026-01-02T03:04:05.678Z" });
    await expectConstraint(`update webhook_deliveries
      set payload = (payload::jsonb || '{"response": {}}'::jsonb)::json where id = $1`, [deliveryId], "23514");
  });

  it("round-trips encrypted bytes, native JSON, timestamps, and defaults through Drizzle", async () => {
    const tx = drizzle(client, { schema });
    const [account] = await tx.select().from(schema.providerAccounts).where(eq(schema.providerAccounts.id, accountId));
    assert.deepEqual(account!.secretsEncrypted, Buffer.from("test-ciphertext"));
    assert.equal(account!.configVersion, 1);
    assert.ok(account!.createdAt instanceof Date);
    const request = { messages: [{ role: "assistant" as const, provider: "openai" as const,
      content: [{ type: "future_native_item", arbitrary: [1, { preserved: true }] }] }] };
    await tx.insert(schema.jobRequests).values({ jobId, request });
    const [stored] = await tx.select().from(schema.jobRequests).where(eq(schema.jobRequests.jobId, jobId));
    assert.deepEqual(stored!.request, request);
    assert.equal(stored!.expiresAt, null);
  });

  it("enforces account ownership and per-user idempotency", async () => {
    const insert = `insert into jobs (user_id, account_id, model_id, idempotency_key, request_hash)
      values ($1, $2, 'test-model', $3, 'hash')`;
    await expectConstraint(insert, [otherUserId, accountId, "foreign-account"], "23503");
    await expectConstraint(insert, [userId, accountId, "turn-1"], "23505");
    const otherAccount = randomUUID();
    await client.query(`insert into provider_accounts (id, user_id, name, provider, secrets_encrypted)
      values ($1, $2, 'Other', 'fireworks', $3)`, [otherAccount, otherUserId, Buffer.from("test")]);
    await client.query(insert, [otherUserId, otherAccount, "turn-1"]);
  });

  it("allows same-user branches but rejects cross-user parents and self-reference", async () => {
    const foreignJob = randomUUID();
    const foreignAccount = randomUUID();
    await client.query(`insert into provider_accounts (id, user_id, name, provider, secrets_encrypted)
      values ($1, $2, 'Other', 'chatgpt', $3)`, [foreignAccount, otherUserId, Buffer.from("test")]);
    await client.query(`insert into jobs (id, user_id, account_id, model_id, idempotency_key, request_hash)
      values ($1, $2, $3, 'test', 'foreign', 'hash')`, [foreignJob, otherUserId, foreignAccount]);
    await expectConstraint("update jobs set previous_job_id = $1 where id = $2", [foreignJob, jobId], "23503");
    await expectConstraint("update jobs set previous_job_id = id where id = $1", [jobId], "23514");
    for (const key of ["branch-a", "branch-b"]) {
      await client.query(`insert into jobs (user_id, account_id, previous_job_id, model_id, idempotency_key, request_hash)
        values ($1, $2, $3, 'test', $4, 'hash')`, [userId, accountId, jobId, key]);
    }
  });

  it("requires valid JSON; message shape is checked by the submission API", async () => {
    await expectConstraint("insert into job_requests (job_id, request) values ($1, $2)", [jobId, "{broken"], "22P02");
    await client.query("insert into job_requests (job_id, request) values ($1, $2)", [jobId, { messages: [] }]);
  });

  it("enforces job outcomes, finished timestamps, and paired lease fields", async () => {
    await expectConstraint("update jobs set status = 'invalid' where id = $1", [jobId], "23514");
    await expectConstraint("update jobs set status = 'succeeded', finished_at = now() where id = $1", [jobId], "23514");
    await expectConstraint("update jobs set status = 'failed', error = '{}' where id = $1", [jobId], "23514");
    await expectConstraint("update jobs set lease_token = gen_random_uuid() where id = $1", [jobId], "23514");
    await client.query("update jobs set status = 'failed', error = $2, finished_at = now() where id = $1", [jobId, { message: "failed" }]);
  });

  it("keeps missing usage null and preserves bigint and decimal precision", async () => {
    const tx = drizzle(client, { schema });
    const [attempt] = await tx.insert(schema.jobAttempts).values({
      jobId, attemptNumber: 1, accountConfigVersion: 1,
      inputTokens: 9007199254740993n, totalCostUsd: "0.000000000001",
    }).returning();
    assert.equal(attempt!.inputTokens, 9007199254740993n);
    assert.equal(attempt!.outputTokens, null);
    assert.equal(attempt!.totalCostUsd, "0.000000000001");
    await expectConstraint("update job_attempts set input_tokens = -1 where id = $1", [attempt!.id], "23514");
    await expectConstraint("update job_attempts set total_cost_usd = 'NaN' where id = $1", [attempt!.id], "23514");
    await expectConstraint("update job_attempts set total_cost_usd = -1 where id = $1", [attempt!.id], "23514");
    await expectConstraint(`insert into job_attempts (job_id, attempt_number, account_config_version) values ($1, 1, 1)`, [jobId], "23505");
  });

  it("keeps job identity and independent child input after parent input deletion", async () => {
    await client.query("update jobs set status = 'succeeded', response = '{}', finished_at = now() where id = $1", [jobId]);
    await client.query("insert into job_requests values ($1, $2, now() - interval '1 day')", [jobId, { messages: [] }]);
    const childId = randomUUID();
    await client.query(`insert into jobs (id, user_id, account_id, previous_job_id, model_id, idempotency_key, request_hash)
      values ($1, $2, $3, $4, 'test', 'child', 'child-hash')`, [childId, userId, accountId, jobId]);
    await client.query("insert into job_requests (job_id, request) values ($1, $2)", [childId, { messages: [] }]);
    await client.query("delete from job_requests where job_id = $1", [jobId]);
    assert.equal((await client.query("select request_hash from jobs where id = $1", [jobId])).rows[0].request_hash, "hash-1");
    assert.equal((await client.query("select count(*)::int as count from job_requests where job_id = $1", [childId])).rows[0].count, 1);
    await expectConstraint("delete from jobs where id = $1", [jobId], "23503");
  });

  it("enforces one owned delivery per job and preserves redelivery attempts", async () => {
    const deliveryId = randomUUID();
    const payload = { eventId: deliveryId, type: "job.succeeded", jobId, completedAt: new Date().toISOString() };
    const insert = `insert into webhook_deliveries (id, user_id, job_id, event_type, callback_url, payload)
      values ($3, $1, $2, 'job.succeeded', 'https://example.com/callback', $4) returning id`;
    await expectConstraint(insert, [otherUserId, jobId, deliveryId, payload], "23503");
    assert.equal((await client.query(insert, [userId, jobId, deliveryId, payload])).rows[0].id, deliveryId);
    await expectConstraint(insert, [userId, jobId, deliveryId, payload], "23505");
    await expectConstraint(`update webhook_deliveries
      set payload = (payload::jsonb || '{"error": {}}'::jsonb)::json where id = $1`, [deliveryId], "23514");
    await expectConstraint("update webhook_deliveries set status = 'delivered' where id = $1", [deliveryId], "23514");
    await client.query("update webhook_deliveries set status = 'delivered', delivered_at = now() where id = $1", [deliveryId]);
    await client.query("update webhook_deliveries set status = 'pending' where id = $1", [deliveryId]);
    await client.query("insert into webhook_delivery_attempts (delivery_id, attempt_number, http_status, finished_at) values ($1, 1, 200, now())", [deliveryId]);
    await expectConstraint("insert into webhook_delivery_attempts (delivery_id, attempt_number) values ($1, 1)", [deliveryId], "23505");
    await expectConstraint("insert into webhook_delivery_attempts (delivery_id, attempt_number, http_status) values ($1, 2, 999)", [deliveryId], "23514");
  });

  it("enforces provider names, account versions, and unique key hashes", async () => {
    await expectConstraint("update provider_accounts set provider = 'invalid' where id = $1", [accountId], "23514");
    await expectConstraint("update provider_accounts set config_version = 0 where id = $1", [accountId], "23514");
    const hash = randomUUID();
    await client.query("insert into user_api_keys (user_id, key_hash, key_prefix) values ($1, $2, 'prefix')", [userId, hash]);
    await expectConstraint("insert into user_api_keys (user_id, key_hash, key_prefix) values ($1, $2, 'prefix')", [otherUserId, hash], "23505");
  });

  it("rolls back a failed multi-table transaction through the database client", async () => {
    const id = randomUUID();
    await assert.rejects(db.transaction(async (tx) => {
      await tx.insert(schema.users).values({ id, name: "Rollback", callbackUrl: "https://example.com/callback", webhookSecretEncrypted: Buffer.from("test") });
      await tx.insert(schema.userApiKeys).values({ userId: id, keyHash: id, keyPrefix: "prefix" });
      throw new Error("rollback test");
    }), /rollback test/);
    assert.equal((await db.select().from(schema.users).where(eq(schema.users.id, id))).length, 0);
    assert.equal((await db.select().from(schema.userApiKeys).where(eq(schema.userApiKeys.userId, id))).length, 0);
  });

  it("creates queue, lease, retention, and lineage indexes", async () => {
    const result = await client.query("select indexname from pg_indexes where schemaname = 'public'");
    const names = new Set(result.rows.map((row) => row.indexname));
    for (const name of ["jobs_runnable_idx", "jobs_expired_lease_idx", "jobs_parent_idx", "job_requests_expiry_idx", "webhook_deliveries_runnable_idx", "webhook_deliveries_expired_lease_idx"]) {
      assert.ok(names.has(name), name);
    }
  });
});
