import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiClient, DEFAULT_OPENAI_TIMEOUT_MS, type OpenAiClientOptions, type OpenAiRequestInput,
} from "../src/index.js";

const input: OpenAiRequestInput = {
  modelId: "gpt-5.6-sol", instructions: "Be concise.",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
};
const native = (fields: Record<string, unknown> = {}) => ({
  id: "resp_123", object: "response", model: input.modelId, status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }], ...fields,
});
const setup = (fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(native())),
  options: Partial<OpenAiClientOptions> = {}) => ({
  fetch, client: createOpenAiClient({ apiKey: "test-key", fetch, ...options }),
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("createOpenAiClient", () => {
  it("connects both adapters and sends the expected headers and JSON", async () => {
    const { client, fetch } = setup(undefined, { organization: "org-test", project: "proj-test" });
    const result = await client.complete(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: "Bearer test-key", accept: "application/json", "content-type": "application/json",
      "openai-organization": "org-test", "openai-project": "proj-test",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      model: input.modelId, instructions: "Be concise.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    });
    expect(result).toMatchObject({ id: "resp_123", modelId: input.modelId, stopReason: "stop",
      message: { role: "assistant", provider: "openai", content: native().output },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    expect(init?.signal?.aborted).toBe(false);
    expect(JSON.stringify(client)).not.toContain("test-key");
  });

  it("uses native fetch by default and normalizes the API root", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(native()));
    const client = createOpenAiClient({ apiKey: "test-key", baseUrl: "http://localhost:8080/v1///" });
    await client.complete(input);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:8080/v1/responses");
  });

  it("sets Lite headers per call without leaking them into later requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(native()));
    const { client } = setup(fetch);
    await client.complete({ ...input, providerOptions: { codex_responses_lite: true } });
    await client.complete(input);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("x-openai-internal-codex-responses-lite")).toBe(false);
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body).not.toHaveProperty("codex_responses_lite");
    expect(body).not.toHaveProperty("instructions");
    expect(body.input[0].role).toBe("developer");
  });

  it.each([
    { apiKey: " " }, { apiKey: "secret\r\ninjected: value" }, { project: "bad\nvalue" },
    { baseUrl: "not a URL" }, { baseUrl: "http://example.com/v1" },
    { baseUrl: "http://127.example.com/v1" },
    { baseUrl: "https://user:pass@example.com/v1" }, { baseUrl: "https://example.com/v1?q=1" },
    { baseUrl: "https://example.com/v1#fragment" }, { timeoutMs: 0 }, { timeoutMs: -1 },
    { timeoutMs: Infinity }, { timeoutMs: 1.5 }, { timeoutMs: 2_147_483_648 },
  ])("rejects invalid configuration without exposing supplied values: %j", (options) => {
    expect(() => setup(undefined, options)).toThrow(expect.objectContaining({ provider: "openai", kind: "invalid_config" }));
  });

  it.each(["http://127.0.0.1:1234", "http://[::1]:1234", "https://example.com/v1"])("allows API root %s", (baseUrl) => {
    expect(() => setup(undefined, { baseUrl })).not.toThrow();
  });

  it.each([
    { ...input, modelId: "unsupported" as OpenAiRequestInput["modelId"] },
    { ...input, providerOptions: { background: true } },
    { ...input, providerOptions: { codex_responses_lite: "invalid" } },
    { ...input, providerOptions: { tools: {} } },
    { ...input, messages: [{ role: "assistant", provider: "chatgpt", content: [] }] } as OpenAiRequestInput,
    { ...input, messages: [{ role: "custom", tag: "unsupported", data: {} }] } as OpenAiRequestInput,
    { ...input, messages: [{ role: "tool_result", toolName: "missing", toolCallId: "1", content: [],
      outcome: { status: "success" },
    }] } as OpenAiRequestInput,
  ])("rejects invalid requests before sending: %j", async (request) => {
    const { client, fetch } = setup();
    await expect(client.complete(request)).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes JSON serialization failures", async () => {
    const { client, fetch } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(client.complete({ ...input, providerOptions: circular })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves HTTP error details and Retry-After without retrying", async () => {
    const error = { message: "Slow down", code: "limited", type: "rate_limit_error" };
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ error }, { status: 429, headers: { "retry-after": "1.25" } }),
    ));
    await expect(client.complete(input)).rejects.toMatchObject({
      provider: "openai", kind: "provider_error", message: "Slow down", providerCode: "limited",
      providerType: "rate_limit_error", httpStatus: 429, retryAfterMs: 1250, nativeError: error,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Fri, 11 Sep 2026 12:00:02 GMT", 2000], ["Fri, 11 Sep 2026 11:59:59 GMT", 0],
    ["-1", undefined], ["nonsense", undefined], ["", undefined],
  ])("parses Retry-After %s", async (header, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("Unavailable", { status: 503, headers: { "retry-after": header as string } }),
    ));
    await expect(client.complete(input)).rejects.toMatchObject({ retryAfterMs: expected, httpStatus: 503 });
  });

  it.each(["Gateway failure", ""])("retains non-JSON HTTP errors: %j", async (body) => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, { status: 502, statusText: "Bad Gateway" }),
    ));
    await expect(client.complete(input)).rejects.toMatchObject({
      kind: "provider_error", message: body || "Bad Gateway", nativeError: body, httpStatus: 502,
    });
  });

  it("rejects invalid successful JSON", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not JSON")));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response", httpStatus: 200, nativeError: "not JSON" });
  });

  it("preserves errors from the response adapter", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(native({
      status: "failed", error: { message: "Failed", code: "server_error" },
    }))));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "provider_error", message: "Failed", providerCode: "server_error" });
  });

  it("normalizes network failures without retrying or leaking transport details", async () => {
    const { client, fetch } = setup(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("secret transport details")));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects pre-cancelled calls without sending", async () => {
    const { client, fetch } = setup();
    await expect(client.complete(input, { signal: AbortSignal.abort("custom reason") })).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates per-call timeout overrides", async () => {
    const { client, fetch } = setup();
    await expect(client.complete(input, { timeoutMs: 0 })).rejects.toMatchObject({ kind: "invalid_config" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("times out while waiting for %s and cleans up the timer", async (phase) => {
    vi.useFakeTimers();
    const { client, fetch } = setup(abortableFetch(phase), { timeoutMs: 1000 });
    const result = expect(client.complete(input, { timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the 15-minute default and clears successful-call timers", async () => {
    expect(DEFAULT_OPENAI_TIMEOUT_MS).toBe(900_000);
    vi.useFakeTimers();
    await setup().client.complete(input);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("cancels while waiting for %s and removes its listener", async (phase) => {
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const { client } = setup(abortableFetch(phase));
    const result = expect(client.complete(input, { signal: abort.signal })).rejects.toMatchObject({ kind: "cancelled" });
    await Promise.resolve();
    abort.abort(new Error("caller reason"));
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("classifies body read failures as network errors", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("disconnected")); } });
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
  });

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(native({ model: "model-🌞" })));
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)));
    await expect(client.complete(input)).resolves.toMatchObject({ resolvedModelId: "model-🌞" });
  });

  it("rejects invalid UTF-8", async () => {
    const { client } = setup(vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array([0xff]))));
    await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response", message: "OpenAI returned invalid UTF-8." });
  });

  it("caps response bytes and cancels oversized bodies", async () => {
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
    } })));
  });
}
