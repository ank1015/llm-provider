import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantResponse } from "@llm-providers/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { jobAttempts, jobRequests, jobs, providerAccounts, users } from "../db/schema.js";
import { finishJob } from "./lifecycle.js";
import { DEFAULT_RETENTION_DAYS, HEARTBEAT_MS, isRetryable, JOB_TIMEOUT_MS, LEASE_MS, MAX_ATTEMPTS, retryDelay, serializeError } from "./policy.js";
import type { Execute } from "./provider.js";
import { cleanupRequests } from "./retention.js";

const failure = (code: string, message: string) => ({ code, message, retryable: false });

/** Locks only while recording a claim; no transaction is held during provider I/O. */
export async function claimJob(db: Database, retentionDays = DEFAULT_RETENTION_DAYS) {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(sql`
      (${jobs.status} in ('queued', 'retry_wait') and ${jobs.nextAttemptAt} <= now())
      or (${jobs.status} = 'running' and ${jobs.leaseExpiresAt} <= now())
    `).orderBy(jobs.nextAttemptAt, jobs.id).limit(1).for("update", { skipLocked: true });
    if (!job) return null;
    const now = new Date();
    const [last] = await tx.select({ id: jobAttempts.id, attemptNumber: jobAttempts.attemptNumber, status: jobAttempts.status })
      .from(jobAttempts).where(eq(jobAttempts.jobId, job.id)).orderBy(desc(jobAttempts.attemptNumber)).limit(1);
    if (last?.status === "running") {
      await tx.update(jobAttempts).set({ status: "unknown", finishedAt: now,
        error: { ...failure("lease_expired", "Worker lease expired; provider outcome and usage are unknown."), retryable: true } })
        .where(eq(jobAttempts.id, last.id));
    }
    const finish = async (error: Record<string, unknown>) => {
      await finishJob(tx, job, { status: "failed", error }, retentionDays, now);
      return { completed: true } as const;
    };
    if (job.cancelRequestedAt) {
      await finishJob(tx, job, { status: "cancelled" }, retentionDays, now);
      return { completed: true } as const;
    }
    if (now.getTime() >= job.createdAt.getTime() + JOB_TIMEOUT_MS) return finish(failure("job_deadline_exceeded", "The job exceeded its 30-minute deadline."));
    if ((last?.attemptNumber ?? 0) >= MAX_ATTEMPTS) return finish(failure("attempts_exhausted", "The job exhausted its provider attempts."));
    const [owner] = await tx.select({ account: providerAccounts, userEnabled: users.enabled }).from(providerAccounts)
      .innerJoin(users, eq(users.id, providerAccounts.userId)).where(eq(providerAccounts.id, job.accountId));
    if (!owner?.userEnabled || !owner.account.enabled || owner.account.deletedAt) {
      return finish(failure("account_unavailable", "The user or provider account is no longer enabled."));
    }
    const [payload] = await tx.select({ request: jobRequests.request }).from(jobRequests).where(eq(jobRequests.jobId, job.id));
    if (!payload) return finish(failure("request_unavailable", "The job request is unavailable."));
    const leaseToken = randomUUID();
    const [attempt] = await tx.insert(jobAttempts).values({ jobId: job.id, attemptNumber: (last?.attemptNumber ?? 0) + 1,
      accountConfigVersion: owner.account.configVersion, startedAt: now }).returning();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    await tx.update(jobs).set({ status: "running", startedAt: job.startedAt ?? now,
      leaseToken, leaseExpiresAt }).where(eq(jobs.id, job.id));
    return { completed: false, job, account: owner.account, request: payload.request, attempt: attempt!, leaseToken, leaseExpiresAt } as const;
  });
}
type Claim = Extract<NonNullable<Awaited<ReturnType<typeof claimJob>>>, { completed: false }>;

function usageFields(response?: AssistantResponse) {
  const usage = response?.usage;
  const count = (value: number | undefined) => value === undefined ? null : BigInt(value);
  const cost = (value: number | undefined) => value === undefined ? null : value.toFixed(12);
  return {
    providerResponseId: response?.id, resolvedModelId: response?.resolvedModelId,
    inputTokens: count(usage?.input), outputTokens: count(usage?.output),
    cacheReadTokens: count(usage?.cacheRead), cacheWriteTokens: count(usage?.cacheWrite),
    inputCostUsd: cost(usage?.cost?.input), outputCostUsd: cost(usage?.cost?.output),
    cacheReadCostUsd: cost(usage?.cost?.cacheRead), cacheWriteCostUsd: cost(usage?.cost?.cacheWrite),
    totalCostUsd: cost(usage?.cost?.total),
  };
}

