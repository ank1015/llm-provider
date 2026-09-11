/** Unavailable counts are omitted; zero represents a known zero. */
export interface Usage {
  /** Input tokens excluding cache reads and cache writes. */
  readonly input?: number;
  /** Output tokens, including reasoning tokens where the provider counts them. */
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Catalog-based estimate, when sufficient usage and pricing are available. */
  readonly cost?: UsageCost;
}

/** Cost breakdown in USD; omitted buckets are unavailable. */
export interface UsageCost {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly total: number;
}
