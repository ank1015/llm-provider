import { LlmError } from "@llm-providers/contracts";
import type { AssistantResponse, Model, StopReason, Usage } from "@llm-providers/contracts";
import { calculateUsageCost } from "./cost.js";
import { FIREWORKS_MODELS, type FireworksModelId } from "./models.js";

interface NativeResponse {
  id: string;
  object: string;
  model: string;
  choices: NativeChoice[];
  usage?: NativeUsage | null;
  error?: { message?: string; code?: string; type?: string } | null;
}

interface NativeChoice {
  index: number;
  message: { role: string; refusal?: unknown };
  finish_reason?: string | null;
}

interface NativeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Converts a complete Chat Completion, preserving the native assistant message for replay. */
export function convertResponse({
  nativeResponse,
  modelId,
  durationMs,
  timestamp,
}: {
  nativeResponse: unknown;
  modelId: FireworksModelId;
  durationMs: number;
  timestamp: number;
}): AssistantResponse<"fireworks"> {
  const model = FIREWORKS_MODELS.find((model) => model.id === modelId);
  if (!model) {
    throw new LlmError(`Unsupported Fireworks model: ${modelId}.`, { provider: "fireworks", kind: "invalid_request" });
  }

  const response = nativeResponse as NativeResponse | null;
  if (response?.error != null) {
    throw new LlmError(response.error.message ?? "Fireworks response failed.", {
      provider: "fireworks",
      kind: "provider_error",
      providerCode: response.error.code,
      providerType: response.error.type,
      nativeError: nativeResponse,
    });
  }
  if (!response || response.object !== "chat.completion") {
    throw invalidResponse("Fireworks response object must equal `chat.completion`.", nativeResponse);
  }
  if (typeof response.id !== "string" || !response.id.trim()
    || typeof response.model !== "string" || !response.model.trim() || !Array.isArray(response.choices)) {
    throw invalidResponse("Fireworks response requires nonempty id and model strings and a choices array.", nativeResponse);
  }
  const choice = response.choices.find((choice) => choice?.index === 0);
  if (!choice) {
    throw invalidResponse("Fireworks response must contain choice zero.", nativeResponse);
  }
  if (!choice.message || typeof choice.message !== "object" || Array.isArray(choice.message)
    || choice.message.role !== "assistant") {
    throw invalidResponse("Fireworks choice zero must contain an assistant message object.", nativeResponse);
  }

  return {
    id: response.id,
    modelId,
    ...(response.model !== modelId ? { resolvedModelId: response.model } : {}),
    message: {
      role: "assistant",
      provider: "fireworks",
      id: response.id,
      timestamp,
      content: [choice.message],
    },
    stopReason: stopReason(choice, nativeResponse),
    ...(response.usage != null ? { usage: mapUsage(response.usage, model) } : {}),
    durationMs,
    timestamp,
  };
}

function stopReason(choice: NativeChoice, nativeResponse: unknown): StopReason {
  switch (choice.finish_reason) {
    case "stop": return choice.message.refusal != null ? "refusal" : "stop";
    case "length": return "length";
    case "tool_calls":
    case "function_call": return "tool_use";
    case "content_filter": return "content_filter";
    default: throw invalidResponse(`Unsupported Fireworks finish_reason: ${choice.finish_reason}.`, nativeResponse);
  }
}

function mapUsage(native: NativeUsage, model: Model<"fireworks">): Usage {
  const promptTokens = tokenCount(native.prompt_tokens);
  const cacheRead = tokenCount(native.prompt_tokens_details?.cached_tokens);
  const output = tokenCount(native.completion_tokens);
  const input = promptTokens !== undefined && cacheRead !== undefined && cacheRead <= promptTokens
    ? promptTokens - cacheRead : undefined;
  const usage: Usage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
  };
  const cost = calculateUsageCost(usage, model);
  return { ...usage, ...(cost !== undefined ? { cost } : {}) };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function invalidResponse(message: string, nativeError: unknown): LlmError {
  return new LlmError(message, { provider: "fireworks", kind: "invalid_response", nativeError });
}
