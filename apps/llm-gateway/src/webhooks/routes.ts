import { Hono } from "hono";
import { z } from "zod";
import { userAuth, type UserEnv } from "../auth.js";
import type { Database } from "../db/client.js";
import { limitManagementBody, parse } from "../http.js";
import { pageQuery, pagination } from "../pagination.js";
import * as service from "./service.js";

const listQuery = pageQuery.extend({ jobId: z.uuid().optional(), status: z.enum(["pending", "delivering", "retry_wait", "delivered", "failed"]).optional() });
const detailQuery = z.strictObject({ attemptLimit: z.coerce.number().int().min(1).max(100).default(50),
  attemptCursor: z.coerce.number().int().positive().max(2_147_483_647).optional() });

export function createWebhookRoutes(db: Database) {
  const app = new Hono<UserEnv>();
  app.use("*", userAuth(db), limitManagementBody);
  app.get("/", async (c) => {
    const query = parse(listQuery, c.req.query());
    return c.json(await service.listDeliveries(db, c.var.user.id, { ...pagination(query), jobId: query.jobId, status: query.status }));
  });
  app.get("/:deliveryId", async (c) => c.json(await service.getDelivery(db, c.var.user.id,
    parse(z.uuid(), c.req.param("deliveryId")), parse(detailQuery, c.req.query()))));
  app.post("/:deliveryId/redeliver", async (c) => c.json(await service.redeliver(db, c.var.user.id, parse(z.uuid(), c.req.param("deliveryId"))), 202));
  return app;
}
