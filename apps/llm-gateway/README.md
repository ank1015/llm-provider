# LLM Gateway

TypeScript application using Hono and its Node.js adapter.

Before starting, configure these environment variables and apply migrations:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `ADMIN_API_KEY` | Yes | Separate admin bearer key: 32–512 non-whitespace characters; use a cryptographically random value. |
| `ENCRYPTION_KEY` | Yes | Persistent 32-byte encryption key encoded as 64 hexadecimal characters. |
| `PORT` | No | HTTP port, default 3000. |
| `REQUEST_RETENTION_DAYS` | No | Input retention after terminal completion, 1–365 days; default 7. |
| `PROVIDER_ALLOWED_ORIGINS` | No | Comma-separated additional trusted origins, e.g. `https://proxy.example.com`. Default: none. |
| `WEBHOOK_ALLOWED_ORIGINS` | No | Comma-separated trusted HTTPS callback origins, e.g. `https://callbacks.example.com`. Default: none (sending denied). |

Generate deployment secrets independently, for example by running
`node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`
once for each key. Keep their values out of source control and logs. Environment
files are not loaded automatically. Invalid configuration stops startup without
printing its values.

From the monorepo root:

```sh
pnpm --filter @llm-providers/llm-gateway dev
```

The server defaults to port `3000`; set `PORT` to override it.
`GET /` returns `{ "name": "llm-gateway" }`.

