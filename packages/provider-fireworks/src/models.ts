import type { Model } from "@llm-providers/contracts";

// Generated from the Fireworks standard serverless catalog. Do not edit pricing inline.
export const FIREWORKS_MODELS = [
  {
    provider: "fireworks",
    id: "accounts/fireworks/models/glm-5p3-flash",
    name: "GLM 5.3 Flash",
    pricing: {
      base: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      above: null,
    },
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
  },
  {
    provider: "fireworks",
    id: "accounts/fireworks/models/glm-5p3",
    name: "GLM 5.3",
    pricing: {
      base: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      above: null,
    },
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
  },
  {
    provider: "fireworks",
    id: "accounts/fireworks/models/kimi-k3",
    name: "Kimi K3",
    pricing: {
      base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      above: null,
    },
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
  },
  {
    provider: "fireworks",
    id: "accounts/fireworks/models/deepseek-v4p1-flash",
    name: "DeepSeek V4.1 Flash",
    pricing: {
      base: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
      above: null,
    },
    contextWindow: 1_048_576,
    maxTokens: 393_216,
  }
] as const satisfies readonly Model<"fireworks">[];

export type FireworksModelId = (typeof FIREWORKS_MODELS)[number]["id"];
