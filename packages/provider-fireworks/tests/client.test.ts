import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFireworksClient, DEFAULT_FIREWORKS_TIMEOUT_MS, type FireworksClientOptions, type FireworksRequestInput,
} from "../src/index.js";

const input: FireworksRequestInput = {
  modelId: "accounts/fireworks/models/deepseek-v4p1-flash", instructions: "Be concise.",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
};
const native = (fields: Record<string, unknown> = {}) => ({
  id: "chatcmpl_123", object: "chat.completion", model: input.modelId,
  choices: [{ index: 0, message: { role: "assistant", content: "Hi", reasoning_content: "A greeting" }, finish_reason: "stop" }],
  ...fields,
});
const setup = (fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(native())),
  options: Partial<FireworksClientOptions> = {}) => ({
  fetch, client: createFireworksClient({ apiKey: "test-key", fetch, ...options }),
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("createFireworksClient", () => {
  it("connects the adapters and replays native assistant messages on follow-up calls", async () => {
    const { client, fetch } = setup();
    const result = await client.complete(input);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ authorization: "Bearer test-key",
      accept: "application/json", "content-type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({ model: input.modelId, stream: false, n: 1,
      messages: [{ role: "system", content: "Be concise." }, { role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(result).toMatchObject({ id: "chatcmpl_123", modelId: input.modelId, stopReason: "stop",
      message: { provider: "fireworks", role: "assistant", content: [native().choices[0]!.message] },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    await client.complete({ ...input, messages: [...input.messages, result.message] });
    const followup = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string);
    expect(followup.messages[2]).toEqual(native().choices[0]!.message);
    expect(JSON.stringify(client)).not.toContain("test-key");
  });

  it("keeps provider options in the body without adding ChatGPT cache headers", async () => {
    const { client, fetch } = setup();
    await client.complete({ ...input, providerOptions: { prompt_cache_key: "session-1", temperature: 0.5, stream: true, n: 3 } });
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(init?.body as string)).toMatchObject({ prompt_cache_key: "session-1", temperature: 0.5, stream: false, n: 1 });
    expect(new Headers(init?.headers).has("session-id")).toBe(false);
    expect(new Headers(init?.headers).has("x-client-request-id")).toBe(false);
  });

  it("uses native fetch and normalizes custom API roots", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(native()));
    const client = createFireworksClient({ apiKey: "test-key", baseUrl: "http://localhost:1234/v1///" });
    await client.complete(input);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:1234/v1/chat/completions");
  });

  it.each([
    { apiKey: " " }, { apiKey: "secret\r\nvalue" }, { baseUrl: "not a URL" },
    { baseUrl: "http://example.com" }, { baseUrl: "http://127.example.com" },
    { baseUrl: "https://user:pass@example.com" }, { baseUrl: "https://example.com?q=1" },
    { baseUrl: "https://example.com#hash" }, { timeoutMs: 0 }, { timeoutMs: -1 },
    { timeoutMs: 1.5 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 },
  ])("rejects invalid configuration: %j", (options) => {
    expect(() => setup(undefined, options)).toThrow(expect.objectContaining({ provider: "fireworks", kind: "invalid_config" }));
  });

  it.each(["http://127.0.0.1:1234", "http://[::1]:1234", "https://example.com/v1"])("allows API root %s", (baseUrl) => {
    expect(() => setup(undefined, { baseUrl })).not.toThrow();
  });

  it.each([
    { ...input, modelId: "unknown" as FireworksRequestInput["modelId"] },
    { ...input, providerOptions: { service_tier: "priority" } },
    { ...input, providerOptions: { codex_responses_lite: false } },
    { ...input, messages: [{ role: "assistant", provider: "openai", content: [] }] } as FireworksRequestInput,
    { ...input, messages: [{ role: "custom", tag: "unknown", data: {} }] } as FireworksRequestInput,
    { ...input, messages: [{ role: "tool_result", toolName: "missing", toolCallId: "1", content: [], outcome: { status: "success" } }] } as FireworksRequestInput,
    { ...input, tools: [{ type: "custom", name: "custom", description: "Custom", format: { syntax: "lark", definition: "start: /.+/" } }] } as FireworksRequestInput,
  ])("rejects invalid requests before sending: %j", async (request) => {
    const { client, fetch } = setup();
    await expect(client.complete(request)).rejects.toMatchObject({ provider: "fireworks", kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes JSON serialization errors", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { client, fetch } = setup();
    await expect(client.complete({ ...input, providerOptions: circular })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves numeric provider codes, HTTP details, and Retry-After without retrying", async () => {
    const error = { message: "Slow down", code: 42901, type: "rate_limit" };
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ error }, { status: 429, headers: { "retry-after": "1.25" } }),
    ));
    await expect(client.complete(input)).rejects.toMatchObject({ provider: "fireworks", kind: "provider_error",
      httpStatus: 429, message: "Slow down", providerCode: "42901", providerType: "rate_limit", retryAfterMs: 1250, nativeError: error,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [{ detail: "Bad request" }, "Bad request"],
    [{ detail: [{ msg: "Bad model" }, { msg: "Bad messages" }, null, {}] }, "Bad model; Bad messages"],
    [{ error: { detail: [{ msg: "Nested validation" }] } }, "Nested validation"],
    [{ error: { code: "invalid" }, message: "Outer message" }, "Outer message"],
  ])("extracts validation messages from %j", async (body, message) => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body, { status: 422 })));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", httpStatus: 422, message });
  });

  it.each(["Gateway failure", ""])("retains non-JSON error bodies: %j", async (body) => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 502, statusText: "Bad Gateway" })));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", message: body || "Bad Gateway", nativeError: body });
  });

  it.each([
    ["Fri, 11 Sep 2026 12:00:02 GMT", 2000], ["Fri, 11 Sep 2026 11:59:59 GMT", 0],
    ["-1", undefined], ["nonsense", undefined],
  ])("parses Retry-After %s", async (header, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("Busy", {
      status: 503, headers: { "retry-after": header as string },
    })));
    await expect(client.complete(input)).rejects.toMatchObject({ retryAfterMs: expected });
  });

  it("rejects invalid successful JSON", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not JSON")));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response", httpStatus: 200, nativeError: "not JSON" });
  });

  it("preserves response-adapter failures", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: { message: "Failed", code: "failed" } })));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", message: "Failed", providerCode: "failed" });
  });

  it("normalizes network failures without retrying", async () => {
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("connection failed")));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects pre-cancelled calls and invalid timeout overrides before sending", async () => {
    const { client, fetch } = setup();
    await expect(client.complete(input, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.complete(input, { timeoutMs: 0 })).rejects.toMatchObject({ kind: "invalid_config" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["headers", "body", "error body"])("times out while waiting for %s", async (phase) => {
    vi.useFakeTimers();
    const { client, fetch } = setup(abortableFetch(phase), { timeoutMs: 1000 });
    const result = expect(client.complete(input, { timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("cancels during %s and removes its listener", async (phase) => {
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const { client } = setup(abortableFetch(phase));
    const result = expect(client.complete(input, { signal: abort.signal })).rejects.toMatchObject({ kind: "cancelled" });
    await Promise.resolve();
    abort.abort("caller reason");
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cleans up successful-call timers and retains the 15-minute default", async () => {
    vi.useFakeTimers();
    expect(DEFAULT_FIREWORKS_TIMEOUT_MS).toBe(900_000);
    await setup().client.complete(input);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies body read failures as network errors", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("disconnected")); } });
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
  });

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(native({ model: "snapshot-🌞" })));
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
    await expect(client.complete(input)).resolves.toMatchObject({ resolvedModelId: "snapshot-🌞" });
  });

  it("rejects invalid UTF-8", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array([0xff]))));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response", message: "Fireworks returned invalid UTF-8." });
  });

  it("cancels bodies exceeding the response-size limit", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
    }, cancel });
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function abortableFetch(phase: string) {
  return vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    const signal = init!.signal!;
    if (phase === "headers") return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return Promise.resolve(new Response(new ReadableStream({ start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    } }), { status: phase === "error body" ? 503 : 200 }));
  });
}
