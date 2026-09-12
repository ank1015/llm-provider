import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { webhookDeliveries as deliveries, webhookDeliveryAttempts as attempts } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { page, type PageInput } from "../pagination.js";

const fields = {
  id: deliveries.id, jobId: deliveries.jobId, eventType: deliveries.eventType,
  callbackUrl: deliveries.callbackUrl, status: deliveries.status, createdAt: deliveries.createdAt,
  deliveredAt: deliveries.deliveredAt, nextAttemptAt: deliveries.nextAttemptAt,
  retryFromAttempt: deliveries.retryFromAttempt, retryStartedAt: deliveries.retryStartedAt,
};
const owned = (userId: string, id: string) => and(eq(deliveries.userId, userId), eq(deliveries.id, id));
type Status = typeof deliveries.$inferSelect.status;

export async function listDeliveries(db: Database, userId: string, input: PageInput & { jobId?: string; status?: Status }) {
  const rows = await db.select({ ...fields,
    cursorTime: sql<string>`to_char(${deliveries.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(deliveries).where(and(eq(deliveries.userId, userId),
    input.jobId ? eq(deliveries.jobId, input.jobId) : undefined,
    input.status ? eq(deliveries.status, input.status) : undefined,
    input.cursor ? sql`(${deliveries.createdAt}, ${deliveries.id}) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)` : undefined,
  )).orderBy(desc(deliveries.createdAt), desc(deliveries.id)).limit(input.limit + 1);
  return page(rows, input.limit);
}

export async function getDelivery(db: Database, userId: string, id: string, input: { attemptLimit: number; attemptCursor?: number }) {
  const [delivery] = await db.select({ ...fields, payload: deliveries.payload }).from(deliveries).where(owned(userId, id));
  if (!delivery) notFound("Webhook delivery");
  const rows = await db.select().from(attempts).where(and(eq(attempts.deliveryId, id),
    input.attemptCursor ? lt(attempts.attemptNumber, input.attemptCursor) : undefined,
  )).orderBy(desc(attempts.attemptNumber)).limit(input.attemptLimit + 1);
  const data = rows.slice(0, input.attemptLimit);
  return { ...delivery, attempts: { data, nextCursor: rows.length > input.attemptLimit ? data.at(-1)!.attemptNumber : null } };
}

export async function redeliver(db: Database, userId: string, id: string) {
  return db.transaction(async (tx) => {
    const [delivery] = await tx.select(fields).from(deliveries).where(owned(userId, id)).for("update");
    if (!delivery) notFound("Webhook delivery");
    if (delivery.status !== "delivered" && delivery.status !== "failed") {
      throw new ApiError(409, "delivery_already_scheduled", "This delivery is already scheduled or in progress.");
    }
    const [last] = await tx.select({ number: attempts.attemptNumber }).from(attempts)
      .where(eq(attempts.deliveryId, id)).orderBy(desc(attempts.attemptNumber)).limit(1);
    const [updated] = await tx.update(deliveries).set({ status: "pending", retryFromAttempt: (last?.number ?? 0) + 1,
      retryStartedAt: new Date(), nextAttemptAt: new Date(), leaseToken: null, leaseExpiresAt: null,
    }).where(eq(deliveries.id, id)).returning(fields);
    return updated!;
  });
}
