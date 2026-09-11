import { LlmError } from "@llm-providers/contracts";
import type { AssistantResponse, Model, StopReason, Usage } from "@llm-providers/contracts";
import { calculateUsageCost } from "./cost.js";
import { CHATGPT_MODELS, type ChatGptModelId } from "./models.js";
import { invalidResponse } from "./errors.js";

interface NativeError {
  message?: string;
  code?: string;
  type?: string;
}

interface NativeEvent extends NativeError {
  response?: NativeResponse;
  error?: NativeError | null;
  item?: unknown;
}

interface NativeResponse {
  id?: string;
  object?: string;
  model?: string;
  status?: string;
  output?: readonly unknown[];
  incomplete_details?: { reason?: string } | null;
  error?: NativeError | null;
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

const TERMINAL_EVENTS = new Set([
  "response.completed", "response.incomplete", "response.done", "response.failed", "error",
]);

export function isTerminalEvent(event: unknown): boolean {
  return TERMINAL_EVENTS.has((event as NativeEvent | null)?.type ?? "");
}

/** Converts parsed SSE events into one response, preserving native output for replay. */
export function convertResponseEvents({
  events,
  modelId,
  durationMs,
  timestamp,
}: {
  events: readonly unknown[];
  modelId: ChatGptModelId;
  durationMs: number;
  timestamp: number;
}): AssistantResponse<"chatgpt"> {
  const model = CHATGPT_MODELS.find((model) => model.id === modelId);
  if (!model) {
    throw new LlmError(`Unsupported ChatGPT model: ${modelId}.`, { provider: "chatgpt", kind: "invalid_request" });
  }

  const nativeEvents = events as readonly NativeEvent[];
  const terminalIndex = nativeEvents.findIndex(isTerminalEvent);
  if (terminalIndex === -1) {
    throw invalidResponse("ChatGPT stream ended before a terminal response event.");
  }
  const terminal = nativeEvents[terminalIndex]!;
  const response = terminal.response;
  if (terminal.type === "error" || terminal.type === "response.failed"
    || response?.status === "failed" || response?.error != null) {
    const error = terminal.error ?? response?.error ?? terminal;
    throw new LlmError(error.message ?? "ChatGPT response failed.", {
      provider: "chatgpt",
      kind: "provider_error",
      providerCode: error.code,
      providerType: error === terminal ? undefined : error.type,
      nativeError: terminal,
    });
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw invalidResponse("ChatGPT terminal event must contain a response object.", terminal);
  }
  const status = terminal.type === "response.incomplete" ? "incomplete"
    : response.status === undefined && terminal.type === "response.done" ? "completed" : response.status;
  if (status === "cancelled") {
    throw new LlmError("ChatGPT response was cancelled.", {
      provider: "chatgpt", kind: "cancelled", nativeError: terminal,
    });
  }
  if (status !== "completed" && status !== "incomplete") {
    throw invalidResponse(`Expected a completed or incomplete ChatGPT response; received ${status}.`, terminal);
  }

  const precedingEvents = nativeEvents.slice(0, terminalIndex + 1);
  const id = response.id === undefined
    ? precedingEvents.find((event) => typeof event?.response?.id === "string")?.response?.id : response.id;
  const resolvedModel = response.model === undefined ? modelId : response.model;
  if ((response.object !== undefined && response.object !== "response")
    || typeof id !== "string" || !id.trim() || typeof resolvedModel !== "string" || !resolvedModel.trim()) {
    throw invalidResponse("ChatGPT response requires a response object with nonempty id and model strings.", terminal);
  }
  const output = Array.isArray(response.output) && response.output.length > 0 ? response.output
    : precedingEvents.filter((event) => event?.type === "response.output_item.done" && event.item !== undefined)
      .map((event) => event.item);

  return {
    id,
    modelId,
    ...(resolvedModel !== modelId ? { resolvedModelId: resolvedModel } : {}),
    message: { role: "assistant", provider: "chatgpt", id, timestamp, content: output },
    stopReason: stopReason(status, response.incomplete_details?.reason, output),
    ...(response.usage != null ? { usage: mapUsage(response.usage, model) } : {}),
    durationMs,
    timestamp,
  };
}

function stopReason(status: string, incompleteReason: string | undefined, output: readonly unknown[]): StopReason {
  if (status === "incomplete") {
    return incompleteReason === "content_filter" ? "content_filter" : "length";
  }
  const items = output as readonly { type?: string; content?: unknown }[];
  if (items.some((item) => item?.type === "function_call" || item?.type === "custom_tool_call")) {
    return "tool_use";
  }
  if (items.some((item) => item?.type === "message" && Array.isArray(item.content)
    && item.content.some((part) => part?.type === "refusal"))) {
    return "refusal";
  }
  return "stop";
}

function mapUsage(native: NativeUsage, model: Model<"chatgpt">): Usage {
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
