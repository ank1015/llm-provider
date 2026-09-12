import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ApiError } from "./errors.js";

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, "invalid_request", "Invalid request fields.");
  return result.data;
}

export async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  }
  let input: unknown;
  try { input = await c.req.json(); }
  catch { throw new ApiError(400, "invalid_request", "Invalid JSON body."); }
  return parse(schema, input);
}

export const limitManagementBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => { throw new ApiError(413, "body_too_large", "Request body exceeds 16 KiB."); },
});
