import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@llm-providers/contracts";
import { buildResponseRequest, type ChatGptModelId } from "../src/index.js";

const modelId = "gpt-5.6-sol";
const tools = [
  {
    type: "function", name: "weather", description: "Get weather",
    parameters: { type: "object" }, outputSchema: { type: "string" },
  },
  {
    type: "custom", name: "exec", description: "Run code",
    format: { syntax: "lark", definition: "start: /.+/" },
  },
] as const satisfies readonly ToolDefinition[];

describe("buildResponseRequest", () => {
  it("owns model, input, instructions and stream while preserving other options", () => {
    const providerOptions = Object.freeze({
      model: "bypass", input: ["bypass"], instructions: "bypass", stream: false,
      store: true, include: ["other"],
      temperature: 0.2, reasoning: { effort: "high" },
    });
    expect(buildResponseRequest({
      modelId, instructions: "Be concise", providerOptions,
      messages: [
        { role: "system", content: [{ type: "text", text: "Be helpful" }] },
        {
          role: "user", timestamp: 1, metadata: { local: true },
          content: [
            { type: "text", text: "Describe this", metadata: { local: true } },
            { type: "image", url: "https://example.com/image.png" },
          ],
        },
      ],
    })).toEqual({
      model: modelId, instructions: "Be concise", temperature: 0.2, reasoning: { effort: "high" },
      store: false, stream: true, include: ["reasoning.encrypted_content"],
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Be helpful" }] },
        {
          type: "message", role: "user", content: [
            { type: "input_text", text: "Describe this" },
            { type: "input_image", image_url: "https://example.com/image.png", detail: "auto" },
          ],
        },
      ],
    });
  });

  it("defaults instructions and forces backend fields when options are omitted", () => {
    expect(buildResponseRequest({
      modelId, messages: [], providerOptions: {
        instructions: "override", tools: [], codex_responses_lite: false, codex_remote_compaction_v2: false,
      },
    })).toEqual({
      model: modelId, input: [], instructions: "You are a helpful assistant.",
      store: false, stream: true, include: ["reasoning.encrypted_content"],
    });
  });

  it("merges hosted tools before portable function and grammar tools", () => {
    const body = buildResponseRequest({
      modelId, messages: [], tools, providerOptions: { tools: [{ type: "web_search" }] },
    });
    expect(body.tools).toEqual([
      { type: "web_search" },
      { type: "function", name: "weather", description: "Get weather", parameters: { type: "object" }, strict: null },
      { type: "custom", name: "exec", description: "Run code", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
    ]);
  });

  it("replays native assistant and custom items in order without validating their payloads", () => {
    const reasoning = { type: "reasoning", encrypted_content: "opaque", future_field: true };
    const call = { type: "function_call", call_id: "call-1", name: "native_tool", arguments: "{}" };
    const custom = { arbitrary: "caller-owned" };
    const body = buildResponseRequest({
      modelId, messages: [
        { role: "assistant", provider: "chatgpt", content: [reasoning, call] },
        { role: "custom", tag: "chatgpt_custom_item", data: { content: [custom, null] } },
      ],
    });
    expect(body.input).toEqual([reasoning, call, custom, null]);
    expect(body.input[0]).toBe(reasoning);
    expect(body.input[2]).toBe(custom);
  });

  it("passes a native compaction trigger while keeping transport options out of the body", () => {
    const trigger = { type: "compaction_trigger" };
    const body = buildResponseRequest({
      modelId,
      messages: [{ role: "custom", tag: "chatgpt_custom_item", data: { content: [trigger] } }],
      providerOptions: { codex_remote_compaction_v2: true },
    });
    expect(body.input).toEqual([trigger]);
    expect(body).not.toHaveProperty("codex_remote_compaction_v2");
  });

  it("maps text and multimodal tool results using the matching definition", () => {
    const body = buildResponseRequest({
      modelId, tools, messages: [
        {
          role: "tool_result", toolName: "weather", toolCallId: "call-1",
          outcome: { status: "error", error: { message: "internal error" } },
          content: [{ type: "text", text: "Unavailable" }, { type: "text", text: "Try later" }],
        },
        {
          role: "tool_result", toolName: "exec", toolCallId: "call-2", outcome: { status: "success" },
          content: [{ type: "text", text: "Result" }, { type: "image", url: "https://example.com/result.png", detail: "high" }],
        },
      ],
    });
    expect(body.input).toEqual([
      { type: "function_call_output", call_id: "call-1", output: "Unavailable\nTry later" },
      {
        type: "custom_tool_call_output", call_id: "call-2", output: [
          { type: "input_text", text: "Result" },
          { type: "input_image", image_url: "https://example.com/result.png", detail: "high" },
        ],
      },
    ]);
  });

  it("uses the Lite prefix and removes image details without mutating native data", () => {
    const image = Object.freeze({ type: "input_image", image_url: "https://example.com/native.png", detail: "original" });
    const nativeMessage = Object.freeze({ type: "message", role: "user", content: Object.freeze([image]) });
    const outputs = ["function_call_output", "custom_tool_call_output"].map((type) =>
      Object.freeze({ type, call_id: type, output: Object.freeze([image]) }));
    const body = buildResponseRequest({
      modelId, instructions: "Be concise", tools,
      providerOptions: { codex_responses_lite: true, tools: [{ type: "web_search" }] },
      messages: [
        { role: "user", content: [{ type: "image", url: "https://example.com/user.png", detail: "low" }] },
        { role: "assistant", provider: "chatgpt", content: [nativeMessage] },
        { role: "custom", tag: "chatgpt_custom_item", data: { content: outputs } },
      ],
    });
    const standard = buildResponseRequest({ modelId, messages: [], tools, providerOptions: { tools: [{ type: "web_search" }] } });
    expect(body.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", description: "", tools: standard.tools }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Be concise" }] },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/user.png" }] },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: image.image_url }] },
      ...outputs.map(({ type, call_id }) => ({ type, call_id, output: [{ type: "input_image", image_url: image.image_url }] })),
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("codex_responses_lite");
    expect(image.detail).toBe("original");
  });

  it("rejects unsupported models, assistant providers, tags and missing tool definitions", () => {
    expect(() => buildResponseRequest({ modelId: "unknown" as ChatGptModelId, messages: [] })).toThrow("Unsupported ChatGPT model");
    expect(() => buildResponseRequest({ modelId, messages: [{ role: "assistant", provider: "openai", content: [] }] })).toThrow("Cannot replay openai");
    expect(() => buildResponseRequest({ modelId, messages: [{ role: "custom", tag: "application", data: {} }] })).toThrow("Unsupported ChatGPT custom message tag");
    expect(() => buildResponseRequest({ modelId, messages: [{ role: "tool_result", toolName: "missing", toolCallId: "call-1", content: [], outcome: { status: "success" } }] })).toThrow("Missing tool definition");
  });

  it.each([
    { tools: {} }, { tools: null }, { codex_responses_lite: "true" }, { codex_responses_lite: null },
    { codex_remote_compaction_v2: "true" }, { codex_remote_compaction_v2: null },
  ])("rejects invalid special options: %j", (providerOptions) => {
    expect(() => buildResponseRequest({ modelId, messages: [], providerOptions })).toThrow(/must be (an array|a boolean)/);
  });
  it("does not insert default instructions in Lite mode", () => {
    expect(buildResponseRequest({
      modelId, messages: [],
      providerOptions: { codex_responses_lite: true, instructions: "override", stream: false, store: true, include: ["other"] },
    })).toEqual({
      model: modelId, input: [], store: false, stream: true, include: ["reasoning.encrypted_content"],
    });
  });

  it.each([64, null, undefined])("rejects max_output_tokens whenever supplied: %s", (value) => {
    expect(() => buildResponseRequest({
      modelId, messages: [], providerOptions: { max_output_tokens: value },
    })).toThrow("ChatGPT backend does not support providerOptions.max_output_tokens.");
  });
});
