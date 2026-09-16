import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";

export const JOB_READY_CHANNEL = "llm_gateway_job_ready";
export const WEBHOOK_READY_CHANNEL = "llm_gateway_webhook_ready";

/**
 * A generation-based wakeup avoids losing a notification between a queue scan
 * and the worker beginning to wait. PostgreSQL remains the source of truth.
 */
export class WorkSignal {
  #generation = 0;
  readonly #waiters = new Set<() => void>();

  snapshot() {
    return this.#generation;
  }

  notify() {
    this.#generation++;
    this.#waiters.values().next().value?.();
  }

  async wait(observed: number, fallbackMs: number, signal?: AbortSignal) {
    if (this.#generation !== observed || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, fallbackMs);
      this.#waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (this.#generation !== observed || signal?.aborted) finish();
    });
  }
}

/** One dedicated connection fans transactional PostgreSQL notifications into workers. */
export async function runWorkSignalListener(pool: Pool, signals: ReadonlyMap<string, WorkSignal>,
  signal: AbortSignal, ready: () => void = () => {}) {
  let started = false;
  while (!signal.aborted) {
    let client: PoolClient | undefined;
    let onAbort: (() => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let onNotification: ((message: { channel: string }) => void) | undefined;
    try {
      client = await pool.connect();
      if (signal.aborted) continue;
      const disconnected = new Promise<void>((resolve) => {
        onDisconnect = resolve;
        client!.once("error", onDisconnect);
      });
      const stopped = new Promise<void>((resolve) => {
        onAbort = resolve;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      onNotification = (message) => signals.get(message.channel)?.notify();
      client.on("notification", onNotification);
      for (const channel of signals.keys()) await client.query(`LISTEN ${channel}`);
      if (!started) {
        started = true;
        ready();
      }
      await Promise.race([disconnected, stopped]);
    } catch {
      if (!signal.aborted) console.error("Work notification listener disconnected; reconnecting.");
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      if (client && onDisconnect) client.removeListener("error", onDisconnect);
      if (client && onNotification) client.removeListener("notification", onNotification);
      client?.release(true);
    }
    if (!signal.aborted) await sleep(1000, undefined, { signal }).catch(() => {});
  }
}

/** Establish LISTEN before queue workers begin scanning. */
export async function startWorkSignalListener(pool: Pool, signals: ReadonlyMap<string, WorkSignal>, signal: AbortSignal) {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const completed = runWorkSignalListener(pool, signals, signal, markReady);
  await ready;
  return { completed };
}
