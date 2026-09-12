import { Hono } from "hono";
import { z } from "zod";
import { userAuth, type UserEnv } from "../auth.js";
import type { Database } from "../db/client.js";
import { body, limitManagementBody, parse } from "../http.js";
import { pageQuery, pagination } from "../pagination.js";
import { createInput, patchInput, provider } from "./validation.js";
import * as service from "./service.js";

const uuid = z.uuid();
const listQuery = pageQuery.extend({ provider: provider.optional() });

export function createAccountRoutes(db: Database, encryptionKey: Buffer) {
  const app = new Hono<UserEnv>();
  app.use("*", userAuth(db), limitManagementBody);
  app.post("/", async (c) => c.json(await service.createAccount(db, encryptionKey, c.var.user.id, await body(c, createInput)), 201));
  app.get("/", async (c) => {
    const query = parse(listQuery, c.req.query());
    return c.json(await service.listAccounts(db, c.var.user.id, { ...pagination(query), provider: query.provider }));
  });
  app.get("/:accountId", async (c) => c.json(await service.getAccount(db, c.var.user.id, parse(uuid, c.req.param("accountId")))));
  app.patch("/:accountId", async (c) => c.json(await service.updateAccount(db, encryptionKey, c.var.user.id,
    parse(uuid, c.req.param("accountId")), await body(c, patchInput))));
  app.delete("/:accountId", async (c) => {
    await service.deleteAccount(db, c.var.user.id, parse(uuid, c.req.param("accountId")));
    return c.body(null, 204);
  });
  return app;
}
