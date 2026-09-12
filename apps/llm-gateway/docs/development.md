# Development and testing

## Project layout

```text
apps/llm-gateway/
├── migrations/            Generated, reviewed PostgreSQL migrations
├── docs/                  Architecture, API, database, and operational guides
├── src/
│   ├── accounts/          Provider account validation, service, and routes
│   ├── catalogs/          Provider/model catalog service and routes
│   ├── db/                Drizzle schema, pool factory, and migrator
│   ├── jobs/              Submission, execution, lifecycle, retries, retention
│   ├── usage/             Usage validation, aggregation, and routes
│   ├── users/             Users, API keys, settings, and routes
│   ├── webhooks/          Delivery API, signing, retry policy, and worker
│   ├── app.ts             Hono composition and public error boundary
│   ├── auth.ts            Admin and user authentication middleware
│   ├── config.ts          Environment validation
│   ├── crypto.ts          Key hashing, minting, and secret envelopes
│   ├── index.ts           API process entry point
│   └── worker.ts          Worker process entry point
└── tests/                 Unit, PostgreSQL, end-to-end, and opt-in live tests
```

Routes handle HTTP concerns; services handle domain logic and queries. Keep
provider wire formats in provider packages and shared public shapes in contracts.

## Common commands

Run from the monorepo root:

```sh
pnpm install
pnpm build
pnpm check
pnpm test
```

Gateway-specific commands:

```sh
pnpm --filter @llm-providers/llm-gateway dev
pnpm --filter @llm-providers/llm-gateway worker:dev
pnpm --filter @llm-providers/llm-gateway test
pnpm --filter @llm-providers/llm-gateway test:db
pnpm --filter @llm-providers/llm-gateway test:e2e
```

`dev` and `worker:dev` are separate long-running processes. Supply configuration
through the shell or process runner; `.env` files are not loaded automatically.

## Test suites

| Command | Scope | External effects |
| --- | --- | --- |
| `pnpm test` | Provider tests plus gateway database-free tests | No PostgreSQL or provider calls. |
| `... test:db` | Migrations, constraints, transactions, routes, worker state machines | Requires an explicitly disposable PostgreSQL database; provider/callback transport is stubbed. |
| `... test:e2e` | Compiled API and worker processes with all three provider protocols | Creates and drops its own database; uses local TLS fixtures, no real provider calls. |
| `... test:live` | Small OpenAI and Fireworks jobs and continuations | Billable; requires explicit live credentials and a disposable database. |

Never point `TEST_DATABASE_URL` at a production or shared database.

### Database tests

Set `TEST_DATABASE_URL` to a disposable database:

```sh
TEST_DATABASE_URL=postgresql://localhost/llm_gateway_test \
  pnpm --filter @llm-providers/llm-gateway test:db
```

The suite applies migrations and tests real PostgreSQL types, constraints,
indexes, transactions, ownership, idempotency, continuations, retries, leases,
concurrent execution slots, cleanup, webhooks, catalogs, and usage aggregation.

### End-to-end tests

The role in `TEST_DATABASE_URL` must be allowed to create databases, and `openssl`
must be available:

```sh
pnpm build
TEST_DATABASE_URL=postgresql://localhost/postgres \
  pnpm --filter @llm-providers/llm-gateway test:e2e
```

The test creates a uniquely named database, starts compiled API and worker
processes, runs migrations twice, and hosts trusted local HTTPS provider/callback
fixtures. It covers OpenAI JSON, ChatGPT SSE, Fireworks JSON, native continuation,
retry, cancellation, webhook signing/redelivery, usage, cleanup, restart, and
shutdown. It drops only the database it created.

### Live tests

Live tests are intentionally excluded from normal test commands because they can
incur charges. They require `LIVE_OPENAI_API_KEY` and/or
`LIVE_FIREWORKS_API_KEY`. Optional `LIVE_OPENAI_MODEL` and
`LIVE_FIREWORKS_MODEL` values must exist in their package catalogs.

```sh
TEST_DATABASE_URL=postgresql://localhost/postgres \
LIVE_OPENAI_API_KEY=... \
LIVE_FIREWORKS_API_KEY=... \
  pnpm --filter @llm-providers/llm-gateway test:live
```

Credentials stay in the test environment and are encrypted only in the generated
disposable database. Do not place live keys in files, command history, logs, or
fixtures.

## Schema changes

`src/db/schema.ts` is the schema source. After editing it:

```sh
pnpm --filter @llm-providers/llm-gateway db:generate --name describe_change
```

Review generated SQL and metadata. Never edit a migration that may already have
been applied; create a new migration instead. Check data conversion, lock behavior,
backfill cost, rollback/recovery expectations, and compatibility with existing
workers before deployment.

Apply migrations locally with:

```sh
DATABASE_URL=postgresql://localhost/llm_gateway_dev \
  pnpm --filter @llm-providers/llm-gateway db:migrate
```

The migrator is explicit and idempotent. Application startup never runs it.

## Change workflow

For ordinary changes:

1. Update types and validation at the owning boundary.
2. Keep route handlers small and put transactions in services/workers.
3. Add database constraints only for invariants PostgreSQL can evaluate safely.
4. Add focused unit tests and real PostgreSQL coverage when persistence changes.
5. Run `pnpm build`, `pnpm check`, and `pnpm test`.
6. Run `test:db` for database, route, job, webhook, or usage changes.
7. Run `test:e2e` for process wiring, protocols, migrations, or shutdown changes.
8. Update the relevant document in `docs/`.

## Testing principles

- Tests must not contact real providers unless run through `test:live`.
- Simulated provider calls should honor `AbortSignal` and exercise timeout paths.
- Assertions and logs must not print API keys, ciphertext, prompts, or native error
  payloads.
- Concurrency tests should prove the upper bound, unique claims, progress after
  failure, and graceful shutdown—not depend only on wall-clock speed.
- Use exact response/request fixtures for provider protocol behavior.
- Preserve unknown provider-native fields through adapter and database round trips.
- Test idempotency races and lease fencing using real PostgreSQL transactions.

## Documentation changes

- Update [API reference](./api-reference.md) for public contract changes.
- Update [Database design](./database.md) for schema or consistency changes.
- Update [Architecture](./architecture.md) for component boundaries or workflows.
- Update [Operations](./operations.md) for configuration, rollout, security, or
  recovery changes.
