import { setMaxListeners } from "node:events";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createExecutor } from "./jobs/provider.js";
import { runWorker } from "./jobs/worker.js";
import { createSender } from "./webhooks/sender.js";
import { runWorker as runWebhookWorker } from "./webhooks/worker.js";
import { JOB_READY_CHANNEL, WEBHOOK_READY_CHANNEL, WorkSignal, startWorkSignalListener } from "./work-signal.js";

const config = loadConfig();
const { db, pool } = createDatabase(config.databaseUrl);
pool.on("error", () => console.error("Unexpected idle PostgreSQL connection failure."));
const controller = new AbortController();
const jobWake = new WorkSignal();
const webhookWake = new WorkSignal();
const { completed: workListener } = await startWorkSignalListener(pool, new Map([
  [JOB_READY_CHANNEL, jobWake],
  [WEBHOOK_READY_CHANNEL, webhookWake],
]), controller.signal);
// Each execution slot observes shutdown, as do cleanup and callback delivery.
setMaxListeners(config.workerConcurrency + 10, controller.signal);
function shutdown() {
  if (controller.signal.aborted) return;
  controller.abort();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await Promise.all([
    runWorker(db, createExecutor(config.encryptionKey, config.providerOrigins), controller.signal,
      config.requestRetentionDays, config.workerConcurrency, jobWake),
    runWebhookWorker(db, createSender(config.encryptionKey, config.webhookOrigins), controller.signal, webhookWake),
    workListener,
  ]);
} finally {
  await pool.end();
}
