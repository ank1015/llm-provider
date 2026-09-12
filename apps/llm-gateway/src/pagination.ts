import { z } from "zod";
import { ApiError } from "./errors.js";
import { parse } from "./http.js";

export type PageInput = { limit: number; cursor?: { createdAt: string; id: string } };
const cursorInput = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
export const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

export function pagination(query: { limit: number; cursor?: string }): PageInput {
  if (!query.cursor) return { limit: query.limit };
  try {
    return { limit: query.limit, cursor: parse(cursorInput, JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))) };
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid pagination cursor.");
  }
}

/** cursorTime is the full-precision PostgreSQL timestamp, not a JavaScript Date. */
export function page<T extends { id: string; cursorTime: string }>(rows: T[], limit: number) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.cursorTime, id: last.id })).toString("base64url")
    : null;
  const data = selected.map(({ cursorTime: _, ...item }) => item);
  return { data, nextCursor };
}
