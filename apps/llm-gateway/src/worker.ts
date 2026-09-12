import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createExecutor } from "./jobs/provider.js";
import { runWorker } from "./jobs/worker.js";
import { createSender } from "./webhooks/sender.js";
import { runWorker as runWebhookWorker } from "./webhooks/worker.js";

const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl);
pool.on("error", () => console.error("Unexpected idle PostgreSQL connection failure."));
const controller = new AbortController();
function shutdown() {
  if (controller.signal.aborted) return;
  controller.abort();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await Promise.all([
    runWorker(db, createExecutor(config.encryptionKey, config.providerOrigins), controller.signal, config.requestRetentionDays),
    runWebhookWorker(db, createSender(config.encryptionKey, config.webhookOrigins), controller.signal),
  ]);
} finally {
  await pool.end();
}
