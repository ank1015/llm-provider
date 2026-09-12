import { describe, expect, it } from "vitest";
import type { FunctionTool, ImageDetail, ToolResultOutcome } from "@llm-providers/contracts";
import { buildChatCompletionRequest, type FireworksModelId } from "../src/index.js";

const modelId = "accounts/fireworks/models/deepseek-v4p1-flash";
const tool: FunctionTool = {
  type: "function", name: "weather", description: "Get weather",
  parameters: { type: "object" }, outputSchema: { type: "string" },
};

describe("buildChatCompletionRequest", () => {
  it("owns model, messages, tools, stream and n while preserving other options", () => {
    const providerOptions = Object.freeze({
      model: "bypass", messages: ["bypass"], tools: [{ type: "web_search" }],
      stream: true, n: 8, max_tokens: 1024, reasoning_effort: "high", prompt_cache_key: "session-1",
    });
    expect(buildChatCompletionRequest({
      modelId, instructions: "Be concise", providerOptions,
      messages: [
        { role: "system", content: [{ type: "text", text: "Be helpful" }] },
        {
          role: "user", timestamp: 1, metadata: { local: true },
          content: [
            { type: "text", text: "Describe this", metadata: { local: true } },
            { type: "image", url: "https://example.com/image.png", detail: "original" },
          ],
        },
      ],
    })).toEqual({
      model: modelId, stream: false, n: 1,
      max_tokens: 1024, reasoning_effort: "high", prompt_cache_key: "session-1",
      messages: [
        { role: "system", content: "Be concise" },
        { role: "system", content: [{ type: "text", text: "Be helpful" }] },
        { role: "user", content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "high" } },
        ] },
      ],
    });
  });

  it("omits optional tools and instruction messages", () => {
    expect(buildChatCompletionRequest({ modelId, messages: [] })).toEqual({
      model: modelId, stream: false, n: 1, messages: [],
    });
  });

  it.each([undefined, "auto", "low", "high", "original"] as const)("maps image detail %s", (detail: ImageDetail | undefined) => {
    const body = buildChatCompletionRequest({ modelId, messages: [
      { role: "user", content: [{ type: "image", url: "https://example.com/image.png", detail }] },
    ] });
    expect(body.messages).toEqual([{ role: "user", content: [{
      type: "image_url", image_url: {
        url: "https://example.com/image.png",
        ...(detail === "low" ? { detail: "low" } : detail === "high" || detail === "original" ? { detail: "high" } : {}),
      },
    }] }]);
  });

  it.each([undefined, false, true])("nests function tools and preserves optional strict: %s", (strict) => {
    const body = buildChatCompletionRequest({ modelId, messages: [], tools: [{ ...tool, strict }] });
    expect(body.tools).toEqual([{ type: "function", function: {
      name: "weather", description: "Get weather", parameters: { type: "object" },
      ...(strict !== undefined ? { strict } : {}),
    } }]);
  });

  it("replays native assistant and custom messages unchanged and in order", () => {
    const native = Object.freeze({ role: "assistant", content: null, reasoning_content: "opaque", tool_calls: [{ id: "call-1", type: "function", function: { name: "native", arguments: "{}" } }] });
    const custom = Object.freeze({ arbitrary: "caller-owned" });
    const body = buildChatCompletionRequest({ modelId, messages: [
      { role: "assistant", provider: "fireworks", content: [native] },
      { role: "custom", tag: "fireworks_custom_item", data: { content: [custom, null] } },
    ] });
    expect(body.messages).toEqual([native, custom, null]);
    expect(body.messages?.[0]).toBe(native);
    expect(body.messages?.[1]).toBe(custom);
  });

  it.each([
    { status: "success" },
    { status: "error", error: { message: "Internal error" } },
  ] satisfies ToolResultOutcome[])("keeps result text unchanged for outcome $status", (outcome) => {
    const body = buildChatCompletionRequest({ modelId, tools: [tool], messages: [{
      role: "tool_result", toolName: "weather", toolCallId: "call-1", outcome,
      details: { local: true }, content: [
        { type: "text", text: "Weather service unavailable." },
        { type: "text", text: "Please try again later." },
      ],
    }] });
    expect(body.messages).toEqual([{
      role: "tool", tool_call_id: "call-1", content: "Weather service unavailable.\nPlease try again later.",
    }]);
  });

  it("preserves mixed text and images in a tool result", () => {
    const body = buildChatCompletionRequest({ modelId, tools: [tool], messages: [{
      role: "tool_result", toolName: "weather", toolCallId: "call-1", outcome: { status: "success" },
      content: [{ type: "text", text: "Map" }, { type: "image", url: "https://example.com/map.png" }],
    }] });
    expect(body.messages).toEqual([{ role: "tool", tool_call_id: "call-1", content: [
      { type: "text", text: "Map" }, { type: "image_url", image_url: { url: "https://example.com/map.png" } },
    ] }]);
  });

  it.each([{ prompt_token_ids: [1, 2, 3] }, { prompt_token_ids: [] }, { prompt_token_ids: null }, { prompt_token_ids: undefined }])("rejects the tokenized-prompt option: %j", (providerOptions) => {
    expect(() => buildChatCompletionRequest({
      modelId, messages: [], providerOptions,
    })).toThrow("does not support providerOptions.prompt_token_ids");
  });

  it("rejects unsupported models, providers, tags and missing tool definitions", () => {
    expect(() => buildChatCompletionRequest({ modelId: "unknown" as FireworksModelId, messages: [] })).toThrow("Unsupported Fireworks model");
    expect(() => buildChatCompletionRequest({ modelId, messages: [{ role: "assistant", provider: "openai", content: [] }] })).toThrow("Cannot replay openai");
    expect(() => buildChatCompletionRequest({ modelId, messages: [{ role: "custom", tag: "application", data: {} }] })).toThrow("Unsupported Fireworks custom message tag");
    expect(() => buildChatCompletionRequest({ modelId, messages: [{ role: "tool_result", toolName: "missing", toolCallId: "call-1", content: [], outcome: { status: "success" } }] })).toThrow("Missing tool definition");
  });

  it("rejects custom grammar tools", () => {
    expect(() => buildChatCompletionRequest({ modelId, messages: [], tools: [{
      type: "custom", name: "exec", description: "Run code", format: { syntax: "lark", definition: "start: /.+/" },
    }] })).toThrow("does not support portable custom tool");
  });

  it("rejects priority pricing but passes the standard tier through", () => {
    expect(() => buildChatCompletionRequest({ modelId, messages: [], providerOptions: { service_tier: "priority" } })).toThrow("standard-tier pricing");
    expect(buildChatCompletionRequest({ modelId, messages: [], providerOptions: { service_tier: "default" } }).service_tier).toBe("default");
  });

  it.each([true, false])("rejects the Responses-Lite option: %s", (enabled) => {
    expect(() => buildChatCompletionRequest({ modelId, messages: [], providerOptions: { codex_responses_lite: enabled } })).toThrow("does not support providerOptions.codex_responses_lite");
  });
});