To build and run the compiled application:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @llm-providers/llm-gateway db:migrate
pnpm --filter @llm-providers/llm-gateway start
```

Admin user/key management, user authentication, `/v1/me`, webhook-secret rotation,
provider account CRUD, jobs with input cleanup, signed webhook delivery,
usage reporting, catalogs, and operational health endpoints are implemented.
See [api-endpoints.md](./api-endpoints.md) and [db_schema.md](./db_schema.md).

Build from the monorepo root so workspace provider dependencies are compiled too.
Run the separate worker command below with the same configuration; starting the
HTTP API alone accepts jobs but does not execute them. `.env.example` lists the
settings without usable credentials. Supply values through your process manager
or shell; no dotenv loader is installed.

## Operational health

- `GET /healthz` returns `200 { "status": "ok" }` without database access.
- `GET /readyz` returns `200 { "status": "ready" }` if PostgreSQL is reachable
  and the core `jobs` table can be queried, otherwise `503 { "status": "not_ready" }`.

Both are public, uncached, and disclose no connection details. Readiness uses a
two-second query timeout and the pool's five-second connection/acquisition
timeout. It is an API/database probe, not a complete schema-version check or a
guarantee of worker availability, provider access, balance, or callback health.
Apply all migrations before deploying API and worker processes. Supervise both
processes and monitor queue age and failed deliveries separately.

SIGINT/SIGTERM stops API admission, closes the HTTP server and database pool,
and aborts worker calls for lease recovery. Shutdown is capped at ten seconds.
Deploy behind HTTPS termination and operator-managed access/rate controls.

## Users and credentials

Admin endpoints use `Authorization: Bearer <ADMIN_API_KEY>`. Register a user with
`POST /v1/admin/users` and `{ "name": "My app", "callbackUrl": "https://example.com/llm-events" }`.
Save the returned `key.secret` and `webhookSecret`; they are only returned once.
Use the user key as a bearer credential for user-scoped endpoints.

User API keys contain 32 random bytes and are stored as SHA-256 hashes. Revoked
keys and keys belonging to disabled users fail authentication. User settings
cannot change enabled status or another user's identity. Read responses use
explicit field projections and never return hashes or ciphertext.

Webhook secrets are stored in versioned AES-256-GCM envelopes with random nonces
and authenticated owner/purpose binding (`user:<id>:webhook`). `ENCRYPTION_KEY`
must stay stable across restarts/deployments. Changing it without a data
re-encryption plan makes existing ciphertext unreadable; multi-key encryption
rotation is not implemented. Webhook-secret rotation replaces that user's
secret, not this deployment encryption key.

User registration validates and stores callback URLs without contacting them.
The worker sends terminal events only to operator-allowlisted HTTPS origins.
See [Webhooks](#webhooks) for signatures, retry policy, and receiver verification.
Terminate external traffic with HTTPS; the local Node server itself serves HTTP.

## Provider accounts

Use a user bearer key with `/v1/accounts` to create, list, retrieve, update, and
soft-delete accounts. Each provider has its own accepted configuration and
credential fields; see the request examples in
[api-endpoints.md](./api-endpoints.md#3-provider-accounts).

`accounts/routes.ts` handles HTTP, `accounts/service.ts` handles scoped queries
and transactions, and `accounts/validation.ts` checks input shape and delegates
client configuration semantics to the existing provider constructors. No
provider requests are made during account management. Shared HTTP parsing and
pagination helpers are used by both users and accounts.

Credentials are encrypted with AES-256-GCM and authenticated against
`user:<userId>:account:<accountId>:<provider>:secrets`. Read/return projections
exclude them. PATCH merges supplied config/secret fields under a row lock and
increments `configVersion` only for effective setting changes. Empty or null
config/secret patches are not reset operations.

Deleted accounts are disabled and hidden from reads/lists but retain historical
rows, job references, and encrypted credentials. Account management does not
alter queued/running jobs directly. Workers reject new attempts for a disabled
user or disabled/deleted account; already claimed calls may finish. Credential
purge remains future work. `/v1/accounts/:accountId/models` returns the packaged
model catalog for an owned, nondeleted account, including disabled accounts.

## Catalogs

With a user bearer key:

- `GET /v1/providers` returns `{ data: [{ id, name }, ...] }` for OpenAI, ChatGPT,
  and Fireworks.
- `GET /v1/models` returns `{ data: Model[] }` from all three provider packages;
  `?provider=openai` (or `chatgpt` / `fireworks`) filters the result.
- `GET /v1/accounts/:accountId/models` returns the catalog for that account's
  provider. Foreign, missing, and deleted accounts return `404`; disabled
  accounts remain readable. General catalog reads need no configured account.

These small static lists are unpaginated, in provider/package order. Models
preserve the contracts shape, including pricing and context/output limits.
Equal model IDs from different providers remain separate entries. Prices are
the packaged per-million-token USD estimates, not a live provider pricing check.
Unknown filters and invalid provider/UUID values return `400`.

`catalogs/routes.ts` owns the three routes and validation; `catalogs/service.ts`
exposes the existing package catalogs and reuses the owned-account lookup.
Job model validation shares this lookup. There are no duplicated model records,
database tables, credential decryptions, or upstream requests. Listing a model
does not verify that an account can access it remotely. No new migration or
configuration is required.

## Jobs and worker

Submit a user-authenticated `POST /v1/jobs`:

```json
{
  "idempotencyKey": "conversation-1-turn-1",
  "accountId": "your-gateway-account-uuid",
  "modelId": "gpt-6-astra",
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Hello" }] }]
}
```

The API returns `{ id, status }` with `202` after saving the job and full input.
Use `GET /v1/jobs/:id` for its final `AssistantResponse`, or submit a continuation
with `{ idempotencyKey, previousJobId, messages }`. Continuations inherit the
input settings and append the previous assistant message plus new messages.
They require an owned successful parent whose request has not expired. Each
child stores an independent snapshot. Idempotent replays still work after input
expiry. See [api-endpoints.md](./api-endpoints.md#5-jobs-llm-requests) for all shapes.

Run **both** the API and worker with the same database, encryption key, retention,
and origin configuration. In a separate terminal, for development:

```sh
pnpm --filter @llm-providers/llm-gateway worker:dev
```

For compiled deployments, build first and start a separate worker process:

```sh
pnpm --filter @llm-providers/llm-gateway worker
```

Each worker process runs one job consumer and one independent webhook consumer;
long LLM calls do not block callbacks. Run additional processes for concurrency.
PostgreSQL row locks and renewable 60-second leases coordinate claims. Heartbeats
run every ten seconds. Provider I/O happens outside transactions. Each attempt
uses current account config/credentials and records their version. Final results
are fenced by the live lease token; stale workers cannot overwrite newer state.
On shutdown, in-flight calls are aborted and left for lease recovery, not marked
as user-cancelled. Provider execution is **not exactly once**: retries or recovery
after ambiguous failures can incur additional charges.

The global policy allows three attempts within 30 minutes from creation,
exponential jitter for transient failures, and provider delay hints. Account
timeouts are respected and capped by the remaining job deadline. Cancellation
is best-effort and never reverses charges. Usage is stored per attempt; unknown
counts/costs remain null. No per-user scheduling fairness or rate limiting is
implemented yet; deploy behind suitable access/rate controls.

Terminal transitions atomically save the outcome, set input expiry, and enqueue
one pending webhook event using the user's callback URL at completion. The
webhook consumer delivers it independently. Between LLM calls, the job consumer checks for expired terminal
inputs at most once per minute, draining full batches of 100. Retention
changes affect future completions only. Results, attempts, webhook payloads,
and idempotency records remain until separate retention policies are added.

### Provider destination policy

Default provider origins (`https://api.openai.com`, `https://chatgpt.com`, and
`https://api.fireworks.ai`, each for its respective provider) are permitted.
Custom account base URLs must use an exact additional origin configured by the
operator via `PROVIDER_ALLOWED_ORIGINS`, both at acceptance and execution.
Entries are canonical origins only: no path, trailing slash, credentials, query,
or fragment. HTTPS is required except exact loopback HTTP origins for local
development, such as `http://127.0.0.1:8080`. Redirects are rejected by clients.

