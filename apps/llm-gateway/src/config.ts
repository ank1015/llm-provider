import { z } from "zod";
import { DEFAULT_RETENTION_DAYS } from "./jobs/policy.js";

const origins = z.string().default("").transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      && url.origin === value;
  })));

const environment = z.object({
  DATABASE_URL: z.url().refine((value) => /^postgres(?:ql)?:\/\//.test(value)),
  ADMIN_API_KEY: z.string().min(32).max(512).regex(/^\S+$/),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  PROVIDER_ALLOWED_ORIGINS: origins,
  WEBHOOK_ALLOWED_ORIGINS: origins.refine((values) => values.every((value) => value.startsWith("https://"))),
  REQUEST_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(DEFAULT_RETENTION_DAYS),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(1),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = environment.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid gateway configuration: ${fields.join(", ")}.`);
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    adminApiKey: result.data.ADMIN_API_KEY,
    encryptionKey: Buffer.from(result.data.ENCRYPTION_KEY, "hex"),
    port: result.data.PORT,
    providerOrigins: result.data.PROVIDER_ALLOWED_ORIGINS,
    webhookOrigins: result.data.WEBHOOK_ALLOWED_ORIGINS,
    requestRetentionDays: result.data.REQUEST_RETENTION_DAYS,
    workerConcurrency: result.data.WORKER_CONCURRENCY,
  };
}

export type Config = ReturnType<typeof loadConfig>;
