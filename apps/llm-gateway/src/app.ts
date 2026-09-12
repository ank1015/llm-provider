import { Hono } from "hono";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { ApiError } from "./errors.js";
import { createUserRoutes } from "./users/routes.js";
import { createAccountRoutes } from "./accounts/routes.js";
import { createJobRoutes } from "./jobs/routes.js";
import { createWebhookRoutes } from "./webhooks/routes.js";
import { createUsageRoutes } from "./usage/routes.js";
import { createCatalogRoutes } from "./catalogs/routes.js";
import { createHealthRoutes } from "./health.js";

export function createApp(db: Database, config: Pick<Config, "adminApiKey" | "encryptionKey"> & Partial<Pick<Config, "providerOrigins" | "requestRetentionDays">>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    // Do not expose database errors or request/credential values.
    console.error("Unexpected gateway request failure.");
    return c.json({ error: { code: "internal_error", message: "Internal server error." } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Endpoint not found." } }, 404));
  app.get("/", (c) => c.json({ name: "llm-gateway" }));
  app.route("/", createHealthRoutes(db));
  app.route("/v1", createCatalogRoutes(db));
  const routes = createUserRoutes(db, config);
  app.route("/v1/admin/users", routes.admin);
  app.route("/v1/me", routes.me);
  app.route("/v1/accounts", createAccountRoutes(db, config.encryptionKey));
  app.route("/v1/jobs", createJobRoutes(db, config.providerOrigins, config.requestRetentionDays));
  app.route("/v1/webhook-deliveries", createWebhookRoutes(db));
  app.route("/v1/usage", createUsageRoutes(db));
  return app;
}
