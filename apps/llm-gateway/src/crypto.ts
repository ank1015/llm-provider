import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function matchesSecret(value: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(hashApiKey(value), "hex"), Buffer.from(hashApiKey(expected), "hex"));
}

export function mintApiKey() {
  const secret = `lgw_${randomBytes(32).toString("base64url")}`;
  return { secret, keyHash: hashApiKey(secret), keyPrefix: secret.slice(0, 12) };
}

export function mintWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** Version 1 envelope: version byte, 12-byte nonce, 16-byte tag, ciphertext. */
export function encryptSecret(secret: string, key: Buffer, context: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(envelope: Buffer, key: Buffer, context: string): string {
  if (envelope.length < 29 || envelope[0] !== 1) throw new Error("Unsupported encrypted secret envelope.");
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(1, 13));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(envelope.subarray(13, 29));
  return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]).toString("utf8");
}
