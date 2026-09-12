import type { AssistantResponse, Message, ProviderOptions, ToolDefinition, Usage } from "@llm-providers/contracts";
import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, customType, foreignKey, index, integer, json, jsonb,
  numeric, pgTable, text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const time = (name: string) => timestamp(name, { withTimezone: true });
const cost = (name: string) => numeric(name, { precision: 30, scale: 12 });

/** Fully assembled input; account and model are stored on the parent job. */
export interface StoredRequest {
  instructions?: string;
  messages: readonly Message[];
  tools?: readonly ToolDefinition[];
  providerOptions?: ProviderOptions;
}

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  callbackUrl: text("callback_url").notNull(),
  webhookSecretEncrypted: bytea("webhook_secret_encrypted").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [index("users_created_idx").on(t.createdAt.desc(), t.id.desc())]);

export const userApiKeys = pgTable("user_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name"),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  revokedAt: time("revoked_at"),
}, (t) => [index("user_api_keys_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc())]);

export const providerAccounts = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  provider: text("provider", { enum: ["openai", "chatgpt", "fireworks"] }).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  secretsEncrypted: bytea("secrets_encrypted").notNull(),
  configVersion: integer("config_version").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  deletedAt: time("deleted_at"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("provider_accounts_user_id_unique").on(t.userId, t.id),
  check("provider_accounts_provider_check", sql`${t.provider} in ('openai', 'chatgpt', 'fireworks')`),
  check("provider_accounts_version_check", sql`${t.configVersion} > 0`),
  index("provider_accounts_live_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc()).where(sql`${t.deletedAt} is null`),
  index("provider_accounts_live_user_provider_created_idx").on(t.userId, t.provider, t.createdAt.desc(), t.id.desc()).where(sql`${t.deletedAt} is null`),
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  accountId: uuid("account_id").notNull(),
  previousJobId: uuid("previous_job_id"),
  modelId: text("model_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status", { enum: ["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"] }).notNull().default("queued"),
  response: json("response").$type<AssistantResponse>(),
  usage: jsonb("usage").$type<Usage>(),
  error: jsonb("error").$type<Record<string, unknown>>(),
  nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: time("lease_expires_at"),
  cancelRequestedAt: time("cancel_requested_at"),
  createdAt: time("created_at").notNull().defaultNow(),
  startedAt: time("started_at"),
  finishedAt: time("finished_at"),
}, (t) => [
  unique("jobs_user_id_unique").on(t.userId, t.id),
  unique("jobs_idempotency_unique").on(t.userId, t.idempotencyKey),
  foreignKey({ name: "jobs_account_owner_fk", columns: [t.userId, t.accountId], foreignColumns: [providerAccounts.userId, providerAccounts.id] }),
  foreignKey({ name: "jobs_parent_owner_fk", columns: [t.userId, t.previousJobId], foreignColumns: [t.userId, t.id] }),
  check("jobs_status_check", sql`${t.status} in ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')`),
  check("jobs_outcome_check", sql`
    (${t.status} = 'succeeded' and ${t.response} is not null and ${t.error} is null)
    or (${t.status} = 'failed' and ${t.error} is not null and ${t.response} is null)
    or (${t.status} in ('queued', 'running', 'retry_wait', 'cancelled') and ${t.response} is null and ${t.error} is null)
  `),
  check("jobs_finished_check", sql`(${t.status} in ('succeeded', 'failed', 'cancelled')) = (${t.finishedAt} is not null)`),
  check("jobs_lease_check", sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`),
  check("jobs_parent_check", sql`${t.previousJobId} <> ${t.id}`),
  index("jobs_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
  index("jobs_user_account_created_idx").on(t.userId, t.accountId, t.createdAt.desc(), t.id.desc()),
  index("jobs_parent_idx").on(t.userId, t.previousJobId).where(sql`${t.previousJobId} is not null`),
  index("jobs_runnable_idx").on(t.nextAttemptAt, t.id).where(sql`${t.status} in ('queued', 'retry_wait')`),
  index("jobs_expired_lease_idx").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
]);

export const jobRequests = pgTable("job_requests", {
  jobId: uuid("job_id").primaryKey().references(() => jobs.id),
  // JSON preserves escaped NULs and lone surrogates in opaque provider content.
  request: json("request").$type<StoredRequest>().notNull(),
  expiresAt: time("expires_at"),
}, (t) => [
  // Message shape is validated at submission; SQL JSON inspection rejects some escapes.
  index("job_requests_expiry_idx").on(t.expiresAt, t.jobId).where(sql`${t.expiresAt} is not null`),
]);

export const jobAttempts = pgTable("job_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  attemptNumber: integer("attempt_number").notNull(),
  accountConfigVersion: integer("account_config_version").notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed", "cancelled", "unknown"] }).notNull().default("running"),
  providerResponseId: text("provider_response_id"),
  resolvedModelId: text("resolved_model_id"),
  error: jsonb("error").$type<Record<string, unknown>>(),
  startedAt: time("started_at").notNull().defaultNow(),
  finishedAt: time("finished_at"),
  durationMs: bigint("duration_ms", { mode: "bigint" }),
  inputTokens: bigint("input_tokens", { mode: "bigint" }),
  outputTokens: bigint("output_tokens", { mode: "bigint" }),
  cacheReadTokens: bigint("cache_read_tokens", { mode: "bigint" }),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "bigint" }),
  inputCostUsd: cost("input_cost_usd"),
  outputCostUsd: cost("output_cost_usd"),
  cacheReadCostUsd: cost("cache_read_cost_usd"),
  cacheWriteCostUsd: cost("cache_write_cost_usd"),
  totalCostUsd: cost("total_cost_usd"),
}, (t) => [
  unique("job_attempts_number_unique").on(t.jobId, t.attemptNumber),
  index("job_attempts_started_job_idx").on(t.startedAt, t.jobId),
  check("job_attempts_number_check", sql`${t.attemptNumber} > 0 and ${t.accountConfigVersion} > 0`),
  check("job_attempts_status_check", sql`${t.status} in ('running', 'succeeded', 'failed', 'cancelled', 'unknown')`),
  check("job_attempts_finished_check", sql`(${t.status} <> 'running') = (${t.finishedAt} is not null)`),
  check("job_attempts_counts_check", sql`${t.durationMs} >= 0 and ${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`),
  ...[t.inputCostUsd, t.outputCostUsd, t.cacheReadCostUsd, t.cacheWriteCostUsd, t.totalCostUsd].map((column) =>
    check(`job_attempts_${column.name}_check`, sql`${column} >= 0 and ${column} <> 'NaN'::numeric`)),
]);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().unique(),
  userId: uuid("user_id").notNull(),
  eventType: text("event_type", { enum: ["job.succeeded", "job.failed", "job.cancelled"] }).notNull(),
  callbackUrl: text("callback_url").notNull(),
  payload: json("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: ["pending", "delivering", "retry_wait", "delivered", "failed"] }).notNull().default("pending"),
  retryFromAttempt: integer("retry_from_attempt").notNull().default(1),
  retryStartedAt: time("retry_started_at").notNull().defaultNow(),
  nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: time("lease_expires_at"),
  createdAt: time("created_at").notNull().defaultNow(),
  deliveredAt: time("delivered_at"),
}, (t) => [
  foreignKey({ name: "webhook_deliveries_job_owner_fk", columns: [t.userId, t.jobId], foreignColumns: [jobs.userId, jobs.id] }),
  check("webhook_deliveries_event_check", sql`${t.eventType} in ('job.succeeded', 'job.failed', 'job.cancelled')`),
  check("webhook_deliveries_status_check", sql`${t.status} in ('pending', 'delivering', 'retry_wait', 'delivered', 'failed')`),
  check("webhook_deliveries_retry_check", sql`${t.retryFromAttempt} > 0`),
  check("webhook_deliveries_delivered_check", sql`${t.status} <> 'delivered' or ${t.deliveredAt} is not null`),
  check("webhook_deliveries_lease_check", sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`),
  index("webhook_deliveries_user_created_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
  index("webhook_deliveries_runnable_idx").on(t.nextAttemptAt, t.id).where(sql`${t.status} in ('pending', 'retry_wait')`),
  index("webhook_deliveries_expired_lease_idx").on(t.leaseExpiresAt).where(sql`${t.status} = 'delivering'`),
]);

export const webhookDeliveryAttempts = pgTable("webhook_delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: uuid("delivery_id").notNull().references(() => webhookDeliveries.id),
  attemptNumber: integer("attempt_number").notNull(),
  startedAt: time("started_at").notNull().defaultNow(),
  finishedAt: time("finished_at"),
  httpStatus: integer("http_status"),
  error: jsonb("error").$type<Record<string, unknown>>(),
}, (t) => [
  unique("webhook_delivery_attempts_number_unique").on(t.deliveryId, t.attemptNumber),
  check("webhook_delivery_attempts_number_check", sql`${t.attemptNumber} > 0`),
  check("webhook_delivery_attempts_http_check", sql`${t.httpStatus} between 100 and 599`),
]);
