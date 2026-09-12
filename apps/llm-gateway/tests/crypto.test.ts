import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";
import { decryptSecret, encryptSecret, hashApiKey, matchesSecret, mintApiKey, mintWebhookSecret } from "../src/crypto.js";
import { loadConfig } from "../src/config.js";

it("mints unique keys with hashes and safe display prefixes", () => {
  const a = mintApiKey();
  const b = mintApiKey();
  assert.match(a.secret, /^lgw_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.secret, b.secret);
  assert.equal(a.keyHash, hashApiKey(a.secret));
  assert.equal(a.keyPrefix, a.secret.slice(0, 12));
  assert.ok(matchesSecret(a.secret, a.secret));
  assert.ok(!matchesSecret(a.secret, b.secret));
  assert.ok(!matchesSecret("", a.secret));
  assert.match(mintWebhookSecret(), /^whsec_[A-Za-z0-9_-]{43}$/);
});

it("encrypts with random nonces and binds the secret to its owner and purpose", () => {
  const key = randomBytes(32);
  const context = "user:123:webhook";
  const secret = mintWebhookSecret();
  const encrypted = encryptSecret(secret, key, context);
  assert.equal(encrypted[0], 1);
  assert.ok(!encrypted.includes(Buffer.from(secret)));
  assert.notDeepEqual(encrypted, encryptSecret(secret, key, context));
  assert.equal(decryptSecret(encrypted, key, context), secret);
  assert.throws(() => decryptSecret(encrypted, key, "user:other:webhook"));
  assert.throws(() => decryptSecret(encrypted, randomBytes(32), context));
});

it("rejects tampered, truncated, and unsupported ciphertext", () => {
  const key = randomBytes(32);
  const encrypted = encryptSecret("secret", key, "context");
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  assert.throws(() => decryptSecret(tampered, key, "context"));
  assert.throws(() => decryptSecret(encrypted.subarray(0, 20), key, "context"));
  const unsupported = Buffer.from(encrypted);
  unsupported[0] = 2;
  assert.throws(() => decryptSecret(unsupported, key, "context"));
});

it("loads required configuration and fails without revealing secret values", () => {
  const env = { DATABASE_URL: "postgresql://localhost/gateway", ADMIN_API_KEY: "a".repeat(32), ENCRYPTION_KEY: "ab".repeat(32) };
  assert.equal(loadConfig(env).port, 3000);
  assert.equal(loadConfig(env).workerConcurrency, 1);
  for (const value of ["1", "16", "32", "128"]) {
    assert.equal(loadConfig({ ...env, WORKER_CONCURRENCY: value }).workerConcurrency, Number(value));
  }
  for (const value of ["", "0", "-1", "1.5", "129", "Infinity", "abc"]) {
    assert.throws(() => loadConfig({ ...env, WORKER_CONCURRENCY: value }), /WORKER_CONCURRENCY/);
  }
  assert.deepEqual(loadConfig(env).encryptionKey, Buffer.from(env.ENCRYPTION_KEY, "hex"));
  assert.equal(loadConfig({ ...env, PORT: "0" }).port, 0);
  for (const patch of [
    { ADMIN_API_KEY: "short" }, { ADMIN_API_KEY: " ".repeat(32) },
    { DATABASE_URL: "not a url" }, { DATABASE_URL: "https://example.com" },
    { ENCRYPTION_KEY: "do-not-leak" }, { PORT: "65536" }, { PORT: "abc" },
  ]) {
    assert.throws(() => loadConfig({ ...env, ...patch }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid gateway configuration/);
      assert.ok(!error.message.includes("do-not-leak"));
      return true;
    });
  }
  assert.throws(() => loadConfig({}));
});