Only allow origins/DNS you control or trust; these hosts receive account
credentials. Do not allow tenant-controlled domains. This is an operator trust
boundary, not a general-purpose public-URL fetcher; use deployment egress rules
as an additional network boundary. The gateway does not fetch message image
URLs itself. Callback destinations use the separate `WEBHOOK_ALLOWED_ORIGINS`
allowlist described below.

### Code layout

- `jobs/routes.ts`: authentication, parsing, and HTTP responses.
- `jobs/service.ts`: submission/idempotency, continuation, queries, cancellation.
- `jobs/validation.ts`: local HTTP shapes matching contracts.
- `jobs/provider.ts`: existing client selection and credential/destination handling.
- `jobs/worker.ts`: claims, attempts, leases, execution, retry scheduling.
- `jobs/lifecycle.ts`: atomic terminal result, expiry, and pending callback writes.
- `jobs/policy.ts`: shared limits, retry decisions, and safe errors.
- `jobs/retention.ts`: bounded input cleanup.
- `src/worker.ts`: process startup/shutdown; no queue service or repository layer.

## Webhooks

Apply migrations before starting the updated API/worker; migration
`0003_webhook_retry_cycles.sql` adds the retry-cycle boundary and start time.
The existing `worker:dev` / `worker` commands now run both queue consumers.

Set `WEBHOOK_ALLOWED_ORIGINS` to canonical HTTPS origins you control or trust:

```sh
export WEBHOOK_ALLOWED_ORIGINS=https://callbacks.example.com,https://another.example.com
pnpm --filter @llm-providers/llm-gateway db:migrate
pnpm --filter @llm-providers/llm-gateway worker:dev
```

No origins are implicitly allowed, including provider origins. Callback paths
and query strings are allowed, but configuration entries contain only origins:
no path, trailing slash, credentials, query, or fragment. HTTP callbacks and
redirects are rejected. An unapproved origin fails the delivery without sending;
after correcting configuration, explicitly redeliver the event. Only trust
operator-controlled DNS/domains, not tenant-controlled origins. Keep deployment
egress restrictions in place as another network boundary.

