import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Provider } from "@llm-providers/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { providerAccounts } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { notFound } from "../errors.js";
import { page, type PageInput } from "../pagination.js";
import { validateSettings, type AccountPatch, type CreateAccountInput } from "./validation.js";

const accountFields = {
  id: providerAccounts.id, userId: providerAccounts.userId, name: providerAccounts.name,
  provider: providerAccounts.provider, config: providerAccounts.config,
  configVersion: providerAccounts.configVersion, enabled: providerAccounts.enabled,
  createdAt: providerAccounts.createdAt, updatedAt: providerAccounts.updatedAt,
};

function ownedAccount(userId: string, id: string) {
  return and(eq(providerAccounts.userId, userId), eq(providerAccounts.id, id));
}

function secretContext(userId: string, id: string, provider: Provider) {
  return `user:${userId}:account:${id}:${provider}:secrets`;
}

export async function createAccount(db: Database, encryptionKey: Buffer, userId: string, input: CreateAccountInput) {
  const settings = validateSettings(input.provider, input.config, input.secrets);
  const id = randomUUID();
  const secretsEncrypted = encryptSecret(JSON.stringify(settings.secrets), encryptionKey, secretContext(userId, id, input.provider));
  const [account] = await db.insert(providerAccounts).values({
    id, userId, name: input.name, provider: input.provider, config: settings.config,
    enabled: input.enabled, secretsEncrypted,
  }).returning(accountFields);
  return account!;
}

export async function getAccount(db: Database, userId: string, id: string) {
  const [account] = await db.select(accountFields).from(providerAccounts)
    .where(and(ownedAccount(userId, id), isNull(providerAccounts.deletedAt)));
  return account ?? notFound("Account");
}

export async function listAccounts(db: Database, userId: string, { limit, cursor, provider }: PageInput & { provider?: Provider }) {
  const rows = await db.select({ ...accountFields,
    cursorTime: sql<string>`to_char(${providerAccounts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(providerAccounts).where(and(
    eq(providerAccounts.userId, userId), isNull(providerAccounts.deletedAt),
    provider ? eq(providerAccounts.provider, provider) : undefined,
    cursor ? sql`(${providerAccounts.createdAt}, ${providerAccounts.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
  )).orderBy(desc(providerAccounts.createdAt), desc(providerAccounts.id)).limit(limit + 1);
  return page(rows, limit);
}

export async function updateAccount(db: Database, encryptionKey: Buffer, userId: string, id: string, patch: AccountPatch) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(providerAccounts)
      .where(and(ownedAccount(userId, id), isNull(providerAccounts.deletedAt))).for("update");
    if (!current) notFound("Account");

    const changes: Partial<typeof providerAccounts.$inferInsert> = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    };
    if (patch.config !== undefined || patch.secrets !== undefined) {
      const context = secretContext(userId, id, current.provider);
      const oldSecrets = JSON.parse(decryptSecret(current.secretsEncrypted, encryptionKey, context)) as Record<string, unknown>;
      const settings = validateSettings(current.provider,
        { ...current.config, ...patch.config }, { ...oldSecrets, ...patch.secrets });
      const configChanged = !isDeepStrictEqual(settings.config, current.config);
      const secretsChanged = !isDeepStrictEqual(settings.secrets, oldSecrets);
      if (configChanged) changes.config = settings.config;
      if (secretsChanged) changes.secretsEncrypted = encryptSecret(JSON.stringify(settings.secrets), encryptionKey, context);
      if (configChanged || secretsChanged) changes.configVersion = current.configVersion + 1;
    }

    const [account] = await tx.update(providerAccounts).set(changes)
      .where(ownedAccount(userId, id)).returning(accountFields);
    return account!;
  });
}

export async function deleteAccount(db: Database, userId: string, id: string) {
  const [account] = await db.update(providerAccounts).set({
    enabled: false,
    deletedAt: sql`coalesce(${providerAccounts.deletedAt}, now())`,
    updatedAt: sql`case when ${providerAccounts.deletedAt} is null then now() else ${providerAccounts.updatedAt} end`,
  }).where(ownedAccount(userId, id)).returning({ id: providerAccounts.id });
  if (!account) notFound("Account");
}
