import { randomUUID } from "node:crypto";
import type { AssistantResponse } from "@llm-providers/contracts";
import { eq, sql } from "drizzle-orm";
import type { Transaction } from "../db/client.js";
import { jobs, jobRequests, users, webhookDeliveries } from "../db/schema.js";
import { JOB_EVENT_CHANNEL, type TerminalJobEvent } from "./events.js";

export type Job = typeof jobs.$inferSelect;
export type Outcome = { status: "succeeded"; response: AssistantResponse }
  | { status: "failed"; error: Record<string, unknown> }
  | { status: "cancelled" };
export function isTerminal(status: Job["status"]) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Caller holds the job row lock and, for worker completion, has checked its lease. */
export async function finishJob(tx: Transaction, job: Job, outcome: Outcome, retentionDays: number, now = new Date()) {
  const response = outcome.status === "succeeded" ? outcome.response : null;
  const error = outcome.status === "failed" ? outcome.error : null;
  await tx.update(jobs).set({ status: outcome.status, response, usage: response?.usage ?? null, error, finishedAt: now,
    leaseToken: null, leaseExpiresAt: null }).where(eq(jobs.id, job.id));
  await tx.update(jobRequests).set({ expiresAt: new Date(now.getTime() + retentionDays * 86_400_000) })
    .where(eq(jobRequests.jobId, job.id));
  const [user] = await tx.select({ callbackUrl: users.callbackUrl }).from(users).where(eq(users.id, job.userId));
  const eventId = randomUUID();
  const type = `job.${outcome.status}` as const;
  await tx.insert(webhookDeliveries).values({
    id: eventId, jobId: job.id, userId: job.userId, eventType: type, callbackUrl: user!.callbackUrl,
    payload: { eventId, type, jobId: job.id, completedAt: now.toISOString() } satisfies TerminalJobEvent,
  });
  // PostgreSQL delivers transactional notifications only after this completion commits.
  await tx.execute(sql`select pg_notify(${JOB_EVENT_CHANNEL}, ${job.id})`);
}