/** Token plus live lease fence late results from crashed/replaced workers. */
export async function completeClaim(db: Database, claim: Claim, result: { response: AssistantResponse } | { error: unknown }, retentionDays = DEFAULT_RETENTION_DAYS) {
  await db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, claim.job.id), eq(jobs.status, "running"),
      eq(jobs.leaseToken, claim.leaseToken))).for("update");
    // Check after acquiring the lock: waiting for it can outlive a lease.
    if (!job || job.leaseExpiresAt!.getTime() <= Date.now()) return;
    const now = new Date();
    const response = "response" in result ? result.response : undefined;
    const error = "error" in result ? serializeError(result.error) : null;
    await tx.update(jobAttempts).set({
      status: response ? "succeeded" : job.cancelRequestedAt ? "cancelled" : "failed",
      error, finishedAt: now, durationMs: BigInt(Math.max(0, now.getTime() - claim.attempt.startedAt.getTime())),
      ...usageFields(response),
    }).where(eq(jobAttempts.id, claim.attempt.id));
    if (job.cancelRequestedAt) {
      await finishJob(tx, job, { status: "cancelled" }, retentionDays, now);
    } else if (response) {
      await finishJob(tx, job, { status: "succeeded", response }, retentionDays, now);
    } else {
      const cause = "error" in result ? result.error : undefined;
      const nextAttemptAt = new Date(now.getTime() + retryDelay(claim.attempt.attemptNumber, cause));
      if (isRetryable(cause) && claim.attempt.attemptNumber < MAX_ATTEMPTS
        && nextAttemptAt.getTime() < job.createdAt.getTime() + JOB_TIMEOUT_MS) {
        await tx.update(jobs).set({ status: "retry_wait", nextAttemptAt, leaseToken: null, leaseExpiresAt: null }).where(eq(jobs.id, job.id));
      } else {
        await finishJob(tx, job, { status: "failed", error: error! }, retentionDays, now);
      }
    }
  });
}

export async function renewClaim(db: Database, claim: Claim) {
  const [job] = await db.update(jobs).set({ leaseExpiresAt: sql`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'` })
    .where(and(eq(jobs.id, claim.job.id), eq(jobs.status, "running"), eq(jobs.leaseToken, claim.leaseToken),
      sql`${jobs.leaseExpiresAt} > clock_timestamp()`)).returning({ cancelRequestedAt: jobs.cancelRequestedAt, leaseExpiresAt: jobs.leaseExpiresAt });
  return job;
}

/** One job per process; run additional processes for concurrency. */
export async function runOnce(db: Database, execute: Execute, signal: AbortSignal, retentionDays = DEFAULT_RETENTION_DAYS) {
  if (signal.aborted) return false;
  const claim = await claimJob(db, retentionDays);
  if (!claim) return false;
  if (claim.completed) return true;
  const call = new AbortController();
  const stopHeartbeat = new AbortController();
  const onShutdown = () => call.abort();
  signal.addEventListener("abort", onShutdown, { once: true });
  if (signal.aborted) onShutdown();
  let lostLease = false;
  // These local timers do not depend on a database renewal completing.
  const loseLease = () => { lostLease = true; call.abort(); };
  let leaseTimer = setTimeout(loseLease, Math.max(0, claim.leaseExpiresAt.getTime() - Date.now()));
  const remainingMs = claim.job.createdAt.getTime() + JOB_TIMEOUT_MS - Date.now();
  const deadlineTimer = setTimeout(() => call.abort(), Math.max(0, remainingMs));
  if (remainingMs <= 0 || claim.leaseExpiresAt.getTime() <= Date.now()) call.abort();
  const heartbeat = (async () => {
    while (!stopHeartbeat.signal.aborted) {
      await sleep(HEARTBEAT_MS, undefined, { signal: stopHeartbeat.signal }).catch(() => {});
      if (stopHeartbeat.signal.aborted) break;
      try {
        const lease = await renewClaim(db, claim);
        if (stopHeartbeat.signal.aborted || lostLease) break;
        if (!lease) lostLease = true;
        if (!lease || lease.cancelRequestedAt) { call.abort(); break; }
        clearTimeout(leaseTimer);
        leaseTimer = setTimeout(loseLease, Math.max(0, lease.leaseExpiresAt!.getTime() - Date.now()));
      } catch {
        lostLease = true;
        call.abort();
        break;
      }
    }
  })();
  try {
    let result: { response: AssistantResponse } | { error: unknown };
    try {
      const timeoutMs = Math.max(1, claim.job.createdAt.getTime() + JOB_TIMEOUT_MS - Date.now());
      result = { response: await execute(claim.account, claim.job.modelId, claim.request, call.signal, timeoutMs) };
    } catch (error) {
      result = { error };
    }
    // Shutdown/connection loss leaves recovery to the lease, not a false cancellation.
    if (!signal.aborted && !lostLease) await completeClaim(db, claim, result, retentionDays);
  } finally {
    stopHeartbeat.abort();
    clearTimeout(leaseTimer);
    clearTimeout(deadlineTimer);
    await heartbeat;
    signal.removeEventListener("abort", onShutdown);
  }
  return true;
}

export async function runWorker(db: Database, execute: Execute, signal: AbortSignal, retentionDays = DEFAULT_RETENTION_DAYS) {
  let cleanupAt = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() >= cleanupAt) {
        const removed = await cleanupRequests(db);
        cleanupAt = removed === 100 ? 0 : Date.now() + 60_000;
      }
      if (await runOnce(db, execute, signal, retentionDays)) continue;
    } catch {
      console.error("Job worker operation failed; uncompleted claims will recover after lease expiry.");
    }
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
}
