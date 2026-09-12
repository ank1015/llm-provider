import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl);
pool.on("error", () => console.error("Unexpected idle PostgreSQL connection failure."));
const app = createApp(db, config);

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
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    void pool.end().then(() => clearTimeout(timeout)).catch(() => process.exit(1));
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
