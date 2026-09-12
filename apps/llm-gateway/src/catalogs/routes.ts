import { Hono } from "hono";
import { z } from "zod";
import { userAuth, type UserEnv } from "../auth.js";
import type { Database } from "../db/client.js";
import { parse } from "../http.js";
import { provider } from "../accounts/validation.js";
import { getAccountModels, getModels, PROVIDERS } from "./service.js";

const noQuery = z.strictObject({});
const modelQuery = z.strictObject({ provider: provider.optional() });

export function createCatalogRoutes(db: Database) {
  const app = new Hono<UserEnv>();
  const auth = userAuth(db);
  app.get("/providers", auth, (c) => {
    parse(noQuery, c.req.query());
    return c.json({ data: PROVIDERS });
  });
  app.get("/models", auth, (c) => {
    const query = parse(modelQuery, c.req.query());
    return c.json({ data: getModels(query.provider) });
  });
  app.get("/accounts/:accountId/models", auth, async (c) => {
    parse(noQuery, c.req.query());
    return c.json({ data: await getAccountModels(db, c.var.user.id, parse(z.uuid(), c.req.param("accountId"))) });
  });
  return app;
}
