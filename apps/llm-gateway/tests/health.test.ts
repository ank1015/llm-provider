import assert from "node:assert/strict";
import { it } from "node:test";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";

it("serves public uncached liveness without accessing PostgreSQL", async () => {
  const { db, pool } = createDatabase("postgres://unused@127.0.0.1:1/unused");
  try {
    const app = createApp(db, { adminApiKey: "unused", encryptionKey: Buffer.alloc(32) });
    const response = await app.request("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(pool.totalCount, 0);
    const readiness = await app.request("/readyz");
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { status: "not_ready" });
    assert.equal(readiness.headers.get("cache-control"), "no-store");
  } finally {
    await pool.end();
  }
});
