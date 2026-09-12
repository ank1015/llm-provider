import { Hono } from "hono";
import { z } from "zod";
import { adminAuth, userAuth, type UserEnv } from "../auth.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { body, limitManagementBody, parse } from "../http.js";
import { pageQuery, pagination } from "../pagination.js";
import * as service from "./service.js";

const name = z.string().trim().min(1).max(200);
const callbackUrl = z.url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, "Callback URL must use HTTPS without credentials or a fragment.");
const createInput = z.strictObject({ name, callbackUrl });
const userPatch = createInput.partial().refine((value) => Object.keys(value).length > 0, "Provide a field to update.");
const adminPatch = createInput.extend({ enabled: z.boolean() }).partial()
  .refine((value) => Object.keys(value).length > 0, "Provide a field to update.");
const keyInput = z.strictObject({ name: name.optional() });
const uuid = z.uuid();

export function createUserRoutes(db: Database, config: Pick<Config, "adminApiKey" | "encryptionKey">) {
  const admin = new Hono();
  admin.use("*", adminAuth(config.adminApiKey), limitManagementBody);
  admin.post("/", async (c) => c.json(await service.createUser(db, config.encryptionKey, await body(c, createInput)), 201));
  admin.get("/", async (c) => c.json(await service.listUsers(db, pagination(parse(pageQuery, c.req.query())))));
  admin.get("/:userId", async (c) => c.json(await service.getUser(db, parse(uuid, c.req.param("userId")))));
  admin.patch("/:userId", async (c) => c.json(await service.updateUser(db, parse(uuid, c.req.param("userId")), await body(c, adminPatch))));
  admin.post("/:userId/keys", async (c) => {
    const id = parse(uuid, c.req.param("userId"));
    const input = await body(c, keyInput);
    return c.json(await service.issueKey(db, id, input.name), 201);
  });
  admin.get("/:userId/keys", async (c) => c.json(await service.listKeys(db, parse(uuid, c.req.param("userId")), pagination(parse(pageQuery, c.req.query())))));
  admin.delete("/:userId/keys/:keyId", async (c) => {
    await service.revokeKey(db, parse(uuid, c.req.param("userId")), parse(uuid, c.req.param("keyId")));
    return c.body(null, 204);
  });

  const me = new Hono<UserEnv>();
  me.use("*", userAuth(db), limitManagementBody);
  me.get("/", (c) => c.json(c.var.user));
  me.patch("/", async (c) => c.json(await service.updateUser(db, c.var.user.id, await body(c, userPatch))));
  me.post("/webhook-secret/rotate", async (c) => c.json(await service.rotateWebhookSecret(db, config.encryptionKey, c.var.user.id)));
  return { admin, me };
}
