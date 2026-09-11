# OpenAI provider

Non-streaming Responses API client with native assistant output preserved for replay.
Use it in a server-side runtime with native `fetch` (for example, Node.js 22+).

```ts
import { createOpenAiClient } from "@llm-providers/provider-openai";
import type { Message } from "@llm-providers/contracts";

const client = createOpenAiClient({ apiKey }); // Supply a server-side secret.
const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];
const response = await client.complete({
  modelId: "gpt-5.6-sol",
  instructions: "Be concise.",
  messages,
});

// Append the complete portable message to your existing conversation.
// The request adapter replays its native content unchanged.
messages.push(response.message);
```

Client options: `apiKey`, `baseUrl`, `organization`, `project`, `timeoutMs`, and
an optional application-owned `fetch`. The base URL defaults to
`https://api.openai.com/v1` and excludes `/responses`. Custom roots must use HTTPS;
loopback HTTP is allowed for local tests. Credentials are sent to the configured
root, so only configure a trusted endpoint. Redirects are disabled.

`complete(input, { signal, timeoutMs })` accepts cancellation and a per-call
timeout override. The default timeout is 15 minutes and covers the request and
the complete response body. Response bodies are limited to 16 MiB. Injected fetch
implementations must honor the supplied abort signal, including during body reads.

Each call makes at most one HTTP request. There are no retries, background polling,
streaming callbacks, search methods, or automatic tool execution. `background: true`
is rejected. `providerOptions.codex_responses_lite: true` enables the existing Lite
body mapping and its corresponding HTTP header.

Failures use the shared `LlmError`. HTTP failures retain status, native provider
details, and `retryAfterMs` when available; this hint does not trigger retries.
Transport errors distinguish cancellation, timeout, and network failure. Successful
results use `AssistantResponse<"openai">`; duration covers transport and JSON parsing,
and timestamp is the completion-time Unix timestamp in milliseconds. Usage costs
are catalog estimates and are omitted when the required counts are unavailable.

The package also exports `buildResponseRequest`, `convertResponse`, `OPENAI_MODELS`,
`OpenAiModelId`, and the client/configuration types for lower-level use.
