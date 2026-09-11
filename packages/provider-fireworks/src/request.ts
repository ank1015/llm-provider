import type {
  ContentPart,
  Message,
  ProviderOptions,
  ToolDefinition,
  ToolResultMessage,
} from "@llm-providers/contracts";
import { FIREWORKS_MODELS, type FireworksModelId } from "./models.js";
import { invalidRequest } from "./errors.js";

export const FIREWORKS_CUSTOM_ITEM_TAG = "fireworks_custom_item";

/** Builds the JSON body for a non-streaming Fireworks Chat Completions request. */
export function buildChatCompletionRequest({
  modelId,
  instructions,
  messages,
  tools = [],
  providerOptions = {},
}: {
  modelId: FireworksModelId;
  instructions?: string;
  messages: readonly Message[];
  tools?: readonly ToolDefinition[];
  providerOptions?: ProviderOptions;
}): { model: FireworksModelId; messages?: unknown[]; [key: string]: unknown } {
  if (!FIREWORKS_MODELS.some((model) => model.id === modelId)) {
    throw invalidRequest(`Unsupported Fireworks model: ${modelId}.`);
  }
  if (providerOptions.service_tier === "priority") {
    throw invalidRequest("Fireworks priority service tier is unsupported because the catalog uses standard-tier pricing.");
  }
  if ("codex_responses_lite" in providerOptions) {
    throw invalidRequest("Fireworks Chat Completions does not support providerOptions.codex_responses_lite.");
  }

  const options = { ...providerOptions };
  for (const key of ["model", "messages", "tools", "stream", "n"]) {
    delete options[key];
  }

  const mappedTools = tools.map(mapTool);
  const mappedMessages: unknown[] = [];
  if (!("prompt_token_ids" in options)) {
    if (instructions !== undefined) {
      mappedMessages.push({ role: "system", content: instructions });
    }
    mappedMessages.push(...messages.flatMap((message) => mapMessage(message, tools)));
  }

  return {
    ...options,
    model: modelId,
    stream: false,
    n: 1,
    ...("prompt_token_ids" in options ? {} : { messages: mappedMessages }),
    ...(mappedTools.length ? { tools: mappedTools } : {}),
  };
}

function mapTool(tool: ToolDefinition) {
  if (tool.type === "custom") {
    throw invalidRequest(`Fireworks Chat Completions does not support portable custom tool: ${tool.name}.`);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

function mapMessage(message: Message, tools: readonly ToolDefinition[]): readonly unknown[] {
  switch (message.role) {
    case "user":
    case "system":
      return [{ role: message.role, content: message.content.map(mapContent) }];
    case "assistant":
      if (message.provider !== "fireworks") {
        throw invalidRequest(`Cannot replay ${message.provider} assistant content with Fireworks.`);
      }
      return message.content;
    case "tool_result":
      return [mapToolResult(message, tools)];
    case "custom":
      if (message.tag !== FIREWORKS_CUSTOM_ITEM_TAG) {
        throw invalidRequest(`Unsupported Fireworks custom message tag: ${message.tag}.`);
      }
      return (message.data as { content: readonly unknown[] }).content;
  }
}

function mapContent(part: ContentPart) {
  if (part.type === "text") return { type: "text", text: part.text };
  const detail = part.detail === "original" ? "high" : part.detail;
  return {
    type: "image_url",
    image_url: {
      url: part.url,
      ...(detail !== undefined && detail !== "auto" ? { detail } : {}),
    },
  };
}

function mapToolResult(message: ToolResultMessage, tools: readonly ToolDefinition[]) {
  if (!tools.some((tool) => tool.name === message.toolName)) {
    throw invalidRequest(`Missing tool definition for Fireworks tool result: ${message.toolName}.`);
  }
  const content = message.content.every((part) => part.type === "text")
    ? message.content.map((part) => part.text).join("\n")
    : message.content.map(mapContent);
  return { role: "tool", tool_call_id: message.toolCallId, content };
}
