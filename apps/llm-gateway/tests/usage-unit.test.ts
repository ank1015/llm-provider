import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { cursorKey, encodeCursor, query } from "../src/usage/validation.js";

it("accepts optional usage filters, exact UTC timestamps, and bounded grouping", () => {
  assert.deepEqual(query.parse({}), { limit: 50 });
  const input = { from: "2026-01-01T00:00:00.000001Z", to: "2026-01-01T00:00:00.000002Z",
    accountId: randomUUID(), provider: "openai", modelId: "historical-model", groupBy: "day", limit: "100" };
  assert.equal(query.parse(input).limit, 100);
  assert.ok(query.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:00:00.000001Z" }).success);
  assert.ok(query.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }).success);
});

it("rejects unsupported fields, malformed values, and reversed microsecond ranges", () => {
  for (const invalid of [{ userId: randomUUID() }, { provider: "other" }, { groupBy: "week" }, { accountId: "bad" },
    { modelId: "" }, { limit: "101" }, { limit: "0" }, { limit: "1.5" }, { from: "yesterday" },
    { from: "2026-01-01T00:00:00+05:30" }, { from: "2026-01-01T00:00:00.0000001Z" }, { from: "0000-01-01T00:00:00Z" },
    { from: "2026-01-01T00:00:00.000002Z", to: "2026-01-01T00:00:00.000001Z" },
    { from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }, { cursor: "abc" }]) {
    assert.equal(query.safeParse(invalid).success, false);
  }
});

it("round-trips usage cursors and rejects malformed or mismatched groupings", () => {
  const cursor = encodeCursor("model", "openai:gpt-6-astra");
  assert.equal(cursorKey(query.parse({ groupBy: "model", cursor })), "openai:gpt-6-astra");
  assert.equal(cursorKey(query.parse({})), undefined);
  assert.throws(() => cursorKey(query.parse({ groupBy: "day", cursor })));
  for (const value of ["invalid", Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ groupBy: "model", key: 42 })).toString("base64url"),
    Buffer.from(JSON.stringify({ groupBy: "model", key: "x", extra: true })).toString("base64url")]) {
    assert.throws(() => cursorKey(query.parse({ groupBy: "model", cursor: value })));
  }
});
