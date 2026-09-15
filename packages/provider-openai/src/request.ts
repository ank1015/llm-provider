import type {
  ContentPart,
  Message,
  ProviderOptions,
  ToolDefinition,
  ToolResultMessage,
} from "@llm-providers/contracts";
import { OPENAI_MODELS, type OpenAiModelId } from "./models.js";
import { invalidRequest } from "./errors.js";

export const OPENAI_CUSTOM_ITEM_TAG = "openai_custom_item";
export const CODEX_RESPONSES_LITE_OPTION = "codex_responses_lite";
export const CODEX_REMOTE_COMPACTION_V2_OPTION = "codex_remote_compaction_v2";

/** Builds the JSON body for a non-streaming Responses API request. */
export function buildResponseRequest({
  modelId,
  instructions,
  messages,
  tools = [],
  providerOptions = {},
}: {
  modelId: OpenAiModelId;
  instructions?: string;
  messages: readonly Message[];
  tools?: readonly ToolDefinition[];
  providerOptions?: ProviderOptions;
}): { model: OpenAiModelId; input: unknown[]; [key: string]: unknown } {
  if (!OPENAI_MODELS.some((model) => model.id === modelId)) {
    throw invalidRequest(`Unsupported OpenAI model: ${modelId}.`);
  }

  const options = { ...providerOptions };
  if (options.background === true) {
    throw invalidRequest("OpenAI background responses are unsupported by this synchronous adapter.");
  }
  const responsesLite = options[CODEX_RESPONSES_LITE_OPTION];
  if (responsesLite !== undefined && typeof responsesLite !== "boolean") {
    throw invalidRequest(`providerOptions.${CODEX_RESPONSES_LITE_OPTION} must be a boolean.`);
  }
  const remoteCompaction = options[CODEX_REMOTE_COMPACTION_V2_OPTION];
  if (remoteCompaction !== undefined && typeof remoteCompaction !== "boolean") {
    throw invalidRequest(`providerOptions.${CODEX_REMOTE_COMPACTION_V2_OPTION} must be a boolean.`);
  }
  const hostedTools = options.tools;
  if (hostedTools !== undefined && !Array.isArray(hostedTools)) {
    throw invalidRequest("providerOptions.tools must be an array.");
  }
  for (const key of [
    "model", "input", "instructions", "stream", "tools",
    CODEX_RESPONSES_LITE_OPTION, CODEX_REMOTE_COMPACTION_V2_OPTION,
  ]) {
    delete options[key];
  }

  const mappedTools = [...(hostedTools ?? []), ...tools.map(mapTool)];
  let input = messages.flatMap((message) => mapMessage(message, tools));

  if (responsesLite) {
    input = input.map(stripImageDetails);
    const prefix: unknown[] = [];
    if (mappedTools.length) {
      prefix.push({
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "namespace", name: "functions", description: "", tools: mappedTools }],
      });
    }
    if (instructions !== undefined) {
      prefix.push({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: instructions }],
      });
    }
    input = [...prefix, ...input];
  } else {
    if (instructions !== undefined) options.instructions = instructions;
    if (mappedTools.length) options.tools = mappedTools;
  }

  return { ...options, model: modelId, input };
}

function mapTool(tool: ToolDefinition) {
  if (tool.type === "function") {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict ?? null,
    };
  }
  return {
    type: "custom",
    name: tool.name,
    description: tool.description,
    format: { type: "grammar", syntax: tool.format.syntax, definition: tool.format.definition },
  };
}

function mapMessage(message: Message, tools: readonly ToolDefinition[]): readonly unknown[] {
  switch (message.role) {
    case "user":
    case "system":
      return [{
        type: "message",
        role: message.role === "system" ? "developer" : "user",
        content: message.content.map(mapContent),
      }];
    case "assistant":
      if (message.provider !== "openai") {
        throw invalidRequest(`Cannot replay ${message.provider} assistant content with OpenAI.`);
      }
      return message.content;
    case "tool_result":
      return [mapToolResult(message, tools)];
    case "custom":
      if (message.tag !== OPENAI_CUSTOM_ITEM_TAG) {
        throw invalidRequest(`Unsupported OpenAI custom message tag: ${message.tag}.`);
      }
      return (message.data as { content: readonly unknown[] }).content;
  }
}

function mapContent(part: ContentPart) {
  if (part.type === "text") return { type: "input_text", text: part.text };
  return { type: "input_image", image_url: part.url, detail: part.detail ?? "auto" };
}

function mapToolResult(message: ToolResultMessage, tools: readonly ToolDefinition[]) {
  const tool = tools.find((tool) => tool.name === message.toolName);
  if (!tool) throw invalidRequest(`Missing tool definition for OpenAI tool result: ${message.toolName}.`);

  const output = message.content.every((part) => part.type === "text")
    ? message.content.map((part) => part.text).join("\n")
    : message.content.map(mapContent);
  return {
    type: tool.type === "function" ? "function_call_output" : "custom_tool_call_output",
    call_id: message.toolCallId,
    output,
  };
}

/** Lite omits per-image detail hints, including native items, without mutating caller data. */
function stripImageDetails(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  const key = item.type === "message" ? "content"
    : item.type === "function_call_output" || item.type === "custom_tool_call_output" ? "output"
    : undefined;
  if (!key || !Array.isArray(item[key])) return value;

  return {
    ...item,
    [key]: item[key].map((value: unknown) => {
      if (!value || typeof value !== "object") return value;
      const part = value as Record<string, unknown>;
      if (part.type !== "input_image") return value;
      const { detail, ...image } = part;
      return image;
    }),
  };
}
