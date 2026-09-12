import { LlmError } from "@llm-providers/contracts";
import { ApiError } from "../errors.js";

export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_ATTEMPTS = 3;
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 10_000;
export const DEFAULT_RETENTION_DAYS = 7;

/** Eligibility is separate from the attempt/deadline budget. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;
  if (error.kind === "network_error" || error.kind === "timeout") return true;
  if (error.kind !== "provider_error") return false;
  const permanent = ["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached", "billing_not_active", "usage_limit_reached"];
  if (permanent.includes(error.providerCode ?? "") || permanent.includes(error.providerType ?? "")) return false;
  return [408, 429, 500, 502, 503, 504].includes(error.httpStatus ?? 0);
}

export function retryDelay(attempt: number, error: unknown, random = Math.random): number {
  const backoff = Math.floor(Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + random() * 0.5));
  const hint = error instanceof LlmError ? error.retryAfterMs : undefined;
  return Math.max(backoff, hint !== undefined && Number.isFinite(hint) && hint >= 0 ? hint : 0);
}

/** Native errors/messages can echo prompts or credentials; never persist them. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) return { code: error.code, message: error.message, retryable: false };
  if (!(error instanceof LlmError)) return { code: "internal_error", message: "Job execution failed.", retryable: false };
  return {
    code: error.kind, provider: error.provider, message: `Provider request failed (${error.kind}).`,
    httpStatus: error.httpStatus, retryable: isRetryable(error),
  };
}
