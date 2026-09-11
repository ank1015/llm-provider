export const input = { modelId: "gpt-5.6-sol", messages: [] } as const;

export const terminal = (fields: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: { id: "resp_123", object: "response", model: input.modelId, status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }], ...fields,
  },
});

export const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
export const response = (event: unknown = terminal()) => new Response(sse(event), {
  headers: { "content-type": "text/event-stream" },
});