The consumer sends the immutable event JSON using HTTPS POST. It reads only the
acknowledgement status, discards the response body, and treats any 2xx as success.
Callback HTTP I/O has a ten-second timeout, shorter than its 60-second lease, so
there is no long-call heartbeat loop here. Expired claims recover as ambiguous
attempts; late acknowledgements cannot overwrite a newer claim. Delivery is
at least once: receivers must deduplicate by event ID.

Retries allow eight attempts within 24 hours per cycle. Network failures,
timeouts, and HTTP 408, 429, 500, 502, 503, 504 are retryable; other HTTP statuses
(including redirects) and preparation/configuration errors are not. Backoff is
`min(1 hour, 30 seconds × 2^(cycleAttempt−1))` with jitter in `[0.5, 1)`.
`Retry-After` seconds/dates are respected as a minimum; if the resulting retry
would fall outside the cycle window, the delivery fails instead. Expired worker
attempts count against the same budget. Callback failures never rerun an LLM.

Use the user-authenticated delivery endpoints to list events, inspect paginated
attempt history, or redeliver a delivered/failed event. Redelivery keeps the
event ID, payload, captured URL, and lifetime history, while starting a fresh
eight-attempt/24-hour cycle. It does not change an active cycle. A previously
successful `deliveredAt` is kept until another successful acknowledgement.

Callback URL changes affect future events only, including for manual redelivery.
Signing-secret rotation affects new claims; already claimed calls may use the
previous secret. Receivers should briefly accept both secrets during rotation.
There is no server-side old-secret key ring. Disabled users receive no new
claims; re-enabling resumes eligible work, but does not reset the retry clock.
Already claimed calls may finish. Shutdown aborts I/O and leaves ambiguous work
to lease recovery.

### Verifying a callback

The signature format is gateway-specific. Each request includes:

- `X-LLM-Gateway-Event-Id`: stable delivery/event UUID.
- `X-LLM-Gateway-Timestamp`: signing time in Unix seconds, regenerated per attempt.
- `X-LLM-Gateway-Signature`: `v1=` followed by a hex HMAC-SHA256 digest.

The signed bytes are `timestamp + "." + eventId + "." + rawBody`. The HMAC key
is the **literal UTF-8 webhook secret**, including its `whsec_` prefix; do not
base64-decode it. Verify the raw body before JSON parsing or reserializing it.
For a receiver using Node's `Headers` and a raw `Buffer`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(rawBody: Buffer, headers: Headers, secret: string) {
  const id = headers.get("x-llm-gateway-event-id");
  const timestamp = headers.get("x-llm-gateway-timestamp");
  const signature = headers.get("x-llm-gateway-signature");
  if (!id || !timestamp || !/^\d+$/.test(timestamp)
    || !signature || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${id}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}
