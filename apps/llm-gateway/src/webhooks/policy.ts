export const MAX_ATTEMPTS = 8;
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const LEASE_MS = 60_000;

export interface DeliveryResult {
  httpStatus?: number;
  error?: { code: string; message: string; retryable: boolean };
  retryAfterMs?: number;
}

export function retryDelay(attemptInCycle: number, hint = 0, random = Math.random) {
  const backoff = Math.min(3_600_000, 30_000 * 2 ** (attemptInCycle - 1));
  return Math.max(Math.floor(backoff * (0.5 + random() * 0.5)), hint);
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const delay = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}
