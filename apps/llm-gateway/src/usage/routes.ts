import { Hono } from "hono";
import { userAuth, type UserEnv } from "../auth.js";
import type { Database } from "../db/client.js";
import { limitManagementBody, parse } from "../http.js";
import { getUsage } from "./service.js";
import { query } from "./validation.js";

export function createUsageRoutes(db: Database) {
  const app = new Hono<UserEnv>();
  app.use("*", userAuth(db), limitManagementBody);
  app.get("/", async (c) => c.json(await getUsage(db, c.var.user.id, parse(query, c.req.query()))));
  return app;
}
