export type Provider = "openai" | "chatgpt" | "fireworks";

/** Per-million-token prices in USD. */
export interface ModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Long-context pricing applied above a prompt-token threshold. */
export interface ModelPricingAbove {
  readonly promptTokens: number;
  readonly cost: ModelCost;
}

/** Model pricing with an optional long-context override. */
export interface ModelPricing {
  readonly base: ModelCost;
  readonly above: ModelPricingAbove | null;
}

/** A model owned by a specific provider. */
export interface Model<P extends Provider = Provider> {
  readonly provider: P;
  readonly id: string;
  readonly name: string;
  readonly pricing: ModelPricing;
  readonly contextWindow: number;
  readonly maxTokens: number;
}
