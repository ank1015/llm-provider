import { describe, expect, it } from "vitest";
import { LlmError } from "@llm-providers/contracts";
import { buildResponseRequest, convertResponseEvents, type ChatGptModelId } from "../src/index.js";

const context = { modelId: "gpt-5.6-sol", durationMs: 1200, timestamp: 123456 } as const;
const completed = (fields: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: { id: "resp_1", model: context.modelId, status: "completed", output: [], ...fields },
});
const convert = (events: readonly unknown[]) => convertResponseEvents({ ...context, events });

describe("convertResponseEvents", () => {
  it("preserves terminal output unchanged and supports request replay", () => {
    const output = Object.freeze([
      Object.freeze({ type: "reasoning", encrypted_content: "opaque" }),
      Object.freeze({ type: "message", content: [{ type: "output_text", text: "Hello" }] }),
      Object.freeze({ type: "future_item", data: true }),
      null,
    ]);
    const terminal = completed({ output, instructions: "Echoed prompt", tools: ["echoed"] });
    Object.freeze(terminal.response);
    Object.freeze(terminal);
    const result = convert(Object.freeze([
      { type: "response.output_item.done", item: output[0] }, terminal,
    ]));
    expect(result).toEqual({
      id: "resp_1", ...context, stopReason: "stop",
      message: { role: "assistant", provider: "chatgpt", id: "resp_1", timestamp: context.timestamp, content: output },
    });
    expect(result.message.content).toBe(output);
    expect(buildResponseRequest({ modelId: context.modelId, messages: [result.message] }).input).toEqual(output);
  });

  it.each([undefined, [], null].map((output) => ({ output })))("falls back to done items for output $output", ({ output }) => {
    const item = { type: "custom_tool_call", input: "not JSON" };
    const result = convert([
      { type: "response.created", response: { id: "early_id" } },
      { type: "response.output_text.delta", delta: "ignored" },
      { type: "response.output_item.done", item },
      { type: "response.output_item.done", item: null },
      { type: "response.output_item.done" },
      completed({ id: undefined, model: undefined, output }),
    ]);
    expect(result.id).toBe("early_id");
    expect(result.modelId).toBe(context.modelId);
    expect(result.resolvedModelId).toBeUndefined();
    expect(result.message.content).toEqual([item, null]);
    expect(result.message.content[0]).toBe(item);
    expect(result.stopReason).toBe("tool_use");
  });

  it("uses only events up to the first terminal event", () => {
    const result = convert([
      completed(),
      { type: "response.output_item.done", item: { type: "function_call" } },
      { type: "error", message: "Too late" },
    ]);
    expect(result.message.content).toEqual([]);
    expect(result.stopReason).toBe("stop");
  });

  it("defaults response.done status and retains the reported model", () => {
    const result = convert([{ type: "response.done", response: { id: "resp_1", model: "snapshot" } }]);
    expect(result.stopReason).toBe("stop");
    expect(result.resolvedModelId).toBe("snapshot");
  });

  it.each(["response.incomplete", "response.done", "response.completed"])("respects incomplete status for %s", (type) => {
    const result = convert([{ type, response: {
      id: "resp_1", status: type === "response.incomplete" ? "completed" : "incomplete",
      incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "function_call" }],
    } }]);
    expect(result.stopReason).toBe("length");
  });

  it("maps incomplete content filtering before tool calls", () => {
    expect(convert([completed({ status: "incomplete", incomplete_details: { reason: "content_filter" },
      output: [{ type: "custom_tool_call" }],
    })]).stopReason).toBe("content_filter");
  });

  it.each(["function_call", "custom_tool_call"])("recognizes %s without parsing it", (type) => {
    expect(convert([completed({ output: [{ type, arguments: "raw", input: "raw" }] })]).stopReason).toBe("tool_use");
  });

  it("recognizes refusal, while hosted tools alone do not require tool execution", () => {
    const hosted = { type: "web_search_call" };
    expect(convert([completed({ output: [hosted] })]).stopReason).toBe("stop");
    expect(convert([completed({ output: [hosted,
      { type: "message", content: [{ type: "refusal", refusal: "Cannot help" }] },
    ] })]).stopReason).toBe("refusal");
  });

  it.each([[272_000, 4], [272_001, 8]])("prices %i prompt tokens using the catalog threshold", (tokens, rate) => {
    const result = convert([completed({ usage: {
      input_tokens: tokens, output_tokens: 100,
      input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 2000 },
    } })]);
    expect(result.usage).toMatchObject({ input: tokens - 3000, output: 100, cacheRead: 1000, cacheWrite: 2000 });
    expect(result.usage?.cost?.input).toBeCloseTo((tokens - 3000) * rate / 1_000_000);
    expect(result.usage?.cost?.total).toBeCloseTo(
      (tokens - 3000) * rate / 1_000_000 + (tokens > 272_000 ? 0.0238 : 0.0124),
    );
  });

  it("does not invent missing cache counters or costs", () => {
    expect(convert([completed({ usage: { input_tokens: 100, output_tokens: 10,
      input_tokens_details: { cached_tokens: 20 },
    } })]).usage).toEqual({ output: 10, cacheRead: 20 });
    expect(convert([completed()]).usage).toBeUndefined();
    expect(convert([completed({ usage: null })]).usage).toBeUndefined();
  });

  it("retains known zero usage and cost", () => {
    expect(convert([completed({ usage: { input_tokens: 0, output_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    } })]).usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("omits invalid counts and does not price inconsistent usage", () => {
    expect(convert([completed({ usage: { input_tokens: 10, output_tokens: -1,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
    } })]).usage).toEqual({ cacheRead: 20, cacheWrite: 0 });
  });

  it.each([
    { type: "error", message: "Failed", code: "busy" },
    { type: "error", error: { message: "Failed", code: "busy", type: "server_error" } },
    { type: "response.failed", response: { error: { message: "Failed", code: "busy", type: "server_error" } } },
    completed({ status: "failed", error: { message: "Failed", code: "busy" } }),
    completed({ error: { message: "Failed", code: "busy" } }),
  ])("preserves provider errors from $type", (event) => {
    expect(() => convert([event])).toThrow(LlmError);
    try { convert([event]); } catch (error) {
      expect(error).toMatchObject({ message: "Failed", provider: "chatgpt", kind: "provider_error",
        providerCode: "busy", nativeError: event,
      });
    }
  });

  it.each([
    [], [{ type: "response.output_text.delta", delta: "Partial" }],
    [{ type: "response.output_item.done", item: { type: "message" } }],
    [{ type: "response.completed" }], [{ type: "response.done", response: [] }],
    [completed({ id: "" })], [completed({ model: "" })], [completed({ object: "wrong" })],
    [completed({ status: "in_progress" })], [completed({ status: undefined })],
  ].map((events) => ({ events })))("rejects unfinished streams or invalid envelopes: $events", ({ events }) => {
    expect(() => convert(events)).toThrow(expect.objectContaining({ provider: "chatgpt", kind: "invalid_response" }));
  });

  it("preserves cancellation without turning it into a successful turn", () => {
    expect(() => convert([completed({ status: "cancelled" })]))
      .toThrow(expect.objectContaining({ provider: "chatgpt", kind: "cancelled" }));
  });

  it("rejects unknown catalog models", () => {
    expect(() => convertResponseEvents({ ...context, modelId: "unknown" as ChatGptModelId, events: [completed()] }))
      .toThrow(expect.objectContaining({ provider: "chatgpt", kind: "invalid_request" }));
  });
});
