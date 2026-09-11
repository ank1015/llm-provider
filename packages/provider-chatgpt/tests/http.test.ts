import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { createChatGptClient } from "../src/index.js";
import { input, sse, terminal } from "./fixtures.js";

async function withServer(handler: RequestListener, test: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  try {
    await test(`http://127.0.0.1:${address.port}/backend-api`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("native ChatGPT HTTP transport", () => {
  it("sends compatible headers and finishes without waiting for the connection to close", async () => {
    let requestPath: string | undefined;
    let headers: Record<string, unknown> = {};
    let requestBody = "";
    const item = { type: "reasoning", encrypted_content: "opaque" };
    await withServer((request, response) => {
      requestPath = request.url;
      headers = request.headers;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { requestBody += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse({ type: "response.created", response: { id: "early_id" } }));
        response.write(sse({ type: "response.output_text.delta", delta: "ignored" }));
        response.write(sse({ type: "response.output_item.done", item }));
        response.write(sse(terminal({ id: undefined, output: [] })));
        // Deliberately leave the HTTP body open after the terminal event.
      });
    }, async (baseUrl) => {
      const client = createChatGptClient({ accessToken: "local-token", accountId: "local-account", baseUrl, timeoutMs: 1000 });
      const result = await client.complete({ ...input, providerOptions: { prompt_cache_key: "session-1" } });
      expect(result.id).toBe("early_id");
      expect(result.message.content).toEqual([item]);
      expect(requestPath).toBe("/backend-api/codex/responses");
      expect(headers).toMatchObject({ authorization: "Bearer local-token", "chatgpt-account-id": "local-account",
        accept: "text/event-stream", originator: "agent-pane", "openai-beta": "responses=experimental",
        "session-id": "session-1", "x-client-request-id": "session-1",
      });
      expect(JSON.parse(requestBody)).toMatchObject({ stream: true, store: false });
    });
  });

  it("does not follow redirects", async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      response.writeHead(307, { location: "/redirected" });
      response.end();
    }, async (baseUrl) => {
      const client = createChatGptClient({ accessToken: "local-token", accountId: "local-account", baseUrl });
      await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
      expect(requests).toBe(1);
    });
  });

  it("times out if the stream stalls before a terminal event", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": keepalive\n\n");
    }, async (baseUrl) => {
      const client = createChatGptClient({ accessToken: "local-token", accountId: "local-account", baseUrl, timeoutMs: 100 });
      await expect(client.complete(input)).rejects.toMatchObject({ kind: "timeout" });
    });
  });

  it("reports premature EOF without returning partial output", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ type: "response.output_item.done", item: { type: "message", content: [] } }));
    }, async (baseUrl) => {
      const client = createChatGptClient({ accessToken: "local-token", accountId: "local-account", baseUrl });
      await expect(client.complete(input)).rejects.toMatchObject({ kind: "invalid_response" });
    });
  });
});
