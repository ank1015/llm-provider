# LLM Gateway

A durable, multi-provider LLM gateway built with TypeScript, Hono, and PostgreSQL.
It accepts asynchronous jobs for OpenAI, ChatGPT, and Fireworks, executes them
through the workspace provider packages, records usage, and delivers signed
completion webhooks.

## Quick start

Requirements: Node.js 20+, pnpm, and PostgreSQL. Copy the example settings into
your shell or process manager; the application does not load `.env` files.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @llm-providers/llm-gateway db:migrate
pnpm --filter @llm-providers/llm-gateway start
```

Run the worker separately with the same environment:

```sh
pnpm --filter @llm-providers/llm-gateway worker
```

The API accepts and persists jobs; the worker performs provider calls, request
cleanup, and webhook delivery. Both processes are required for a complete
deployment.

For development with TypeScript source:

```sh
pnpm --filter @llm-providers/llm-gateway dev
pnpm --filter @llm-providers/llm-gateway worker:dev
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `ADMIN_API_KEY` | Yes | Random admin bearer key, 32–512 non-whitespace characters. |
| `ENCRYPTION_KEY` | Yes | Persistent 32-byte key encoded as 64 hexadecimal characters. |
| `PORT` | No | API port; default `3000`. |
| `REQUEST_RETENTION_DAYS` | No | Terminal-job input retention, 1–365 days; default `7`. |
| `WORKER_CONCURRENCY` | No | Simultaneous LLM jobs per worker process, 1–128; default `1`. |
| `PROVIDER_ALLOWED_ORIGINS` | No | Comma-separated additional trusted provider origins. |
| `WEBHOOK_ALLOWED_ORIGINS` | No | Comma-separated trusted HTTPS callback origins. |

Generate `ADMIN_API_KEY` and `ENCRYPTION_KEY` independently and keep them stable
and outside source control. Changing `ENCRYPTION_KEY` without re-encrypting
stored secrets makes existing provider and webhook credentials unreadable.

See [.env.example](./.env.example) for a complete template and
[Operations](./docs/operations.md) for deployment and security guidance.

## API overview

- Admin endpoints register and manage users and API keys.
- User endpoints manage settings and provider accounts.
- Catalog endpoints expose the provider packages' model catalogs.
- Job endpoints submit, inspect, list, continue, and cancel LLM work.
- Webhook endpoints inspect delivery history and request redelivery.
- Usage endpoints report token and estimated cost data.
- `/healthz` and `/readyz` provide liveness and database readiness.

Every user-scoped request uses `Authorization: Bearer <user-key>`. Job submission
returns `202` after durable acceptance; retrieve the result by job ID or receive
the terminal webhook.

## Documentation

- [Architecture](./docs/architecture.md) — components, data flow, concurrency,
  consistency, and trust boundaries.
- [API reference](./docs/api-reference.md) — endpoints, request shapes, response
  shapes, authentication, and status behavior.
- [Database design](./docs/database.md) — tables, constraints, indexes,
  transactions, leases, retries, and retention.
- [Operations](./docs/operations.md) — configuration, deployment, scaling,
  health checks, security, and recovery.
- [Development and testing](./docs/development.md) — project layout, commands,
  migrations, test suites, and contribution workflow.

## Important semantics

- Provider execution and webhook delivery are **at least once**, not exactly
  once. Lease recovery after an ambiguous failure can repeat an external call.
- `idempotencyKey` deduplicates gateway submissions; it cannot undo a provider
  request already sent.
- Provider credentials and webhook secrets are encrypted at rest. API keys are
  stored as hashes.
- Native provider response content is preserved for compatible continuation.
- Usage costs are catalog-based estimates, not provider billing reconciliation.
- No user fairness or rate limiting is built in; enforce admission controls at
  the deployment boundary.

The built-in server listens over HTTP. Terminate public traffic with HTTPS and
restrict outbound provider and callback destinations in production.
