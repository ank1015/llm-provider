import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";

export const JOB_EVENT_CHANNEL = "llm_gateway_job_terminal";

export interface TerminalJobEvent {
  eventId: string;
  type: "job.succeeded" | "job.failed" | "job.cancelled";
  jobId: string;
  completedAt: string;
}

interface Subscription {
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/** Process-local fanout fed by PostgreSQL notifications from every job worker. */
export class JobEvents {
  readonly #waiters = new Map<string, Set<() => void>>();
  #closed = false;

  subscribe(jobId: string): Subscription {
    let active = !this.#closed;
    let wake!: () => void;
    const notified = new Promise<void>((resolve) => { wake = resolve; });
    if (active) {
      const waiters = this.#waiters.get(jobId) ?? new Set<() => void>();
      waiters.add(wake);
      this.#waiters.set(jobId, waiters);
    } else {
      wake();
    }

    const close = () => {
      if (!active) return;
      active = false;
      const current = this.#waiters.get(jobId);
      current?.delete(wake);
      if (current?.size === 0) this.#waiters.delete(jobId);
    };
    return {
      async wait(timeoutMs, signal) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
          void notified.then(finish);
        });
      },
      close,
    };
  }

  notify(jobId: string) {
    const waiters = this.#waiters.get(jobId);
    if (!waiters) return;
    this.#waiters.delete(jobId);
    for (const wake of waiters) wake();
  }

  /** Stop accepting waits and release every current subscriber during shutdown. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiters of this.#waiters.values()) {
      for (const wake of waiters) wake();
    }
    this.#waiters.clear();
  }
}

/**
 * Hold one dedicated pool connection for LISTEN. Notifications are hints only:
 * wait endpoints always re-read PostgreSQL before returning.
 */
async function runJobEventListener(pool: Pool, events: JobEvents, signal: AbortSignal, ready: () => void) {
  let started = false;
  while (!signal.aborted) {
    let client: PoolClient | undefined;
    let onAbort: (() => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let onNotification: ((message: { channel: string; payload?: string }) => void) | undefined;
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
      onNotification = (message) => {
        if (message.channel === JOB_EVENT_CHANNEL && message.payload) events.notify(message.payload);
      };
      client.on("notification", onNotification);
      await client.query(`LISTEN ${JOB_EVENT_CHANNEL}`);
      if (!started) {
        started = true;
        ready();
      }
      await Promise.race([disconnected, stopped]);
    } catch {
      if (!signal.aborted) console.error("Job completion listener disconnected; reconnecting.");
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      if (client && onDisconnect) client.removeListener("error", onDisconnect);
      if (client && onNotification) client.removeListener("notification", onNotification);
      client?.release(true);
    }
    if (!signal.aborted) await sleep(1000, undefined, { signal }).catch(() => {});
  }
}

/** Establish LISTEN before the API accepts wait requests, then monitor reconnects. */
export async function startJobEventListener(pool: Pool, events: JobEvents, signal: AbortSignal) {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const running = runJobEventListener(pool, events, signal, markReady);
  await ready;
  return { completed: running };
}
