# Fireworks provider

Non-streaming Chat Completions client with native assistant messages preserved for
replay. Use a server-side runtime with native `fetch` (for example, Node.js 22+).

```ts
import { createFireworksClient } from "@llm-providers/provider-fireworks";
import type { Message } from "@llm-providers/contracts";

const client = createFireworksClient({ apiKey }); // Supply a server-side secret.
const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];
const response = await client.complete({
  modelId: "accounts/fireworks/models/deepseek-v4p1-flash",
  instructions: "Be concise.",
  messages,
});
messages.push(response.message);
```

Client options are `apiKey`, `baseUrl`, `timeoutMs`, and an optional application-owned
`fetch`. The API root defaults to `https://api.fireworks.ai/inference/v1` and excludes
`/chat/completions`. Custom roots require HTTPS; loopback HTTP is allowed for local
tests. Only configure trusted endpoints: credentials are sent to that endpoint.
Redirects are disabled. Do not expose API keys in browser code.

`complete(input, { signal, timeoutMs })` accepts cancellation and a per-call timeout
override. The default timeout is 15 minutes, covering both sending and reading the
complete response body. Bodies are limited to 16 MiB. Injected fetch implementations
must honor the abort signal during both requests and body reads.

The request adapter forces `stream: false` and `n: 1`. Options such as
`prompt_cache_key` stay in the JSON body; no ChatGPT cache-affinity headers are added.
`providerOptions.prompt_token_ids` is unsupported and rejected before any HTTP
request. Always supply conversation input through `messages`, including follow-ups.
The response adapter selects choice zero and stores its complete native message as
`response.message.content = [choice.message]`, preserving text, reasoning, tool calls,
and unfamiliar fields for replay. Costs are standard catalog estimates using input,
output, and cached-read counts; missing counts are not invented.

Each call makes at most one HTTP request. There are no retries, streaming callbacks,
search methods, or automatic tool execution. Caller-owned conversation history is
not stored by the client.

Failures use shared `LlmError`. HTTP errors support nested provider errors, string
or array validation details, numeric codes (normalized to strings), and non-JSON
bodies. Status, native error details, and `retryAfterMs` are retained when available;
the delay hint does not trigger retries. Cancellation, timeout, network errors, and
invalid responses remain distinct. No new contracts or runtime dependencies are
introduced by the client.

The package also exports `buildChatCompletionRequest`, `convertResponse`,
`FIREWORKS_MODELS`, `FireworksModelId`, and client/configuration types.
