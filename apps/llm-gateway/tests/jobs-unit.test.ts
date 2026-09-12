import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { LlmError } from "@llm-providers/contracts";
import { loadConfig } from "../src/config.js";
import { fingerprint } from "../src/jobs/service.js";
import { submission } from "../src/jobs/validation.js";
import { isRetryable, retryDelay, serializeError } from "../src/jobs/policy.js";
import { validateDestination } from "../src/jobs/provider.js";

const input = { accountId: randomUUID(), modelId: "gpt-6-astra", idempotencyKey: "key", messages: [] };

it("normalizes fresh defaults and fingerprints object order but preserves array order", () => {
  const a = submission.parse(input);
  const b = submission.parse({ ...input, previousJobId: null, tools: [], providerOptions: {} });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(submission.parse({ ...input, providerOptions: { a: 1, b: { c: 2, d: 3 } } })),
    fingerprint(submission.parse({ ...input, providerOptions: { b: { d: 3, c: 2 }, a: 1 } })));
  assert.notEqual(fingerprint(submission.parse({ ...input, providerOptions: { order: [1, 2] } })),
    fingerprint(submission.parse({ ...input, providerOptions: { order: [2, 1] } })));
});

it("retains arbitrary native assistant items, custom data, and JSON keys", () => {
  const native = JSON.parse('{"__proto__":{"value":"kept"},"constructor":4,"future":null}');
  const messages = [
    { role: "assistant", provider: "openai", content: [native, "opaque", null] },
    { role: "custom", tag: "application_tag", data: 42 },
    { role: "custom", tag: "openai_custom_item", data: { content: [native] } },
  ];
  const parsed = submission.parse({ ...input, messages });
  assert.deepEqual(parsed.messages, messages);
  assert.ok(fingerprint(parsed));
});

it("requires continuation messages and rejects inherited-field overrides and credential inputs", () => {
  const parent = { idempotencyKey: "next", previousJobId: randomUUID(), messages: [] };
  assert.ok(submission.safeParse(parent).success);
  for (const invalid of [
    { ...parent, messages: null }, { ...parent, messages: undefined }, { ...parent, accountId: input.accountId },
    { ...parent, modelId: input.modelId }, { ...parent, instructions: "override" }, { ...parent, tools: [] },
    { ...parent, providerOptions: {} }, { ...input, apiKey: "secret" }, { ...input, provider: "openai" },
    { ...input, messages: [{ role: "user", content: [{ type: "image", url: "data:image/png;base64,AA==" }] }] },
    { ...input, messages: [{ role: "system", content: [{ type: "image", url: "https://example.com/image" }] }] },
  ]) assert.ok(!submission.safeParse(invalid).success);
});

it("only retries transport/timeouts and selected transient HTTP errors", () => {
  for (const kind of ["network_error", "timeout"] as const) assert.ok(isRetryable(new LlmError("failure", { provider: "openai", kind })));
  for (const httpStatus of [408, 429, 500, 502, 503, 504]) assert.ok(isRetryable(new LlmError("failure", { provider: "openai", kind: "provider_error", httpStatus })));
  for (const httpStatus of [400, 401, 403, 404, 409, 422, 501]) assert.ok(!isRetryable(new LlmError("failure", { provider: "openai", kind: "provider_error", httpStatus })));
  for (const kind of ["invalid_config", "invalid_request", "invalid_response", "cancelled"] as const) assert.ok(!isRetryable(new LlmError("failure", { provider: "openai", kind, httpStatus: 503 })));
  assert.ok(!isRetryable(new LlmError("failure", { provider: "chatgpt", kind: "provider_error", httpStatus: 429, providerCode: "insufficient_quota" })));
  assert.ok(!isRetryable(new LlmError("failure", { provider: "openai", kind: "provider_error" })));
  assert.ok(!isRetryable(new Error("unexpected")));
});

it("uses capped exponential jitter and honors longer Retry-After hints", () => {
  assert.equal(retryDelay(1, undefined, () => 0), 500);
  assert.equal(retryDelay(2, undefined, () => 1), 2000);
  assert.equal(retryDelay(20, undefined, () => 1), 30_000);
  assert.equal(retryDelay(1, new LlmError("failure", { provider: "fireworks", kind: "provider_error", retryAfterMs: 90_000 }), () => 0), 90_000);
});

it("does not serialize raw error payloads, provider-controlled strings, or credentials", () => {
  const error = new LlmError("do-not-store", { provider: "openai", kind: "provider_error", httpStatus: 429,
    providerCode: "do-not-store", providerType: "do-not-store", nativeError: { authorization: "do-not-store" } });
  assert.ok(!JSON.stringify(serializeError(error)).includes("do-not-store"));
  assert.deepEqual(serializeError(new Error("secret")), { code: "internal_error", message: "Job execution failed.", retryable: false });
});

it("requires exact operator-trusted provider origins", () => {
  for (const provider of ["openai", "chatgpt", "fireworks"] as const) validateDestination({ provider, config: {} }, []);
  for (const baseUrl of ["https://example.com/v1", "http://localhost:8080", "https://api.openai.com.example.com/v1", "https://api.openai.com:8443"]) {
    assert.throws(() => validateDestination({ provider: "openai", config: { baseUrl } }, []));
  }
  validateDestination({ provider: "openai", config: { baseUrl: "http://localhost:8080/v1" } }, ["http://localhost:8080"]);
});

it("validates global retention and canonical origin settings", () => {
  const env = { DATABASE_URL: "postgresql://localhost/gateway", ADMIN_API_KEY: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) };
  assert.equal(loadConfig(env).requestRetentionDays, 7);
  assert.deepEqual(loadConfig(env).providerOrigins, []);
  assert.deepEqual(loadConfig({ ...env, PROVIDER_ALLOWED_ORIGINS: "https://proxy.example.com, http://localhost:8080" }).providerOrigins,
    ["https://proxy.example.com", "http://localhost:8080"]);
  for (const patch of [{ REQUEST_RETENTION_DAYS: "0" }, { REQUEST_RETENTION_DAYS: "1.5" },
    { PROVIDER_ALLOWED_ORIGINS: "https://user:secret@example.com" }, { PROVIDER_ALLOWED_ORIGINS: "https://example.com/v1" },
    { PROVIDER_ALLOWED_ORIGINS: "http://example.com" }]) assert.throws(() => loadConfig({ ...env, ...patch }));
});
