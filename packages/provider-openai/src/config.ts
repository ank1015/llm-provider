import { invalidConfig } from "./errors.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_TIMEOUT_MS = 15 * 60 * 1000;

export interface OpenAiClientOptions {
  readonly apiKey: string;
  /** API root, without /responses. HTTPS, or loopback HTTP for local testing. */
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  /** Covers sending the request and reading its complete body. */
  readonly timeoutMs?: number;
  /** Optional application-owned fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
}

export function configureClient(options: OpenAiClientOptions) {
  if (!options.apiKey.trim()) throw invalidConfig("OpenAI API key must not be empty.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
  validateTimeout(timeoutMs);
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl ?? DEFAULT_OPENAI_BASE_URL);
  } catch {
    throw invalidConfig("OpenAI base URL must be a fully qualified URL.");
  }
  const loopback = baseUrl.hostname === "localhost" || baseUrl.hostname === "[::1]"
    || /^127\.\d+\.\d+\.\d+$/.test(baseUrl.hostname);
  if ((baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback))
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw invalidConfig("OpenAI base URL must use HTTPS (loopback HTTP is allowed) without credentials, a query, or a fragment.");
  }

  let headers: Headers;
  try {
    headers = new Headers({
      authorization: `Bearer ${options.apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
    });
    if (options.organization?.trim()) headers.set("openai-organization", options.organization);
    if (options.project?.trim()) headers.set("openai-project", options.project);
  } catch {
    throw invalidConfig("OpenAI credentials or organization/project contain invalid header characters.");
  }
  return {
    url: `${baseUrl.href.replace(/\/+$/, "")}/responses`,
    headers,
    timeoutMs,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

export function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw invalidConfig("OpenAI timeoutMs must be an integer between 1 and 2147483647.");
  }
}
