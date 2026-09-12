import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to run migrations.");

const { db, pool } = createDatabase(connectionString, { migration: true });
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
  });
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
