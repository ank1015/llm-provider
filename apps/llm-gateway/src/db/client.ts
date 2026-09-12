import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

/** Create one pool per process; the caller owns its lifecycle. */
export function createDatabase(connectionString: string, { migration = false } = {}) {
  if (!connectionString?.trim()) throw new Error("A PostgreSQL connection string is required.");
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    lock_timeout: 3_000,
    statement_timeout: migration ? 300_000 : 5_000,
    query_timeout: migration ? 310_000 : 10_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