```

After verification, parse the event, check its `eventId` matches the header, and
durably deduplicate it before processing. Return a 2xx promptly once accepted;
run lengthy application work asynchronously. Keep receiver clocks synchronized.
The five-minute timestamp tolerance limits old replays, but does not replace
event deduplication. Neither HTTP responses nor logs should echo signing secrets.

`webhooks/routes.ts` and `service.ts` own HTTP and scoped queries; `worker.ts`
owns claims/attempts/recovery; `sender.ts` owns signing and transport; `policy.ts`
contains retry limits and delay parsing. Job execution stays in `jobs/`.

## Usage

Use a user bearer key with `GET /v1/usage`. It accepts `from`, `to`, `accountId`,
`provider`, and `modelId`; optionally group by `account`, `provider`, `model`,
or `day`. For example:

```text
GET /v1/usage?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&groupBy=day
```

The response contains `period`, `groupBy`, `summary`, `data`, and `nextCursor`.
The summary covers the full filter range; `data` contains grouped metrics only
when grouping is requested. Groups support `limit` (1–100, default 50) and an
opaque cursor. Model groups include the provider, so equal model IDs don't merge.

Usage belongs to the **attempt's start time**; submitted-job counts belong to
the **job's creation time**. UTC day groups and `[from, to)` bounds use those
respective timestamps. A day may have retry usage without another submitted
job. Counts by status are current states, not a historical status snapshot.
No date bounds means all retained history; no synthetic empty-day rows are added.

Each token/cost bucket includes `knownTotal`, `knownAttempts`, and
`missingAttempts`. All numeric values are decimal strings. A null total means
no recorded values, while `"0"` means a known token sum of zero. Missing values
are not zero: a total with missing attempts is partial, and failed/ambiguous
calls may still have incurred unobserved charges. Even an empty report keeps
totals null, with both coverage counts zero. Costs sum the stored estimates,
not current catalog prices or inferred values from response payloads.

Retries contribute their own recorded usage but never multiply job counts.
Soft-deleted accounts and purged request inputs do not erase usage. Reporting
uses one SQL statement/snapshot and never loads prompts, credentials, or native
response bodies. Results are live; pagination does not freeze subsequent changes.
See [API details](./api-endpoints.md#7-usage-and-costs) for the complete shape.

`usage/routes.ts` handles HTTP, `usage/validation.ts` handles query/cursor shapes,
and `usage/service.ts` aggregates job and attempt facts separately before
combining them. There is no separate usage table, repository layer, or worker.
Apply `0004_usage_attempt_index.sql` before deploying; it adds an index on
attempt start time and job ID for time-window queries.

## Database

Uses Drizzle with the `pg` driver. `src/db/schema.ts` is the schema source;
`migrations/` contains generated SQL and Drizzle's migration metadata. Use a
dedicated gateway database with the default `public` schema. No database is
created or migrated automatically when the HTTP server starts.

Set `DATABASE_URL` in the shell/deployment environment to the intended database,
then apply migrations explicitly:

```sh
pnpm --filter @llm-providers/llm-gateway db:migrate
```

The command fails if `DATABASE_URL` is missing and closes its connection pool
when finished. Applied migrations are tracked in `drizzle.__drizzle_migrations`;
rerunning the command leaves applied migrations alone. Run one migration process
at a time during deployment, before starting API/worker processes. Review SQL
before applying it to a non-test database; do not edit already-applied migrations.

After changing the TypeScript schema, generate and review the next migration:

```sh
pnpm --filter @llm-providers/llm-gateway db:generate --name describe_change
```

Generation does not require a database connection. A compiled deployment can run
`node dist/db/migrate.js` from the app directory; include `migrations/` alongside
`dist/`. Environment files are not loaded automatically.

### Connections and transactions

`createDatabase(connectionString)` in `src/db/client.ts` returns `{ db, pool }`.
Create one instance per API/worker process. The caller owns pool error handling
and shutdown (`pool.end()`); `src/index.ts` wires both for the API process.
Pool connection/acquisition waits are capped at five seconds. Runtime connections
have a three-second lock timeout, five-second server statement timeout, ten-second
client query timeout, and thirty-second idle-transaction timeout. The migration
command allows five-minute statements (310-second client timeout), retaining the
same lock timeout. Provider calls also have local lease-expiry and job-deadline
abort timers, independent of database heartbeats.
Connection creation is lazy; it does not validate
server reachability until the first query. TLS/connection options can be supplied
through the PostgreSQL connection string; certificate verification is not
disabled by this factory.

Use `db.transaction(async (tx) => { ... })` for multi-table operations and pass
the transaction explicitly to helpers. `Database` and `Transaction` types are
exported from the client module. There is no repository layer or global pool
created on import.

Apply `0005_lossless_payloads.sql` before deploying this version. Requests,
responses, and webhook payloads use PostgreSQL `json`, preserving escaped NULs
and lone UTF-16 surrogates in opaque content. Configuration and sanitized errors
remain `jsonb`. A small `jobs.usage` projection is written with each terminal
result so listings never need SQL extraction from opaque response JSON. The
migration backfills this projection from existing responses. Message-array
validation remains at submission, not in a JSON-inspecting database constraint.
This migration converts existing payloads without dropping rows;
large tables may require a maintenance window for the column rewrite.

Drizzle returns timestamps as `Date`, encrypted bytes as `Buffer`, `bigint`
columns as JavaScript `bigint`, and `numeric(30, 12)` costs as decimal strings.
Attempt endpoints serialize bigint counts/durations and numeric costs as decimal
strings. `AssistantResponse` JSON keeps its existing numeric contracts shape.
JSON column typings do not validate native provider output at runtime.

User settings, webhook-secret rotation, and account updates maintain timestamps
explicitly. Account services enforce provider immutability, owner scoping, and
configuration version increments. Job services enforce parent immutability,
retention deadlines, continuation eligibility, and atomic terminal-job/outbox
writes. These are service responsibilities, not automatic database triggers.

### Database tests

Set `TEST_DATABASE_URL` to a **disposable PostgreSQL database**, then run:

```sh
pnpm --filter @llm-providers/llm-gateway test:db
```

Tests apply migrations and exercise real PostgreSQL constraints, types, indexes,
transactions, user/account/catalog/job/webhook/usage HTTP routes, and worker recovery. Provider
and callback transport are stubbed; no live credentials or external calls are used. Database fixtures are rolled back;
API fixtures are removed after each test. Migrated tables remain.
Never point this command at a production/shared database. This explicit suite is
separate from `pnpm test`, so ordinary provider tests do not need PostgreSQL.

`pnpm --filter @llm-providers/llm-gateway test` runs database-free crypto and
configuration, catalog lookups, job/usage validation, fingerprints, retries, signing, timeouts, and destination-policy tests
and health tests and is included in the root `pnpm test` command.

### End-to-end tests

With `TEST_DATABASE_URL` pointing at a disposable PostgreSQL server and a role
allowed to create databases, plus `openssl` available on PATH:

```sh
pnpm build
pnpm --filter @llm-providers/llm-gateway test:e2e
```

This starts the compiled API and worker as separate Node processes, runs the
compiled migrations twice, and uses real HTTPS provider fixtures and callbacks.
It covers all three provider protocols (including ChatGPT SSE), authentication,
account ownership, idempotency, continuations/native replay, provider retries,
failure callbacks, cancellation, signature verification, webhook retries and
redelivery, usage, worker restart, input cleanup, and graceful process shutdown.
Only fixture retry/retention timestamps are advanced directly in SQL.

The test creates and drops its own randomly named database; it does not migrate
or clear the database named in `TEST_DATABASE_URL`. Temporary certificates are
trusted only by test child processes via `NODE_EXTRA_CA_CERTS`; TLS verification
is never disabled. Generated databases, certificates, and processes are cleaned
up on completion. Do not run against production infrastructure.

For opt-in **billable** live OpenAI and Fireworks smoke tests, supply
`LIVE_OPENAI_API_KEY` and `LIVE_FIREWORKS_API_KEY` through the test runner's
environment, then run:

```sh
pnpm --filter @llm-providers/llm-gateway test:live
```

Each provider gets one tiny initial job and one continuation, capped at 128 output
tokens per call, with the normal gateway retry policy. Defaults are catalog models
`gpt-5.6-luna` and `accounts/fireworks/models/glm-5p3-flash`; optional
`LIVE_OPENAI_MODEL` / `LIVE_FIREWORKS_MODEL` must also be in the provider catalog.
The tests verify stored results, usage, idempotency, and real signed HTTPS callbacks.
Keys are not written to files or passed as command-line arguments. Credentials
are stored encrypted only in the disposable test database and removed with it.
Missing credentials, inaccessible models, and unsuccessful provider responses
fail the live suite rather than being reported as successful checks. No live
ChatGPT check is included: it requires an access token and account ID.

Reference: [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs).
Database reference: [Drizzle with PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql).
