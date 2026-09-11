import { LlmError } from "@llm-providers/contracts";
import type { AssistantResponse, Model, StopReason, Usage } from "@llm-providers/contracts";
import { calculateUsageCost } from "./cost.js";
import { OPENAI_MODELS, type OpenAiModelId } from "./models.js";

interface NativeResponse {
  id: string;
  object: string;
  model: string;
  status: string;
  output: unknown[];
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string; type?: string } | null;
  usage?: NativeUsage | null;
}

interface NativeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  } | null;
}

/** Converts a completed Responses API result while preserving native output for replay. */
export function convertResponse({
  nativeResponse,
  modelId,
  durationMs,
  timestamp,
}: {
  nativeResponse: unknown;
  modelId: OpenAiModelId;
  durationMs: number;
  timestamp: number;
}): AssistantResponse<"openai"> {
  const model = OPENAI_MODELS.find((model) => model.id === modelId);
  if (!model) {
    throw new LlmError(`Unsupported OpenAI model: ${modelId}.`, { provider: "openai", kind: "invalid_request" });
  }

  const response = nativeResponse as NativeResponse | null;
  if (!response || response.object !== "response") {
    throw invalidResponse("OpenAI response object must equal `response`.", nativeResponse);
  }
  if (response.status === "failed" || response.error != null) {
    throw new LlmError(response.error?.message ?? "OpenAI response failed.", {
      provider: "openai",
      kind: "provider_error",
      providerCode: response.error?.code,
      providerType: response.error?.type,
      nativeError: nativeResponse,
    });
  }
  if (response.status === "cancelled") {
    throw new LlmError("OpenAI response was cancelled.", {
      provider: "openai", kind: "cancelled", nativeError: nativeResponse,
    });
  }
  if (response.status !== "completed" && response.status !== "incomplete") {
    throw invalidResponse(`Expected a completed or incomplete OpenAI response; received ${response.status}.`, nativeResponse);
  }
  if (typeof response.id !== "string" || !response.id.trim()
    || typeof response.model !== "string" || !response.model.trim()
    || !Array.isArray(response.output)) {
    throw invalidResponse("OpenAI response requires nonempty id and model strings and an output array.", nativeResponse);
  }

  return {
    id: response.id,
    modelId,
    ...(response.model !== modelId ? { resolvedModelId: response.model } : {}),
    message: {
      role: "assistant",
      provider: "openai",
      id: response.id,
      timestamp,
      content: response.output,
    },
    stopReason: stopReason(response),
    ...(response.usage != null ? { usage: mapUsage(response.usage, model) } : {}),
    durationMs,
    timestamp,
  };
}

function stopReason(response: NativeResponse): StopReason {
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  }
  const items = response.output as { type?: string; content?: unknown }[];
  if (items.some((item) => item?.type === "function_call" || item?.type === "custom_tool_call")) {
    return "tool_use";
  }
  if (items.some((item) => item?.type === "message" && Array.isArray(item.content)
    && item.content.some((part) => part?.type === "refusal"))) {
    return "refusal";
  }
  return "stop";
}

function mapUsage(native: NativeUsage, model: Model<"openai">): Usage {
  const promptTokens = tokenCount(native.input_tokens);
  const cacheRead = tokenCount(native.input_tokens_details?.cached_tokens);
  const cacheWrite = tokenCount(native.input_tokens_details?.cache_write_tokens);
  const output = tokenCount(native.output_tokens);
  const input = promptTokens !== undefined && cacheRead !== undefined && cacheWrite !== undefined
    && cacheRead + cacheWrite <= promptTokens ? promptTokens - cacheRead - cacheWrite : undefined;
  const usage: Usage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
  const cost = promptTokens !== undefined ? calculateUsageCost(usage, model, promptTokens) : undefined;
  return { ...usage, ...(cost !== undefined ? { cost } : {}) };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function invalidResponse(message: string, nativeError: unknown): LlmError {
  return new LlmError(message, { provider: "openai", kind: "invalid_response", nativeError });
}
