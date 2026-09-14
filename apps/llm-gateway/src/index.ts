import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { JobEvents, startJobEventListener } from "./jobs/events.js";

const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl);
pool.on("error", () => console.error("Unexpected idle PostgreSQL connection failure."));
const controller = new AbortController();
const events = new JobEvents();
const { completed: eventListener } = await startJobEventListener(pool, events, controller.signal);
const app = createApp(db, config, events);

const server = serve({
  fetch: app.fetch,
  port: config.port,
}, (info) => {
  console.log(`LLM gateway listening on port ${info.port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  events.close();
  controller.abort();
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    void eventListener.then(() => pool.end()).then(() => clearTimeout(timeout)).catch(() => process.exit(1));
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
