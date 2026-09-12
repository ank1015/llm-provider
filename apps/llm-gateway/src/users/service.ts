import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database, Transaction } from "../db/client.js";
import { userApiKeys, users } from "../db/schema.js";
import { encryptSecret, mintApiKey, mintWebhookSecret } from "../crypto.js";
import { notFound } from "../errors.js";
import { page, type PageInput } from "../pagination.js";

export const userFields = {
  id: users.id, name: users.name, enabled: users.enabled, callbackUrl: users.callbackUrl,
  createdAt: users.createdAt, updatedAt: users.updatedAt,
};
const keyFields = {
  id: userApiKeys.id, userId: userApiKeys.userId, name: userApiKeys.name,
  keyPrefix: userApiKeys.keyPrefix, createdAt: userApiKeys.createdAt, revokedAt: userApiKeys.revokedAt,
};
export type PublicUser = Pick<typeof users.$inferSelect, keyof typeof userFields>;
export type UserPatch = Partial<Pick<PublicUser, "name" | "callbackUrl" | "enabled">>;

async function insertKey(db: Database | Transaction, userId: string, name?: string) {
  const { secret, keyHash, keyPrefix } = mintApiKey();
  const [key] = await db.insert(userApiKeys).values({ userId, name, keyHash, keyPrefix }).returning(keyFields);
  return { ...key!, secret };
}

export async function createUser(db: Database, encryptionKey: Buffer, input: { name: string; callbackUrl: string }) {
  const id = randomUUID();
  const webhookSecret = mintWebhookSecret();
  const webhookSecretEncrypted = encryptSecret(webhookSecret, encryptionKey, `user:${id}:webhook`);
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ id, ...input, webhookSecretEncrypted }).returning(userFields);
    const key = await insertKey(tx, id, "Initial key");
    return { user: user!, key, webhookSecret };
  });
}

export async function getUser(db: Database, id: string) {
  const [user] = await db.select(userFields).from(users).where(eq(users.id, id));
  return user ?? notFound("User");
}

export async function listUsers(db: Database, { limit, cursor }: PageInput) {
  // Preserve PostgreSQL microseconds in cursors; JavaScript Date truncates them.
  const rows = await db.select({ ...userFields,
    cursorTime: sql<string>`to_char(${users.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(users)
    .where(cursor ? sql`(${users.createdAt}, ${users.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined)
    .orderBy(desc(users.createdAt), desc(users.id)).limit(limit + 1);
  return page(rows, limit);
}

export async function updateUser(db: Database, id: string, patch: UserPatch) {
  const [user] = await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id)).returning(userFields);
  return user ?? notFound("User");
}

export async function issueKey(db: Database, userId: string, name?: string) {
  await getUser(db, userId);
  return insertKey(db, userId, name);
}

export async function listKeys(db: Database, userId: string, { limit, cursor }: PageInput) {
  await getUser(db, userId);
  const rows = await db.select({ ...keyFields,
    cursorTime: sql<string>`to_char(${userApiKeys.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(userApiKeys).where(and(
    eq(userApiKeys.userId, userId),
    cursor ? sql`(${userApiKeys.createdAt}, ${userApiKeys.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
  )).orderBy(desc(userApiKeys.createdAt), desc(userApiKeys.id)).limit(limit + 1);
  return page(rows, limit);
}

export async function revokeKey(db: Database, userId: string, keyId: string) {
  const [key] = await db.update(userApiKeys)
    .set({ revokedAt: sql`coalesce(${userApiKeys.revokedAt}, now())` })
    .where(and(eq(userApiKeys.id, keyId), eq(userApiKeys.userId, userId))).returning({ id: userApiKeys.id });
  if (!key) notFound("Key");
}

export async function rotateWebhookSecret(db: Database, encryptionKey: Buffer, userId: string) {
  const webhookSecret = mintWebhookSecret();
  const [user] = await db.update(users).set({
    webhookSecretEncrypted: encryptSecret(webhookSecret, encryptionKey, `user:${userId}:webhook`),
    updatedAt: new Date(),
  }).where(eq(users.id, userId)).returning({ id: users.id });
  if (!user) notFound("User");
  return { webhookSecret };
}
