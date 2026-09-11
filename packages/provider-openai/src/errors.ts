import { LlmError } from "@llm-providers/contracts";

export function invalidConfig(message: string): LlmError {
  return new LlmError(message, { provider: "openai", kind: "invalid_config" });
}

export function invalidRequest(message: string): LlmError {
  return new LlmError(message, { provider: "openai", kind: "invalid_request" });
}

export function httpError(response: Response, body: string): LlmError {
  let native: unknown = body;
  try { native = JSON.parse(body); } catch { /* Preserve non-JSON error bodies. */ }
  const envelope = native as { error?: unknown } | null;
  const detail = envelope?.error ?? native;
  const error = detail as { message?: unknown; code?: unknown; type?: unknown } | null;
  return new LlmError(
    typeof error?.message === "string" ? error.message
      : body || response.statusText || `OpenAI request failed with HTTP ${response.status}.`,
    {
      provider: "openai",
      kind: "provider_error",
      httpStatus: response.status,
      providerCode: typeof error?.code === "string" ? error.code : undefined,
      providerType: typeof error?.type === "string" ? error.type : undefined,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      nativeError: detail,
    },
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
