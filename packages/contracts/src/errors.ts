import type { Provider } from "./models.js";

export type LlmErrorKind =
  | "invalid_config"
  | "invalid_request"
  | "invalid_response"
  | "provider_error"
  | "network_error"
  | "timeout"
  | "cancelled";

export interface LlmErrorOptions {
  readonly provider: Provider;
  readonly kind: LlmErrorKind;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly httpStatus?: number;
  /** Provider-supplied delay hint; does not imply retry eligibility. */
  readonly retryAfterMs?: number;
  readonly nativeError?: unknown;
}

/** Shared provider error. Retry policy is decided by the client. */
export class LlmError extends Error implements LlmErrorOptions {
  readonly name = "LlmError";
  readonly provider: Provider;
  readonly kind: LlmErrorKind;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly nativeError?: unknown;

  constructor(message: string, options: LlmErrorOptions) {
    super(message);
    this.provider = options.provider;
    this.kind = options.kind;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.nativeError = options.nativeError;
  }
}
