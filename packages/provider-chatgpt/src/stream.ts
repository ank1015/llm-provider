import { invalidResponse } from "./errors.js";
import { isTerminalEvent } from "./response.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Keeps complete items, one ID fallback, and the terminal event; never retains deltas. */
export async function readResponseEvents(response: Response): Promise<readonly unknown[]> {
  const events: unknown[] = [];
  let hasResponseId = false;
  for await (const value of sseEvents(response)) {
    const event = value as { type?: string; response?: { id?: string } } | null;
    if (isTerminalEvent(event)) {
      events.push(event);
      return events;
    }
    if (!hasResponseId && typeof event?.response?.id === "string") {
      events.push({ response: { id: event.response.id } });
      hasResponseId = true;
    }
    if (event?.type === "response.output_item.done") events.push(event);
  }
  throw invalidResponse("ChatGPT stream ended before a terminal response event.");
}

export async function readResponseBody(response: Response): Promise<string> {
  let text = "";
  for await (const chunk of textChunks(response)) text += chunk;
  return text;
}

async function* sseEvents(response: Response): AsyncGenerator<unknown> {
  let buffer = "";
  for await (const chunk of textChunks(response)) {
    buffer += chunk;
    let boundary: RegExpMatchArray | null;
    while ((boundary = buffer.match(/\r?\n\r?\n/)) !== null) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index! + boundary[0].length);
      yield* parseBlock(block);
    }
  }
  if (buffer) yield* parseBlock(buffer);
}

function* parseBlock(block: string): Generator<unknown> {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  if (!data.trim() || data.trim() === "[DONE]") return;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw invalidResponse("ChatGPT returned invalid SSE JSON.", { data });
  }
  yield event;
}

async function* textChunks(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse(`ChatGPT response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
      yield decode(value, true);
    }
    yield decode();
  } finally {
    // Also runs when the terminal event arrives before the HTTP connection closes.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  function decode(value?: Uint8Array, stream = false): string {
    try {
      return decoder.decode(value, { stream });
    } catch {
      throw invalidResponse("ChatGPT returned invalid UTF-8.");
    }
  }
}
