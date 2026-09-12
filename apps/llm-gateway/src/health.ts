import { Hono } from "hono";
import type { Database } from "./db/client.js";

const probe = { text: "select id from jobs limit 0", query_timeout: 2_000 };

export function createHealthRoutes(db: Database) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    try {
      // Also fails before migrations; reads no job data. Pool acquisition is bounded separately.
      await db.$client.query(probe);
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "not_ready" }, 503);
    }
  });
  return app;
}
