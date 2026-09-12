import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { jobs, jobRequests } from "../db/schema.js";

/** Lock parent jobs just like continuation does; never delete active job inputs. */
export async function cleanupRequests(db: Database) {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: jobs.id }).from(jobRequests).innerJoin(jobs, eq(jobs.id, jobRequests.jobId))
      .where(and(sql`${jobRequests.expiresAt} <= now()`, inArray(jobs.status, ["succeeded", "failed", "cancelled"])))
      .orderBy(jobRequests.expiresAt, jobRequests.jobId).limit(100).for("update", { of: jobs, skipLocked: true });
    if (rows.length) await tx.delete(jobRequests).where(inArray(jobRequests.jobId, rows.map((row) => row.id)));
    return rows.length;
  });
}
