import { createHmac } from "node:crypto";
import { decryptSecret } from "../crypto.js";
import type { webhookDeliveries } from "../db/schema.js";
import { REQUEST_TIMEOUT_MS, retryAfter, type DeliveryResult } from "./policy.js";

type Delivery = typeof webhookDeliveries.$inferSelect;
export type Send = (delivery: Delivery, encryptedSecret: Buffer, signal: AbortSignal) => Promise<DeliveryResult>;

export function signature(secret: string, eventId: string, timestamp: string, body: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`).digest("hex")}`;
}

/** Only trusted HTTPS origins; unlike provider development URLs, callbacks never use HTTP. */
export function destinationAllowed(value: string, origins: readonly string[]) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  return origins.some((origin) => {
    if (!origin.startsWith("https://*.")) return url.origin === origin;
    const suffix = origin.slice("https://*".length);
    return !url.port && url.hostname.endsWith(suffix) && url.hostname.length > suffix.length;
  });
}

export function createSender(encryptionKey: Buffer, origins: readonly string[], fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)): Send {
  return async (delivery, encryptedSecret, signal) => {
    if (!destinationAllowed(delivery.callbackUrl, origins)) {
      return { error: { code: "destination_not_allowed", message: "Callback origin is not allowed by this gateway.", retryable: false } };
    }
    const secret = decryptSecret(encryptedSecret, encryptionKey, `user:${delivery.userId}:webhook`);
    const body = JSON.stringify(delivery.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      controller.signal.throwIfAborted();
      const response = await fetch(delivery.callbackUrl, {
        method: "POST", body, signal: controller.signal, redirect: "manual",
        headers: { "content-type": "application/json", "user-agent": "llm-gateway/0.0.0",
          "x-llm-gateway-event-id": delivery.id, "x-llm-gateway-timestamp": timestamp,
          "x-llm-gateway-signature": signature(secret, delivery.id, timestamp, body) },
      });
      // The status is the acknowledgement. Never buffer/store arbitrary response bodies.
      void response.body?.cancel().catch(() => {});
      if (response.ok) return { httpStatus: response.status };
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      return { httpStatus: response.status, retryAfterMs: retryAfter(response.headers.get("retry-after")),
        error: { code: "http_error", message: "Callback returned a non-success HTTP status.", retryable } };
    } catch {
      const code = timedOut ? "timeout" : signal.aborted ? "cancelled" : "network_error";
      return { error: { code, message: "Callback request did not complete.", retryable: code !== "cancelled" } };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}
