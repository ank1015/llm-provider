import { invalidConfig } from "./errors.js";

export const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const DEFAULT_FIREWORKS_TIMEOUT_MS = 15 * 60 * 1000;

export interface FireworksClientOptions {
  readonly apiKey: string;
  /** API root, without /chat/completions. HTTPS, or loopback HTTP for local testing. */
  readonly baseUrl?: string;
  /** Covers sending the request and reading its complete body. */
  readonly timeoutMs?: number;
  /** Optional application-owned fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
}

export function configureClient(options: FireworksClientOptions) {
  if (!options.apiKey.trim()) throw invalidConfig("Fireworks API key must not be empty.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_FIREWORKS_TIMEOUT_MS;
  validateTimeout(timeoutMs);
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl ?? DEFAULT_FIREWORKS_BASE_URL);
  } catch {
    throw invalidConfig("Fireworks base URL must be a fully qualified URL.");
  }
  const loopback = baseUrl.hostname === "localhost" || baseUrl.hostname === "[::1]"
    || /^127\.\d+\.\d+\.\d+$/.test(baseUrl.hostname);
  if ((baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback))
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw invalidConfig("Fireworks base URL must use HTTPS (loopback HTTP is allowed) without credentials, a query, or a fragment.");
  }

  let headers: Headers;
  try {
    headers = new Headers({
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
    });
  } catch {
    throw invalidConfig("Fireworks API key contains invalid header characters.");
  }
  return {
    url: `${baseUrl.href.replace(/\/+$/, "")}/chat/completions`,
    headers,
    timeoutMs,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

export function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw invalidConfig("Fireworks timeoutMs must be an integer between 1 and 2147483647.");
  }
}
