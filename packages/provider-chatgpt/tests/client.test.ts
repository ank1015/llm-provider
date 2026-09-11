import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatGptClient, DEFAULT_CHATGPT_TIMEOUT_MS, type ChatGptClientOptions, type ChatGptRequestInput,
} from "../src/index.js";
import { input, response, sse, terminal } from "./fixtures.js";

const setup = (fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response()),
  options: Partial<ChatGptClientOptions> = {}) => ({
  fetch, client: createChatGptClient({ accessToken: "test-token", accountId: "test-account", fetch, ...options }),
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("createChatGptClient", () => {
  it("sends ChatGPT-compatible headers and returns one final response", async () => {
    const { client, fetch } = setup();
    const result = await client.complete(input);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: "Bearer test-token", "chatgpt-account-id": "test-account",
      accept: "text/event-stream", "content-type": "application/json",
      originator: "agent-pane", "openai-beta": "responses=experimental",
      "user-agent": "llm-providers/provider-chatgpt/0.0.0",
    });
    expect(JSON.parse(init?.body as string)).toEqual({ model: input.modelId, input: [], stream: true, store: false,
      include: ["reasoning.encrypted_content"], instructions: "You are a helpful assistant.",
    });
    expect(result).toMatchObject({ id: "resp_123", modelId: input.modelId, stopReason: "stop",
      message: { provider: "chatgpt", role: "assistant", content: terminal().response.output },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(client)).not.toContain("test-token");
  });

  it.each([
    ["https://example.com/backend-api///", "https://example.com/backend-api/codex/responses"],
    ["http://localhost:1234/codex/", "http://localhost:1234/codex/responses"],
    ["http://127.0.0.1:1234/codex/responses/", "http://127.0.0.1:1234/codex/responses"],
    ["http://[::1]:1234", "http://[::1]:1234/codex/responses"],
  ])("normalizes endpoint %s", async (baseUrl, expected) => {
    const { client, fetch } = setup(undefined, { baseUrl });
    await client.complete(input);
    expect(fetch.mock.calls[0]?.[0]).toBe(expected);
  });

  it("defaults to native fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    await createChatGptClient({ accessToken: "test-token", accountId: "test-account" }).complete(input);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sets cache affinity and Lite headers per call without leaking them", async () => {
    const { client, fetch } = setup();
    await client.complete({ ...input, providerOptions: { prompt_cache_key: "session-123", codex_responses_lite: true } });
    await client.complete(input);
    const first = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(first.get("session-id")).toBe("session-123");
    expect(first.get("x-client-request-id")).toBe("session-123");
    expect(first.get("x-openai-internal-codex-responses-lite")).toBe("true");
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body.prompt_cache_key).toBe("session-123");
    expect(body).not.toHaveProperty("codex_responses_lite");
    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    for (const header of ["session-id", "x-client-request-id", "x-openai-internal-codex-responses-lite"]) {
      expect(second.has(header)).toBe(false);
    }
  });

  it("allows null cache keys without affinity headers", async () => {
    const { client, fetch } = setup();
    await client.complete({ ...input, providerOptions: { prompt_cache_key: null } });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("session-id")).toBe(false);
  });

  it.each([123, {}, "bad\nheader"])("rejects invalid cache keys before sending: %j", async (prompt_cache_key) => {
    const { client, fetch } = setup();
    await expect(client.complete({ ...input, providerOptions: { prompt_cache_key } })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { accessToken: " " }, { accountId: " " }, { accessToken: "token\r\nvalue" }, { accountId: "bad\nvalue" },
    { baseUrl: "bad-url" }, { baseUrl: "http://example.com" }, { baseUrl: "http://127.example.com" },
    { baseUrl: "https://user:pass@example.com" }, { baseUrl: "https://example.com?q=1" },
    { baseUrl: "https://example.com#hash" }, { timeoutMs: 0 }, { timeoutMs: -1 },
    { timeoutMs: 1.5 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 },
  ])("rejects invalid configuration: %j", (options) => {
    expect(() => setup(undefined, options)).toThrow(expect.objectContaining({ provider: "chatgpt", kind: "invalid_config" }));
  });

  it.each([
    { ...input, modelId: "unsupported" as ChatGptRequestInput["modelId"] },
    { ...input, providerOptions: { background: true } },
    { ...input, providerOptions: { max_output_tokens: 1 } },
    { ...input, providerOptions: { codex_responses_lite: "invalid" } },
    { ...input, providerOptions: { tools: {} } },
    { ...input, messages: [{ role: "assistant", provider: "openai", content: [] }] } as ChatGptRequestInput,
    { ...input, messages: [{ role: "custom", tag: "unknown", data: {} }] } as ChatGptRequestInput,
    { ...input, messages: [{ role: "tool_result", toolName: "missing", toolCallId: "1", content: [],
      outcome: { status: "success" },
    }] } as ChatGptRequestInput,
  ])("returns structured request errors before sending: %j", async (request) => {
    const { client, fetch } = setup();
    await expect(client.complete(request)).rejects.toMatchObject({ provider: "chatgpt", kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes serialization failures", async () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    const { client, fetch } = setup();
    await expect(client.complete({ ...input, providerOptions: value })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves native output from the terminal event over fallback items", async () => {
    const end = terminal();
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      sse({ type: "response.created", response: { id: "early" } })
      + sse({ type: "response.output_item.done", item: { type: "function_call" } }) + sse(end),
    )));
    const result = await client.complete(input);
    expect(result.id).toBe("resp_123");
    expect(result.message.content).toEqual(end.response.output);
    expect(result.stopReason).toBe("stop");
  });

  it("maps incomplete responses and keeps usage from the terminal event", async () => {
    const event = { type: "response.incomplete", response: {
      id: "resp_1", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "function_call" }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } },
    } };
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(event)));
    await expect(client.complete(input)).resolves.toMatchObject({ stopReason: "length", usage: { input: 80, output: 10, cacheRead: 20 } });
  });

  it.each([
    { type: "error", message: "Busy", code: "overloaded" },
    { type: "response.failed", response: { error: { message: "Busy", code: "overloaded" } } },
  ])("preserves stream failures without retrying: $type", async (event) => {
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(event)));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", message: "Busy", providerCode: "overloaded", nativeError: event });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("handles HTTP errors before SSE decoding and retains Retry-After", async () => {
    const error = { message: "Limit reached", type: "usage_limit_reached", code: "limited" };
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ error }, { status: 429, headers: { "retry-after": "1.25" } }),
    ));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", httpStatus: 429,
      message: "Limit reached", providerType: "usage_limit_reached", providerCode: "limited", retryAfterMs: 1250, nativeError: error,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['{"detail":"Unsupported parameter"}', "Unsupported parameter"], ["Gateway failure", "Gateway failure"], ["", "Bad Request"],
  ])("handles HTTP error body %j", async (body, message) => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 400, statusText: "Bad Request" })));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", httpStatus: 400, message });
  });

  it("parses date Retry-After values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("Busy", {
      status: 503, headers: { "retry-after": "Fri, 11 Sep 2026 12:00:02 GMT" },
    })));
    await expect(client.complete(input)).rejects.toMatchObject({ retryAfterMs: 2000 });
  });

  it("normalizes network failures without retrying", async () => {
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("failed")));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies premature EOF as invalid_response", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("data: [DONE]\n\n")));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does not send pre-cancelled requests or invalid timeout overrides", async () => {
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

  it.each(["headers", "body"])("cancels during %s and cleans up listeners", async (phase) => {
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const { client } = setup(abortableFetch(phase));
    const result = expect(client.complete(input, { signal: abort.signal })).rejects.toMatchObject({ kind: "cancelled" });
    await Promise.resolve();
    abort.abort("custom reason");
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cleans up successful call timers and keeps the 15-minute default", async () => {
    vi.useFakeTimers();
    expect(DEFAULT_CHATGPT_TIMEOUT_MS).toBe(900_000);
    await setup().client.complete(input);
    expect(vi.getTimerCount()).toBe(0);
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
