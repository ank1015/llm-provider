import { LlmError } from "@llm-providers/contracts";

export function invalidConfig(message: string): LlmError {
  return new LlmError(message, { provider: "fireworks", kind: "invalid_config" });
}

export function invalidRequest(message: string): LlmError {
  return new LlmError(message, { provider: "fireworks", kind: "invalid_request" });
}

export function httpError(response: Response, body: string): LlmError {
  let native: unknown = body;
  try { native = JSON.parse(body); } catch { /* Preserve non-JSON error bodies. */ }
  const detail = (native as { error?: unknown } | null)?.error ?? native;
  const error = detail as { code?: unknown; type?: unknown } | null;
  return new LlmError(
    extractMessage(detail) ?? extractMessage(native)
      ?? (body || response.statusText || `Fireworks request failed with HTTP ${response.status}.`),
    {
      provider: "fireworks", kind: "provider_error", httpStatus: response.status,
      providerCode: typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : undefined,
      providerType: typeof error?.type === "string" ? error.type : undefined,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      nativeError: detail,
    },
  );
}

function extractMessage(value: unknown): string | undefined {
  const error = value as { message?: unknown; detail?: unknown } | null;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.detail === "string") return error.detail;
  if (Array.isArray(error?.detail)) {
    const messages = error.detail.map((item) => item?.msg).filter((msg) => typeof msg === "string");
    return messages.length ? messages.join("; ") : undefined;
  }
  return undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
