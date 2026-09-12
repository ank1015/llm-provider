import { z } from "zod";
import { ApiError } from "../errors.js";

const groupBy = z.enum(["account", "provider", "model", "day"]);
// PostgreSQL timestamps have microsecond precision and no year zero.
const instant = z.iso.datetime().refine((value) => !value.startsWith("0000") && (value.split(".")[1]?.length ?? 0) <= 7);
// Compare without truncating fractional seconds through JavaScript Date.
function instantKey(value: string) {
  const [whole, fraction = ""] = value.slice(0, -1).split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}
export const query = z.strictObject({
  from: instant.optional(), to: instant.optional(), accountId: z.uuid().optional(),
  provider: z.enum(["openai", "chatgpt", "fireworks"]).optional(), modelId: z.string().min(1).max(300).optional(),
  groupBy: groupBy.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).refine((value) => !value.from || !value.to || instantKey(value.from) <= instantKey(value.to))
  .refine((value) => !value.cursor || value.groupBy !== undefined);
export type UsageQuery = z.infer<typeof query>;

const cursorShape = z.strictObject({ groupBy, key: z.string().min(1).max(400) });
export function cursorKey(input: UsageQuery): string | undefined {
  if (!input.cursor) return undefined;
  try {
    const cursor = cursorShape.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
    if (cursor.groupBy !== input.groupBy) throw new Error("Different grouping");
    return cursor.key;
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid usage cursor.");
  }
}

export function encodeCursor(groupBy: NonNullable<UsageQuery["groupBy"]>, key: string) {
  return Buffer.from(JSON.stringify({ groupBy, key })).toString("base64url");
}
