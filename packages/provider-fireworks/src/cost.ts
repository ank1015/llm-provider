import type { Model, Usage, UsageCost } from "@llm-providers/contracts";

/** Estimates standard-tier cost when all three Fireworks usage buckets are known. */
export function calculateUsageCost(usage: Usage, model: Model<"fireworks">): UsageCost | undefined {
  if (usage.input === undefined || usage.output === undefined || usage.cacheRead === undefined) {
    return undefined;
  }

  const rates = model.pricing.base;
  const input = usage.input * rates.input / 1_000_000;
  const output = usage.output * rates.output / 1_000_000;
  const cacheRead = usage.cacheRead * rates.cacheRead / 1_000_000;
  return { input, output, cacheRead, total: input + output + cacheRead };
}
