import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { hashApiKey, matchesSecret } from "./crypto.js";
import type { Database } from "./db/client.js";
import { userApiKeys, users } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { userFields, type PublicUser } from "./users/service.js";

export type UserEnv = { Variables: { user: PublicUser } };

function bearerToken(c: Context): string {
  const token = /^Bearer +([^\s]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
  if (!token || token.length > 512) throw new ApiError(401, "unauthorized", "A valid bearer key is required.");
  return token;
}

export function adminAuth(adminKey: string) {
  return createMiddleware(async (c, next) => {
    if (!matchesSecret(bearerToken(c), adminKey)) throw new ApiError(401, "unauthorized", "Invalid admin key.");
    await next();
  });
}

export function userAuth(db: Database) {
  return createMiddleware<UserEnv>(async (c, next) => {
    const [user] = await db.select(userFields).from(userApiKeys)
      .innerJoin(users, eq(userApiKeys.userId, users.id))
      .where(and(eq(userApiKeys.keyHash, hashApiKey(bearerToken(c))), isNull(userApiKeys.revokedAt), eq(users.enabled, true)));
    if (!user) throw new ApiError(401, "unauthorized", "Invalid or inactive user key.");
    c.set("user", user);
    await next();
  });
}
