import { invalidConfig } from "./errors.js";

export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_CHATGPT_TIMEOUT_MS = 15 * 60 * 1000;

export interface ChatGptClientOptions {
  readonly accessToken: string;
  readonly accountId: string;
  /** Backend root, /codex root, or complete /codex/responses URL. */
  readonly baseUrl?: string;
  /** Covers the request through its terminal SSE event. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function configureClient(options: ChatGptClientOptions) {
  if (!options.accessToken.trim()) throw invalidConfig("ChatGPT access token must not be empty.");
  if (!options.accountId.trim()) throw invalidConfig("ChatGPT account ID must not be empty.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHATGPT_TIMEOUT_MS;
  validateTimeout(timeoutMs);
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.baseUrl ?? DEFAULT_CHATGPT_BASE_URL);
  } catch {
    throw invalidConfig("ChatGPT base URL must be a fully qualified URL.");
  }
  const loopback = baseUrl.hostname === "localhost" || baseUrl.hostname === "[::1]"
    || /^127\.\d+\.\d+\.\d+$/.test(baseUrl.hostname);
  if ((baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback))
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw invalidConfig("ChatGPT base URL must use HTTPS (loopback HTTP is allowed) without credentials, a query, or a fragment.");
  }
  let headers: Headers;
  try {
    headers = new Headers({
      authorization: `Bearer ${options.accessToken}`,
      "chatgpt-account-id": options.accountId,
      accept: "text/event-stream",
      "content-type": "application/json",
      originator: "agent-pane",
      "openai-beta": "responses=experimental",
      "user-agent": "llm-providers/provider-chatgpt/0.0.0",
    });
  } catch {
    throw invalidConfig("ChatGPT access token or account ID contains invalid header characters.");
  }
  const root = baseUrl.href.replace(/\/+$/, "");
  return {
    url: root.endsWith("/codex/responses") ? root : root.endsWith("/codex") ? `${root}/responses` : `${root}/codex/responses`,
    headers,
    timeoutMs,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

export function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw invalidConfig("ChatGPT timeoutMs must be an integer between 1 and 2147483647.");
  }
}
