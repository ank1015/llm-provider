import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { webhookDeliveries as deliveries, webhookDeliveryAttempts as attempts, users } from "../db/schema.js";
import { LEASE_MS, MAX_ATTEMPTS, RETRY_WINDOW_MS, retryDelay, type DeliveryResult } from "./policy.js";
import type { Send } from "./sender.js";

export async function claimDelivery(db: Database) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ delivery: deliveries, encryptedSecret: users.webhookSecretEncrypted })
      .from(deliveries).innerJoin(users, eq(users.id, deliveries.userId)).where(and(eq(users.enabled, true), sql`
        (${deliveries.status} in ('pending', 'retry_wait') and ${deliveries.nextAttemptAt} <= now())
        or (${deliveries.status} = 'delivering' and ${deliveries.leaseExpiresAt} <= now())
      `)).orderBy(deliveries.nextAttemptAt, deliveries.id).limit(1).for("update", { of: deliveries, skipLocked: true });
    if (!row) return null;
    const { delivery } = row;
    const now = new Date();
    const [last] = await tx.select().from(attempts).where(eq(attempts.deliveryId, delivery.id)).orderBy(desc(attempts.attemptNumber)).limit(1);
    if (last && !last.finishedAt) {
      await tx.update(attempts).set({ finishedAt: now, error: {
        code: "lease_expired", message: "Worker lease expired; callback acknowledgement is unknown.", retryable: true,
      } }).where(eq(attempts.id, last.id));
    }
    const attemptNumber = (last?.attemptNumber ?? 0) + 1;
    if (attemptNumber >= delivery.retryFromAttempt + MAX_ATTEMPTS || now.getTime() >= delivery.retryStartedAt.getTime() + RETRY_WINDOW_MS) {
      await tx.update(deliveries).set({ status: "failed", leaseToken: null, leaseExpiresAt: null }).where(eq(deliveries.id, delivery.id));
      return { completed: true } as const;
    }
    const leaseToken = randomUUID();
    const [attempt] = await tx.insert(attempts).values({ deliveryId: delivery.id, attemptNumber, startedAt: now }).returning();
    await tx.update(deliveries).set({ status: "delivering", leaseToken, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }).where(eq(deliveries.id, delivery.id));
    return { completed: false, ...row, attempt: attempt!, leaseToken } as const;
  });
}
type Claim = Extract<NonNullable<Awaited<ReturnType<typeof claimDelivery>>>, { completed: false }>;

export async function completeDelivery(db: Database, claim: Claim, result: DeliveryResult) {
  await db.transaction(async (tx) => {
    const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, claim.delivery.id),
      eq(deliveries.status, "delivering"), eq(deliveries.leaseToken, claim.leaseToken))).for("update");
    const now = new Date();
    if (!delivery || delivery.leaseExpiresAt!.getTime() <= now.getTime()) return;
    await tx.update(attempts).set({ finishedAt: now, httpStatus: result.httpStatus ?? null, error: result.error ?? null }).where(eq(attempts.id, claim.attempt.id));
    const cycleAttempt = claim.attempt.attemptNumber - delivery.retryFromAttempt + 1;
    const nextAttemptAt = new Date(now.getTime() + retryDelay(cycleAttempt, result.retryAfterMs));
    const retry = result.error?.retryable && cycleAttempt < MAX_ATTEMPTS
      && nextAttemptAt.getTime() < delivery.retryStartedAt.getTime() + RETRY_WINDOW_MS;
    await tx.update(deliveries).set({
      status: !result.error ? "delivered" : retry ? "retry_wait" : "failed",
      deliveredAt: !result.error ? now : delivery.deliveredAt,
      ...(retry ? { nextAttemptAt } : {}), leaseToken: null, leaseExpiresAt: null,
    }).where(eq(deliveries.id, delivery.id));
  });
}

export async function runOnce(db: Database, send: Send, signal: AbortSignal) {
  if (signal.aborted) return false;
  const claim = await claimDelivery(db);
  if (!claim) return false;
  if (claim.completed) return true;
  if (signal.aborted) return true;
  let result: DeliveryResult;
  try {
    result = await send(claim.delivery, claim.encryptedSecret, signal);
  } catch {
    result = { error: { code: "internal_error", message: "Callback could not be prepared.", retryable: false } };
  }
  // Shutdown leaves an ambiguous attempt for lease recovery, not a false failure.
  if (!signal.aborted) await completeDelivery(db, claim, result);
  return true;
}

/** Independent queue consumer: slow LLM calls do not block callback delivery. */
export async function runWorker(db: Database, send: Send, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      if (await runOnce(db, send, signal)) continue;
    } catch {
      console.error("Webhook worker operation failed; unfinished claims recover after lease expiry.");
    }
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
}
