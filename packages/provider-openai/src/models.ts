import type { Model } from "@llm-providers/contracts";

// Generated from the ANK model catalog. Do not edit pricing inline.
export const OPENAI_MODELS = [
  {
    provider: "openai",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    pricing: {
      base: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      above: {
        promptTokens: 272_000,
        cost: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
      },
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  {
    provider: "openai",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    pricing: {
      base: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      above: {
        promptTokens: 272_000,
        cost: { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
      },
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  {
    provider: "openai",
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    pricing: {
      base: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
      above: {
        promptTokens: 272_000,
        cost: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
      },
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  {
    provider: "openai",
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    pricing: {
      base: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
      above: {
        promptTokens: 272_000,
        cost: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
      },
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
] as const satisfies readonly Model<"openai">[];

export type OpenAiModelId = (typeof OPENAI_MODELS)[number]["id"];
