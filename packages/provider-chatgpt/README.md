# ChatGPT provider

ChatGPT backend client that reads SSE internally and returns one
`AssistantResponse<"chatgpt">`. Use a server-side runtime with native `fetch`
(for example, Node.js 22+). Supply your own access token and account ID;
the package does not log in, read stored credentials, or refresh tokens.

```ts
import { createChatGptClient } from "@llm-providers/provider-chatgpt";
import type { Message } from "@llm-providers/contracts";

const client = createChatGptClient({ accessToken, accountId });
const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];
const response = await client.complete({
  modelId: "gpt-5.6-sol",
  messages,
  providerOptions: { prompt_cache_key: "conversation-123" },
});
messages.push(response.message);
```

Configuration accepts `accessToken`, `accountId`, `baseUrl`, `timeoutMs`, and an
optional application-owned `fetch`. The default backend root is
`https://chatgpt.com/backend-api`; roots ending in `/codex` or `/codex/responses`
are also accepted. Credentials are sent to the configured endpoint, so only use
trusted endpoints. HTTPS is required except for loopback HTTP tests; redirects
are disabled. Do not expose access tokens in browser code.

Requests include bearer authentication, `chatgpt-account-id`,
`Accept: text/event-stream`, `originator: agent-pane`,
`openai-beta: responses=experimental`, and a package-specific user agent.
`providerOptions.prompt_cache_key` also sets `session-id` and `x-client-request-id`.
`providerOptions.codex_responses_lite: true` enables the Lite mapping and header.
`providerOptions.codex_remote_compaction_v2: true` sends
`x-codex-beta-features: remote_compaction_v2` without copying that transport option
into the request body. A caller requests compaction by replaying a custom native
item whose content contains `{ "type": "compaction_trigger" }`.

The reader discards text, reasoning, and argument deltas. It retains completed
`response.output_item.done` events and one earlier response ID as fallbacks. The
terminal response's nonempty output takes precedence; otherwise completed items
are used. The selected native items are preserved unchanged for request replay.
The response ID normally comes from the terminal event. No full event history is
retained or returned.

The first `response.completed`, `response.incomplete`, legacy `response.done`,
`response.failed`, or `error` event ends the read and cancels the remaining body.
Ending without a terminal event is an error, including a stream containing only
`[DONE]`. An explicit incomplete response is converted using the existing stop
reason mapping, not mistaken for a disconnected stream.

`complete(input, { signal, timeoutMs })` supports cancellation and a per-call
timeout override. The default timeout is 15 minutes through the terminal event.
Incoming bodies are capped at 16 MiB, including discarded events. Injected fetch
implementations must honor abort signals during both requests and body reads.

Errors use shared `LlmError` types. HTTP errors preserve provider details, status,
and `retryAfterMs` when present. There are no retries, token refresh, search methods,
background polling, streaming callbacks, or automatic tool execution. Usage and
catalog-cost mapping remain in the response adapter. No new shared contracts are
required.
