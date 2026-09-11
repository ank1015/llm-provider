import { LlmError } from "@llm-providers/contracts";
import type { AssistantResponse } from "@llm-providers/contracts";
import { configureClient, validateTimeout, type OpenAiClientOptions } from "./config.js";
import { httpError, invalidRequest } from "./errors.js";
import { buildResponseRequest, CODEX_RESPONSES_LITE_OPTION } from "./request.js";
import { convertResponse } from "./response.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type OpenAiRequestInput = Parameters<typeof buildResponseRequest>[0];

export interface OpenAiCallOptions {
  readonly signal?: AbortSignal;
  /** Overrides the client timeout for this call only. */
  readonly timeoutMs?: number;
}

export interface OpenAiClient {
  complete(input: OpenAiRequestInput, options?: OpenAiCallOptions): Promise<AssistantResponse<"openai">>;
}

/** Stateless, non-streaming Responses client. Makes one attempt per call; never retries. */
export function createOpenAiClient(options: OpenAiClientOptions): OpenAiClient {
  const config = configureClient(options);

  return {
    async complete(input, { signal, timeoutMs = config.timeoutMs } = {}) {
      validateTimeout(timeoutMs);
      if (signal?.aborted) throw cancelled();
      const modelId = input.modelId;
      let body: string;
      try {
        body = JSON.stringify(buildResponseRequest(input));
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw invalidRequest("OpenAI request could not be formed or serialized to JSON.");
      }

      const headers = new Headers(config.headers);
      if (input.providerOptions?.[CODEX_RESPONSES_LITE_OPTION] === true) {
        headers.set("x-openai-internal-codex-responses-lite", "true");
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort(cancelled());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(new LlmError("OpenAI request timed out.", {
        provider: "openai", kind: "timeout",
      })), timeoutMs);
      const started = performance.now();

      try {
        controller.signal.throwIfAborted();
        const response = await config.fetch(config.url, {
          method: "POST", headers, body, signal: controller.signal, redirect: "error",
        });
        const text = await readResponseBody(response);
        controller.signal.throwIfAborted();
        if (!response.ok) throw httpError(response, text);
        let nativeResponse: unknown;
        try {
          nativeResponse = JSON.parse(text);
        } catch {
          throw new LlmError("OpenAI returned invalid JSON.", {
            provider: "openai", kind: "invalid_response", httpStatus: response.status, nativeError: text,
          });
        }
        return convertResponse({
          nativeResponse,
          modelId,
          durationMs: Math.round(performance.now() - started),
          timestamp: Date.now(),
        });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof LlmError) throw error;
        throw new LlmError("OpenAI request failed while sending or reading the response.", {
          provider: "openai", kind: "network_error",
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function cancelled(): LlmError {
  return new LlmError("OpenAI request was cancelled.", { provider: "openai", kind: "cancelled" });
}

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new LlmError(`OpenAI response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`, {
          provider: "openai", kind: "invalid_response", httpStatus: response.status,
        });
      }
      text += decode(value, true);
    }
    return text + decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  function decode(value?: Uint8Array, stream = false): string {
    try {
      return decoder.decode(value, { stream });
    } catch {
      throw new LlmError("OpenAI returned invalid UTF-8.", {
        provider: "openai", kind: "invalid_response", httpStatus: response.status,
      });
    }
  }
}
