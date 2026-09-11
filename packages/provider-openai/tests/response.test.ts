import { describe, expect, it } from "vitest";
import { LlmError } from "@llm-providers/contracts";
import { buildResponseRequest, convertResponse, type OpenAiModelId } from "../src/index.js";

const modelId = "gpt-5.6-sol";
const context = { modelId, durationMs: 1200, timestamp: 123456 } as const;
const native = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "resp_1", object: "response", model: modelId, status: "completed", output: [], ...fields,
});

describe("convertResponse", () => {
  it("preserves output unchanged and produces a message ready for request replay", () => {
    const output = Object.freeze([
      Object.freeze({ type: "reasoning", encrypted_content: "opaque", future: true }),
      Object.freeze({ type: "message", content: [{ type: "output_text", text: "Hello" }] }),
      Object.freeze({ type: "future_item", payload: { anything: true } }),
      null,
    ]);
    const source = Object.freeze(native({ output, instructions: "Large echoed prompt", tools: ["echoed"] }));
    const result = convertResponse({ ...context, nativeResponse: source });
    expect(result).toEqual({
      id: "resp_1", modelId, stopReason: "stop", durationMs: 1200, timestamp: 123456,
      message: { role: "assistant", provider: "openai", id: "resp_1", timestamp: 123456, content: output },
    });
    expect(result.message.content).toBe(output);
    expect(source.instructions).toBe("Large echoed prompt");
    expect(buildResponseRequest({ modelId, messages: [result.message] }).input).toEqual(output);
  });

  it("records a differing resolved model without replacing the selected model ID", () => {
    const result = convertResponse({ ...context, nativeResponse: native({ model: "resolved-snapshot" }) });
    expect(result.modelId).toBe(modelId);
    expect(result.resolvedModelId).toBe("resolved-snapshot");
  });

  it.each(["function_call", "custom_tool_call"])("detects %s without parsing arguments", (type) => {
    const output = [{ type, arguments: "not JSON", input: "raw text" }];
    const result = convertResponse({ ...context, nativeResponse: native({ output }) });
    expect(result.stopReason).toBe("tool_use");
    expect(result.message.content).toBe(output);
  });

  it.each([
    ["max_output_tokens", "length"], ["content_filter", "content_filter"], ["unknown_reason", "length"],
  ])("prioritizes incomplete reason %s over tool calls", (reason, expected) => {
    const result = convertResponse({ ...context, nativeResponse: native({
      status: "incomplete", incomplete_details: { reason }, output: [{ type: "function_call" }],
    }) });
    expect(result.stopReason).toBe(expected);
  });

  it("detects refusal and does not treat hosted tool activity as a caller tool request", () => {
    const result = convertResponse({ ...context, nativeResponse: native({ output: [
      { type: "web_search_call" },
      { type: "message", content: [{ type: "refusal", refusal: "Cannot help" }] },
    ] }) });
    expect(result.stopReason).toBe("refusal");
  });

  it("maps disjoint token buckets and prices them using total prompt length", () => {
    const result = convertResponse({ ...context, modelId: "gpt-5.6-luna", nativeResponse: native({
      model: "gpt-5.6-luna",
      usage: {
        input_tokens: 1_000_000, output_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 },
        output_tokens_details: { reasoning_tokens: 250_000 },
      },
    }) });
    expect(result.usage).toMatchObject({ input: 850_000, output: 1_000_000, cacheRead: 100_000, cacheWrite: 50_000 });
    expect(result.usage?.cost).toMatchObject({ input: 0.34, output: 1.8, cacheRead: 0.004, cacheWrite: 0.025 });
    expect(result.usage?.cost?.total).toBeCloseTo(2.169);
  });

  it.each([[272_000, 4], [272_001, 8]])("uses the correct input rate at %i prompt tokens", (tokens, rate) => {
    const result = convertResponse({ ...context, nativeResponse: native({ usage: {
      input_tokens: tokens, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    } }) });
    expect(result.usage?.cost?.input).toBeCloseTo(tokens * rate / 1_000_000);
  });

  it("selects the long-context tier even when nearly all input is cached", () => {
    const result = convertResponse({ ...context, nativeResponse: native({ usage: {
      input_tokens: 300_000, output_tokens: 0, input_tokens_details: { cached_tokens: 299_999, cache_write_tokens: 0 },
    } }) });
    expect(result.usage?.input).toBe(1);
    expect(result.usage?.cost?.input).toBe(8 / 1_000_000);
  });

  it.each([undefined, null])("omits unavailable usage: %s", (usage) => {
    expect(convertResponse({ ...context, nativeResponse: native({ usage }) })).not.toHaveProperty("usage");
  });

  it("does not assume missing cache counters are zero or produce a partial total cost", () => {
    const result = convertResponse({ ...context, nativeResponse: native({ usage: {
      input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 },
    } }) });
    expect(result.usage).toEqual({ output: 20, cacheRead: 10 });
  });

  it("preserves explicit zero counts and calculates zero cost", () => {
    const result = convertResponse({ ...context, nativeResponse: native({ usage: {
      input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    } }) });
    expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("does not estimate cost from inconsistent or invalid counts", () => {
    const result = convertResponse({ ...context, nativeResponse: native({ usage: {
      input_tokens: 10, output_tokens: -1, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
    } }) });
    expect(result.usage).toEqual({ cacheRead: 20, cacheWrite: 0 });
  });

  it("retains provider error details even when the failed response lacks output", () => {
    const source = { object: "response", status: "failed", error: { message: "Busy", code: "server_error", type: "server_error" } };
    expect(() => convertResponse({ ...context, nativeResponse: source })).toThrow(LlmError);
    try {
      convertResponse({ ...context, nativeResponse: source });
    } catch (error) {
      expect(error).toMatchObject({ message: "Busy", provider: "openai", kind: "provider_error", providerCode: "server_error", providerType: "server_error", nativeError: source });
      expect(error).not.toHaveProperty("canRetry");
    }
  });

  it.each([
    { status: "failed" }, { error: { message: "Rejected" } },
  ])("rejects failed status or a populated error: %j", (fields) => {
    expect(() => convertResponse({ ...context, nativeResponse: native(fields) })).toThrow(LlmError);
  });

  it("classifies provider cancellation separately", () => {
    try {
      convertResponse({ ...context, nativeResponse: native({ status: "cancelled" }) });
      expect.fail("Expected cancellation error");
    } catch (error) {
      expect(error).toMatchObject({ provider: "openai", kind: "cancelled" });
    }
  });

  it.each(["queued", "in_progress", "unexpected", undefined])("rejects unsupported status: %s", (status) => {
    expect(() => convertResponse({ ...context, nativeResponse: native({ status }) })).toThrow("Expected a completed or incomplete");
  });

  it.each([null, {}, native({ id: " " }), native({ model: "" }), native({ output: {} })])("rejects unusable envelopes: %j", (nativeResponse) => {
    expect(() => convertResponse({ ...context, nativeResponse })).toThrow(LlmError);
  });

  it("rejects unknown selected models", () => {
    expect(() => convertResponse({ ...context, modelId: "unknown" as OpenAiModelId, nativeResponse: native() })).toThrow("Unsupported OpenAI model");
  });
});
