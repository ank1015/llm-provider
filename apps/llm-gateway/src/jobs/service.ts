import { createHash } from "node:crypto";
import type { Provider } from "@llm-providers/contracts";
import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { jobs, jobRequests, jobAttempts, providerAccounts, type StoredRequest } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { page, type PageInput } from "../pagination.js";
import { finishJob, isTerminal, type Job } from "./lifecycle.js";
import { DEFAULT_RETENTION_DAYS, MAX_REQUEST_BYTES } from "./policy.js";
import { validateDestination, validateModel } from "./provider.js";
import type { Submission } from "./validation.js";

const metadata = {
  id: jobs.id, accountId: jobs.accountId, provider: providerAccounts.provider, modelId: jobs.modelId,
  previousJobId: jobs.previousJobId, idempotencyKey: jobs.idempotencyKey, status: jobs.status,
  createdAt: jobs.createdAt, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt,
  nextAttemptAt: jobs.nextAttemptAt, cancelRequestedAt: jobs.cancelRequestedAt,
};
const owned = (userId: string, id: string) => and(eq(jobs.userId, userId), eq(jobs.id, id));

/** Canonicalize object keys, not array order; arbitrary native JSON remains intact. */
export function fingerprint(input: Submission): string {
  return createHash("sha256").update(JSON.stringify(input, (_, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)).digest("hex");
}

export async function submitJob(db: Database, userId: string, input: Submission, extraOrigins: readonly string[] = []) {
  const requestHash = fingerprint(input);
  return db.transaction(async (tx) => {
    // Serialize only equal user/key submissions, including first insertion races.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.idempotencyKey}`}, 0))`);
    const [existing] = await tx.select({ id: jobs.id, status: jobs.status, requestHash: jobs.requestHash }).from(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ApiError(409, "idempotency_conflict", "The idempotency key was used for a different request.");
      return { id: existing.id, status: existing.status };
    }

    let accountId: string;
    let modelId: string;
    let request: StoredRequest;
    if (input.previousJobId !== null) {
      const [parent] = await tx.select().from(jobs).where(owned(userId, input.previousJobId)).for("update");
      if (!parent) notFound("Job");
      if (parent.status !== "succeeded" || !parent.response) throw new ApiError(409, "previous_job_not_succeeded", "The previous job must have succeeded.");
      const [payload] = await tx.select().from(jobRequests).where(eq(jobRequests.jobId, parent.id));
      if (!payload || (payload.expiresAt && payload.expiresAt.getTime() <= Date.now())) {
        throw new ApiError(410, "previous_request_expired", "The previous job's request is no longer available.");
      }
      accountId = parent.accountId;
      modelId = parent.modelId;
      request = { ...payload.request, messages: [...payload.request.messages, parent.response.message, ...input.messages] };
    } else {
      ({ accountId, modelId } = input);
      request = { instructions: input.instructions, messages: input.messages, tools: input.tools, providerOptions: input.providerOptions };
    }
    const [account] = await tx.select({ provider: providerAccounts.provider, config: providerAccounts.config, enabled: providerAccounts.enabled })
      .from(providerAccounts).where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.userId, userId), isNull(providerAccounts.deletedAt))).for("share");
    if (!account) notFound("Account");
    if (!account.enabled) throw new ApiError(409, "account_disabled", "Account is disabled.");
    validateModel(account.provider, modelId);
    validateDestination(account, extraOrigins);
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) throw new ApiError(413, "request_too_large", "The assembled request exceeds 16 MiB.");
    const [job] = await tx.insert(jobs).values({ userId, accountId, modelId, previousJobId: input.previousJobId,
      idempotencyKey: input.idempotencyKey, requestHash }).returning({ id: jobs.id, status: jobs.status });
    await tx.insert(jobRequests).values({ jobId: job!.id, request });
    return job!;
  });
}

export async function getJob(db: Database, userId: string, id: string) {
  const [job] = await db.select({ ...metadata, response: jobs.response, error: jobs.error,
    request: sql<StoredRequest | null>`case when ${jobRequests.expiresAt} is null or ${jobRequests.expiresAt} > now() then ${jobRequests.request} else null end`,
    requestExpiresAt: jobRequests.expiresAt,
  }).from(jobs).innerJoin(providerAccounts, eq(jobs.accountId, providerAccounts.id))
    .leftJoin(jobRequests, eq(jobs.id, jobRequests.jobId)).where(owned(userId, id));
  if (!job) notFound("Job");
  return { ...job, requestStatus: job.request === null ? "expired" : "retained" };
}

type Filters = PageInput & { accountId?: string; provider?: Provider; modelId?: string; status?: Job["status"]; from?: string; to?: string; idempotencyKey?: string };
export async function listJobs(db: Database, userId: string, input: Filters) {
  const rows = await db.select({ ...metadata, usage: jobs.usage,
    cursorTime: sql<string>`to_char(${jobs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(jobs).innerJoin(providerAccounts, eq(jobs.accountId, providerAccounts.id)).where(and(
    eq(jobs.userId, userId), input.accountId ? eq(jobs.accountId, input.accountId) : undefined,
    input.provider ? eq(providerAccounts.provider, input.provider) : undefined,
    input.modelId ? eq(jobs.modelId, input.modelId) : undefined, input.status ? eq(jobs.status, input.status) : undefined,
    input.from ? sql`${jobs.createdAt} >= ${input.from}::timestamptz` : undefined,
    input.to ? sql`${jobs.createdAt} < ${input.to}::timestamptz` : undefined,
    input.idempotencyKey ? eq(jobs.idempotencyKey, input.idempotencyKey) : undefined,
    input.cursor ? sql`(${jobs.createdAt}, ${jobs.id}) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)` : undefined,
  )).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(input.limit + 1);
  return page(rows, input.limit);
}

export async function listAttempts(db: Database, userId: string, id: string) {
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(owned(userId, id));
  if (!job) notFound("Job");
  const rows = await db.select(getTableColumns(jobAttempts)).from(jobAttempts)
    .where(eq(jobAttempts.jobId, id)).orderBy(jobAttempts.attemptNumber);
  // Bigints and numeric costs are decimal strings, preserving database precision.
  return { data: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))) };
}

export async function cancelJob(db: Database, userId: string, id: string, retentionDays = DEFAULT_RETENTION_DAYS) {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(owned(userId, id)).for("update");
    if (!job) notFound("Job");
    if (isTerminal(job.status)) return { id, status: job.status, cancelRequestedAt: job.cancelRequestedAt };
    const cancelRequestedAt = job.cancelRequestedAt ?? new Date();
    await tx.update(jobs).set({ cancelRequestedAt }).where(eq(jobs.id, id));
    if (job.status !== "running") await finishJob(tx, job, { status: "cancelled" }, retentionDays);
    return { id, status: job.status === "running" ? "running" as const : "cancelled" as const, cancelRequestedAt };
  });
}
