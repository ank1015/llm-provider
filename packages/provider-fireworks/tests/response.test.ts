import { describe, expect, it } from "vitest";
import { LlmError } from "@llm-providers/contracts";
import { buildChatCompletionRequest, convertResponse, type FireworksModelId } from "../src/index.js";

const modelId = "accounts/fireworks/models/deepseek-v4p1-flash";
const context = { modelId, durationMs: 1200, timestamp: 123456 } as const;
const choice = (fields: Record<string, unknown> = {}) => ({
  index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop", ...fields,
});
const native = (fields: Record<string, unknown> = {}) => ({
  id: "chatcmpl_123", object: "chat.completion", model: modelId, choices: [choice()], ...fields,
});
const convert = (nativeResponse: unknown) => convertResponse({ ...context, nativeResponse });

describe("convertResponse", () => {
  it("preserves the whole native assistant message and replays it unchanged", () => {
    const message = Object.freeze({
      role: "assistant", reasoning_content: "Check the weather", content: null,
      tool_calls: Object.freeze([{ id: "call_123", type: "function",
        function: { name: "get_weather", arguments: "unparsed arguments" },
      }]),
      future_field: { anything: true },
    });
    const source = Object.freeze(native({ choices: Object.freeze([
      Object.freeze(choice({ message, finish_reason: "tool_calls", logprobs: { ignored: true } })),
    ]) }));
    const result = convert(source);
    expect(result).toEqual({
      id: "chatcmpl_123", ...context, stopReason: "tool_use",
      message: { role: "assistant", provider: "fireworks", id: "chatcmpl_123",
        timestamp: context.timestamp, content: [message],
      },
    });
    expect(result.message.content[0]).toBe(message);
    const request = buildChatCompletionRequest({ modelId, messages: [result.message, {
      role: "tool_result", toolName: "get_weather", toolCallId: "call_123",
      outcome: { status: "success" },
      content: [{ type: "text", text: "Sunny" }],
    }], tools: [{ type: "function", name: "get_weather", description: "Weather", parameters: {} }] });
    expect(request.messages).toEqual([message, { role: "tool", tool_call_id: "call_123", content: "Sunny" }]);
    expect(request.messages?.[0]).toBe(message);
  });

  it("selects index zero rather than the first choice", () => {
    const zero = choice();
    const result = convert(native({ choices: [choice({ index: 1, finish_reason: "length" }), zero] }));
    expect(result.message.content[0]).toBe(zero.message);
    expect(result.stopReason).toBe("stop");
  });

  it("records a differing resolved model without replacing the selected ID", () => {
    expect(convert(native({ model: "resolved-snapshot" }))).toMatchObject({ modelId, resolvedModelId: "resolved-snapshot" });
    expect(convert(native())).not.toHaveProperty("resolvedModelId");
  });

  it.each([
    ["stop", "stop"], ["length", "length"], ["tool_calls", "tool_use"],
    ["function_call", "tool_use"], ["content_filter", "content_filter"],
  ])("maps %s to %s without inferring completion from tool calls", (reason, expected) => {
    expect(convert(native({ choices: [choice({ finish_reason: reason,
      message: { role: "assistant", tool_calls: [{ future: "unvalidated" }] },
    })] })).stopReason).toBe(expected);
  });

  it.each(["Cannot help", ""])("maps stop with a non-null refusal to refusal: %j", (refusal) => {
    expect(convert(native({ choices: [choice({ message: { role: "assistant", refusal } })] })).stopReason).toBe("refusal");
  });

  it("treats a null refusal as a normal stop", () => {
    expect(convert(native({ choices: [choice({ message: { role: "assistant", refusal: null } })] })).stopReason).toBe("stop");
  });

  it("maps three usage buckets and standard catalog costs without cache-write fields", () => {
    const usage = convert(native({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 100_000 },
    } })).usage;
    expect(usage).toMatchObject({ input: 900_000, output: 1_000_000, cacheRead: 100_000 });
    expect(usage?.cost?.input).toBeCloseTo(0.198);
    expect(usage?.cost?.output).toBeCloseTo(0.66);
    expect(usage?.cost?.cacheRead).toBeCloseTo(0.0007);
    expect(usage?.cost?.total).toBeCloseTo(0.8587);
    expect(usage).not.toHaveProperty("cacheWrite");
    expect(usage?.cost).not.toHaveProperty("cacheWrite");
  });

  it("prices known zeros", () => {
    expect(convert(native({ usage: { prompt_tokens: 0, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    } })).usage).toEqual({ input: 0, output: 0, cacheRead: 0,
      cost: { input: 0, output: 0, cacheRead: 0, total: 0 },
    });
  });

  it.each([undefined, null])("omits unavailable usage: %j", (usage) => {
    expect(convert(native({ usage }))).not.toHaveProperty("usage");
  });

  it("does not invent a missing cache count or estimate cost without it", () => {
    expect(convert(native({ usage: { prompt_tokens: 100, completion_tokens: 10 } })).usage).toEqual({ output: 10 });
  });

  it("does not clamp inconsistent cache usage or turn invalid counts into zeros", () => {
    expect(convert(native({ usage: { prompt_tokens: 10, completion_tokens: -1,
      prompt_tokens_details: { cached_tokens: 20 },
    } })).usage).toEqual({ cacheRead: 20 });
    expect(convert(native({ usage: { prompt_tokens: 10, completion_tokens: 1.5,
      prompt_tokens_details: { cached_tokens: 0 },
    } })).usage).toEqual({ input: 10, cacheRead: 0 });
  });

  it("preserves provider error details before checking the completion envelope", () => {
    const source = { error: { message: "Busy", code: "overloaded", type: "server_error" } };
    expect(() => convert(source)).toThrow(LlmError);
    expect(() => convert(source)).toThrow(expect.objectContaining({ provider: "fireworks", kind: "provider_error",
      message: "Busy", providerCode: "overloaded", providerType: "server_error", nativeError: source,
    }));
  });

  it.each([
    null, {}, native({ object: "chat.completion.chunk" }), native({ id: " " }), native({ model: "" }),
    native({ choices: null }), native({ choices: [] }), native({ choices: [choice({ index: 1 })] }),
    native({ choices: [choice({ message: null })] }), native({ choices: [choice({ message: [] })] }),
    native({ choices: [choice({ message: { role: "user" } })] }),
    ...[undefined, null, "unknown"].map((finish_reason) => native({ choices: [choice({ finish_reason })] })),
  ])("rejects an invalid completion: %j", (source) => {
    expect(() => convert(source)).toThrow(expect.objectContaining({ provider: "fireworks", kind: "invalid_response", nativeError: source }));
  });

  it("rejects unsupported model IDs", () => {
    expect(() => convertResponse({ ...context, modelId: "unknown" as FireworksModelId, nativeResponse: native() }))
      .toThrow(expect.objectContaining({ provider: "fireworks", kind: "invalid_request" }));
  });
});
