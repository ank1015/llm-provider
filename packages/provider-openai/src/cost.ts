import type { Model, Usage, UsageCost } from "@llm-providers/contracts";

/** Estimates token costs only when all four usage buckets are known. */
export function calculateUsageCost(
  usage: Usage,
  model: Model<"openai">,
  promptTokens: number,
): UsageCost | undefined {
  if (usage.input === undefined || usage.output === undefined
    || usage.cacheRead === undefined || usage.cacheWrite === undefined) {
    return undefined;
  }

  const above = model.pricing.above;
  const rates = above && promptTokens > above.promptTokens ? above.cost : model.pricing.base;
  const input = usage.input * rates.input / 1_000_000;
  const output = usage.output * rates.output / 1_000_000;
  const cacheRead = usage.cacheRead * rates.cacheRead / 1_000_000;
  const cacheWrite = usage.cacheWrite * rates.cacheWrite / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
