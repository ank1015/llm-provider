import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { userAuth, type UserEnv } from "../auth.js";
import type { Database } from "../db/client.js";
import { body, parse } from "../http.js";
import { pagination } from "../pagination.js";
import { DEFAULT_RETENTION_DAYS, MAX_REQUEST_BYTES } from "./policy.js";
import { listQuery, submission } from "./validation.js";
import * as service from "./service.js";

export function createJobRoutes(db: Database, extraOrigins: readonly string[] = [], retentionDays = DEFAULT_RETENTION_DAYS) {
  const app = new Hono<UserEnv>();
  const uuid = z.uuid();
  app.use("*", userAuth(db), bodyLimit({ maxSize: MAX_REQUEST_BYTES,
    onError: (c) => c.json({ error: { code: "request_too_large", message: "Job requests are limited to 16 MiB." } }, 413) }));
  app.post("/", async (c) => c.json(await service.submitJob(db, c.var.user.id, await body(c, submission), extraOrigins), 202));
  app.get("/", async (c) => {
    const query = parse(listQuery, c.req.query());
    const { cursor: _, ...filters } = query;
    return c.json(await service.listJobs(db, c.var.user.id, { ...filters, ...pagination(query) }));
  });
  app.get("/:jobId", async (c) => c.json(await service.getJob(db, c.var.user.id, parse(uuid, c.req.param("jobId")))));
  app.get("/:jobId/attempts", async (c) => c.json(await service.listAttempts(db, c.var.user.id, parse(uuid, c.req.param("jobId")))));
  app.post("/:jobId/cancel", async (c) => c.json(await service.cancelJob(db, c.var.user.id, parse(uuid, c.req.param("jobId")), retentionDays)));
  return app;
}
