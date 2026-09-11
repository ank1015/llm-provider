import { LlmError } from "@llm-providers/contracts";
import type { AssistantResponse } from "@llm-providers/contracts";
import { configureClient, validateTimeout, type ChatGptClientOptions } from "./config.js";
import { httpError, invalidRequest } from "./errors.js";
import { buildResponseRequest, CODEX_RESPONSES_LITE_OPTION } from "./request.js";
import { convertResponseEvents } from "./response.js";
import { readResponseBody, readResponseEvents } from "./stream.js";

export type ChatGptRequestInput = Parameters<typeof buildResponseRequest>[0];

export interface ChatGptCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ChatGptClient {
  complete(input: ChatGptRequestInput, options?: ChatGptCallOptions): Promise<AssistantResponse<"chatgpt">>;
}

/** Reads SSE internally and returns one final response. Never retries or refreshes credentials. */
export function createChatGptClient(options: ChatGptClientOptions): ChatGptClient {
  const config = configureClient(options);
  return {
    async complete(input, { signal, timeoutMs = config.timeoutMs } = {}) {
      validateTimeout(timeoutMs);
      if (signal?.aborted) throw cancelled();
      const modelId = input.modelId;
      const headers = new Headers(config.headers);
      let body: string;
      try {
        const request = buildResponseRequest(input);
        setCacheAffinity(headers, request.prompt_cache_key);
        body = JSON.stringify(request);
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw invalidRequest("ChatGPT request could not be formed or serialized to JSON.");
      }
      if (input.providerOptions?.[CODEX_RESPONSES_LITE_OPTION] === true) {
        headers.set("x-openai-internal-codex-responses-lite", "true");
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort(cancelled());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(new LlmError("ChatGPT request timed out.", {
        provider: "chatgpt", kind: "timeout",
      })), timeoutMs);
      const started = performance.now();
      try {
        controller.signal.throwIfAborted();
        const response = await config.fetch(config.url, {
          method: "POST", headers, body, signal: controller.signal, redirect: "error",
        });
        if (!response.ok) throw httpError(response, await readResponseBody(response));
        const events = await readResponseEvents(response);
        controller.signal.throwIfAborted();
        return convertResponseEvents({
          events, modelId, durationMs: Math.round(performance.now() - started), timestamp: Date.now(),
        });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof LlmError) throw error;
        throw new LlmError("ChatGPT request failed while sending or reading the response.", {
          provider: "chatgpt", kind: "network_error",
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function setCacheAffinity(headers: Headers, key: unknown): void {
  if (key == null) return;
  if (typeof key !== "string") throw invalidRequest("providerOptions.prompt_cache_key must be a string.");
  try {
    headers.set("session-id", key);
    headers.set("x-client-request-id", key);
  } catch {
    throw invalidRequest("providerOptions.prompt_cache_key contains invalid header characters.");
  }
}

function cancelled(): LlmError {
  return new LlmError("ChatGPT request was cancelled.", { provider: "chatgpt", kind: "cancelled" });
}
