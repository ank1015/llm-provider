import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { it } from "node:test";
import { loadConfig } from "../src/config.js";
import { encryptSecret } from "../src/crypto.js";
import type { webhookDeliveries } from "../src/db/schema.js";
import { createSender, destinationAllowed, signature } from "../src/webhooks/sender.js";
import { retryAfter, retryDelay } from "../src/webhooks/policy.js";

const key = randomBytes(32);
const secret = "whsec_test-signing-secret";
const delivery: typeof webhookDeliveries.$inferSelect = {
  id: randomUUID(), userId: randomUUID(), jobId: randomUUID(), eventType: "job.succeeded",
  callbackUrl: "https://callbacks.example.com/events", payload: { message: "Hello 世界", nested: { number: 1 } },
  status: "delivering", retryFromAttempt: 1, retryStartedAt: new Date(),
  nextAttemptAt: new Date(), createdAt: new Date(), deliveredAt: null, leaseToken: null, leaseExpiresAt: null,
};
const encrypted = encryptSecret(secret, key, `user:${delivery.userId}:webhook`);
const origins = ["https://callbacks.example.com"];
const signal = () => new AbortController().signal;

it("signs the exact timestamp, event ID, and raw UTF-8 body with the literal secret", () => {
  const body = JSON.stringify(delivery.payload);
  const expected = createHmac("sha256", Buffer.from(secret)).update(`1700000000.${delivery.id}.`).update(Buffer.from(body)).digest("hex");
  assert.equal(signature(secret, delivery.id, "1700000000", body), `v1=${expected}`);
  assert.notEqual(signature(secret, delivery.id, "1700000000", body), signature(secret, delivery.id, "1700000001", body));
  assert.notEqual(signature(secret, delivery.id, "1700000000", body), signature(secret, randomUUID(), "1700000000", body));
  assert.notEqual(signature(secret, delivery.id, "1700000000", body), signature(secret, delivery.id, "1700000000", body + " "));
});

it("sends signed JSON and treats any 2xx as acknowledgement without reading the body", async () => {
  let cancelled = false;
  const sender = createSender(key, origins, async (url, init) => {
    assert.equal(url, delivery.callbackUrl);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-llm-gateway-event-id"), delivery.id);
    const timestamp = headers.get("x-llm-gateway-timestamp")!;
    assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 2);
    assert.equal(init?.body, JSON.stringify(delivery.payload));
    assert.equal(headers.get("x-llm-gateway-signature"), signature(secret, delivery.id, timestamp, init?.body as string));
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 202 });
  });
  assert.deepEqual(await sender(delivery, encrypted, signal()), { httpStatus: 202 });
  assert.ok(cancelled);
});

it("only allows trusted exact or wildcard HTTPS origins and sends nothing for disallowed URLs", async () => {
  let calls = 0;
  const sender = createSender(key, origins, async () => { calls++; return new Response(); });
  for (const url of ["https://callbacks.example.com.evil.test/events", "https://callbacks.example.com:8443",
    "http://callbacks.example.com/events", "https://secret@callbacks.example.com/events", "https://callbacks.example.com/#fragment",
    "https://127.0.0.1/events", "https://other.example.com/events"]) {
    assert.equal(destinationAllowed(url, origins), false);
    assert.equal((await sender({ ...delivery, callbackUrl: url }, encrypted, signal())).error?.code, "destination_not_allowed");
  }
  assert.equal((await createSender(key, [], async () => { calls++; return new Response(); })(delivery, encrypted, signal())).error?.code, "destination_not_allowed");
  assert.equal(calls, 0);
  assert.ok(destinationAllowed("https://callbacks.example.com/path?tenant=1", origins));
  const wildcard = ["https://*.acentric.dev"];
  assert.ok(destinationAllowed("https://app.acentric.dev/events", wildcard));
  assert.ok(destinationAllowed("https://hooks.eu.acentric.dev/events", wildcard));
  for (const url of ["https://acentric.dev/events", "https://acentric.dev.evil.test/events",
    "https://app.acentric.dev:8443/events", "http://app.acentric.dev/events"]) {
    assert.equal(destinationAllowed(url, wildcard), false);
  }
});

it("does not follow redirects or retry permanent HTTP failures", async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 410, 422, 501]) {
    let calls = 0;
    const sender = createSender(key, origins, async (_url, init) => {
      calls++; assert.equal(init?.redirect, "manual");
      return new Response("do-not-store", { status, headers: { location: "https://other.example.com" } });
    });
    const result = await sender(delivery, encrypted, signal());
    assert.equal(result.httpStatus, status);
    assert.equal(result.error?.retryable, false);
    assert.ok(!JSON.stringify(result).includes("do-not-store"));
    assert.equal(calls, 1);
  }
});

it("retries transient statuses and network failures without retaining raw errors", async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const sender = createSender(key, origins, async () => new Response("secret body", { status, headers: { "retry-after": "90" } }));
    const result = await sender(delivery, encrypted, signal());
    assert.equal(result.error?.retryable, true);
    assert.equal(result.retryAfterMs, 90_000);
  }
  const result = await createSender(key, origins, async () => { throw new Error("secret URL"); })(delivery, encrypted, signal());
  assert.equal(result.error?.code, "network_error");
  assert.ok(!JSON.stringify(result).includes("secret URL"));
});

it("honors shutdown and bounds in-flight network I/O", { timeout: 20_000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const cancelled = await createSender(key, origins, async () => { calls++; return new Response(); })(delivery, encrypted, controller.signal);
  assert.equal(cancelled.error?.code, "cancelled");
  assert.equal(calls, 0);
  const result = await createSender(key, origins, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }))(delivery, encrypted, signal());
  assert.equal(result.error?.code, "timeout");
  assert.equal(result.error?.retryable, true);
});

it("parses delay hints and applies capped exponential jitter", () => {
  assert.equal(retryAfter("3"), 3000);
  assert.equal(retryAfter("Wed, 01 Jan 2025 00:00:03 GMT", Date.parse("2025-01-01T00:00:00Z")), 3000);
  for (const value of [null, "invalid", "", "-10", "Infinity"]) assert.equal(retryAfter(value), undefined);
  assert.equal(retryDelay(1, 0, () => 0), 15_000);
  assert.equal(retryDelay(2, 0, () => 1), 60_000);
  assert.equal(retryDelay(20, 0, () => 1), 3_600_000);
  assert.equal(retryDelay(1, 7_200_000, () => 0), 7_200_000);
});

it("validates webhook origin configuration without implicitly trusting provider origins", () => {
  const env = { DATABASE_URL: "postgresql://localhost/gateway", ADMIN_API_KEY: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) };
  assert.deepEqual(loadConfig(env).webhookOrigins, []);
  assert.deepEqual(loadConfig({ ...env, PROVIDER_ALLOWED_ORIGINS: origins[0] }).webhookOrigins, []);
  assert.deepEqual(loadConfig({ ...env, WEBHOOK_ALLOWED_ORIGINS: origins[0] }).webhookOrigins, origins);
  assert.deepEqual(loadConfig({ ...env, WEBHOOK_ALLOWED_ORIGINS: "https://*.acentric.dev" }).webhookOrigins, ["https://*.acentric.dev"]);
  for (const value of ["http://localhost:8080", "https://example.com/path", "https://user:secret@example.com", "*",
    "https://*.acentric.dev:8443", "https://*.127.0.0.1", "https://*.*.acentric.dev"]) {
    assert.throws(() => loadConfig({ ...env, WEBHOOK_ALLOWED_ORIGINS: value }));
  }
});
