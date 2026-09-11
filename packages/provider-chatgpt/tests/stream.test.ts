import { describe, expect, it, vi } from "vitest";
import { readResponseBody, readResponseEvents } from "../src/stream.js";
import { convertResponseEvents } from "../src/index.js";
import { input, sse, terminal } from "./fixtures.js";

function chunks(parts: readonly Uint8Array[], close = true, cancel = vi.fn()) {
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(part);
    if (close) controller.close();
  }, cancel }));
}

describe("ChatGPT SSE reader", () => {
  it("retains only done items, one ID fallback, and the terminal event", async () => {
    const item = { type: "reasoning", encrypted_content: "opaque", future: true };
    const done = { type: "response.output_item.done", item };
    const end = terminal({ output: [], id: undefined });
    const wire = sse({ type: "response.created", response: { id: "early_id", instructions: "do not retain" } })
      + Array.from({ length: 1000 }, () => sse({ type: "response.output_text.delta", delta: "ignored" })).join("")
      + sse({ type: "response.in_progress", response: { id: "later_id" } }) + sse(done) + sse(end);
    const events = await readResponseEvents(new Response(wire));
    expect(events).toEqual([{ response: { id: "early_id" } }, done, end]);
    const result = convertResponseEvents({ events, modelId: input.modelId, durationMs: 1, timestamp: 2 });
    expect(result.id).toBe("early_id");
    expect(result.message.content).toEqual([item]);
  });

  it.each(["\n", "\r\n"])("decodes split UTF-8, multiline data, and %j delimiters", async (newline) => {
    const end = terminal({ model: "snapshot-🌞" });
    const json = JSON.stringify(end, null, 2).split("\n").map((line) => `data: ${line}`).join(newline);
    const wire = `: keepalive${newline}${newline}event: ignored-label${newline}${json}${newline}${newline}`;
    const bytes = new TextEncoder().encode(wire);
    const parts = Array.from(bytes, (byte) => new Uint8Array([byte]));
    await expect(readResponseEvents(chunks(parts))).resolves.toEqual([end]);
  });

  it("handles data without a space and a final event without a blank delimiter", async () => {
    const end = terminal();
    await expect(readResponseEvents(new Response(`data:${JSON.stringify(end)}`))).resolves.toEqual([end]);
  });

  it("returns immediately at the first terminal event and cancels the remaining body", async () => {
    const end = terminal();
    const cancel = vi.fn();
    const source = chunks([new TextEncoder().encode(sse(end) + "data: malformed JSON\n\n")], false, cancel);
    await expect(readResponseEvents(source)).resolves.toEqual([end]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.body?.locked).toBe(false);
  });

  it.each(["response.completed", "response.incomplete", "response.done", "response.failed", "error"])(
    "recognizes terminal event %s", async (type) => {
      const event = { type, response: { id: "resp_1" } };
      await expect(readResponseEvents(new Response(sse(event)))).resolves.toEqual([event]);
    },
  );

  it.each([
    "", ": keepalive\n\n", "data: [DONE]\n\n", "data:\n\n",
    sse({ type: "response.output_item.done", item: { type: "message" } }),
    sse({ type: "response.output_text.delta", delta: "partial" }),
  ])("rejects EOF without a terminal event: %j", async (wire) => {
    await expect(readResponseEvents(new Response(wire))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("ignores DONE markers and unknown events before the terminal response", async () => {
    const end = terminal();
    const wire = "data: [DONE]\n\n" + sse({ type: "future_event", extra: true }) + sse(null) + sse(end);
    await expect(readResponseEvents(new Response(wire))).resolves.toEqual([end]);
  });

  it("reports malformed JSON and releases the stream", async () => {
    const cancel = vi.fn();
    const source = chunks([new TextEncoder().encode("data: bad json\n\n")], false, cancel);
    await expect(readResponseEvents(source)).rejects.toMatchObject({ kind: "invalid_response", nativeError: { data: "bad json" } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([new Uint8Array([0xff]), new Uint8Array([0xf0, 0x9f])])("rejects invalid or truncated UTF-8", async (bytes) => {
    await expect(readResponseEvents(chunks([bytes]))).rejects.toMatchObject({ kind: "invalid_response", message: "ChatGPT returned invalid UTF-8." });
  });

  it("caps total incoming bytes, including discarded deltas", async () => {
    const cancel = vi.fn();
    const source = chunks([new Uint8Array(16 * 1024 * 1024 + 1)], false, cancel);
    await expect(readResponseEvents(source)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves body-read errors for the client to classify", async () => {
    const failure = new Error("disconnected");
    const source = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    await expect(readResponseEvents(source)).rejects.toBe(failure);
  });

  it("reads HTTP error bodies using the same bounded reader", async () => {
    await expect(readResponseBody(new Response("HTTP error"))).resolves.toBe("HTTP error");
    await expect(readResponseBody(new Response(null))).resolves.toBe("");
    await expect(readResponseBody(chunks([new Uint8Array(16 * 1024 * 1024 + 1)])))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
});
