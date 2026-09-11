import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { createOpenAiClient } from "../src/index.js";

const input = { modelId: "gpt-5.6-sol", messages: [] } as const;

async function withServer(handler: RequestListener, test: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  try {
    await test(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("native fetch transport", () => {
  it("sends a complete request and converts a real HTTP response", async () => {
    let requestBody = "";
    let requestPath: string | undefined;
    let authorization: string | undefined;
    await withServer((request, response) => {
      requestPath = request.url;
      authorization = request.headers.authorization;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { requestBody += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "resp_local", object: "response", status: "completed",
          model: input.modelId, output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }],
        }));
      });
    }, async (baseUrl) => {
      const client = createOpenAiClient({ apiKey: "local-test-key", baseUrl });
      await expect(client.complete(input)).resolves.toMatchObject({ id: "resp_local", stopReason: "stop" });
      expect(requestPath).toBe("/v1/responses");
      expect(authorization).toBe("Bearer local-test-key");
      expect(JSON.parse(requestBody)).toEqual({ model: input.modelId, input: [] });
    });
  });

  it("does not follow HTTP redirects", async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      response.writeHead(307, { location: "/redirected" });
      response.end();
    }, async (baseUrl) => {
      const client = createOpenAiClient({ apiKey: "local-test-key", baseUrl });
      await expect(client.complete(input)).rejects.toMatchObject({ kind: "network_error" });
      expect(requests).toBe(1);
    });
  });

  it("aborts a stalled HTTP body when the timeout expires", async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"id":');
    }, async (baseUrl) => {
      const client = createOpenAiClient({ apiKey: "local-test-key", baseUrl, timeoutMs: 100 });
      await expect(client.complete(input)).rejects.toMatchObject({ kind: "timeout" });
    });
  });
});
