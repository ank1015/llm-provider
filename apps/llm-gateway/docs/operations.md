# Operations

## Runtime requirements

- Node.js 20 or newer
- PostgreSQL with the default `public` schema available to the application role
- the monorepo built so all workspace provider packages are present
- separate supervision for the API and worker processes
- HTTPS termination in front of the API

Use a dedicated gateway database. The application does not create a database or
apply migrations automatically at API/worker startup.

## Configuration

| Variable | Required | Validation and behavior |
| --- | --- | --- |
| `DATABASE_URL` | Yes | `postgres://` or `postgresql://` URL. TLS options may be supplied in the URL. |
| `ADMIN_API_KEY` | Yes | 32–512 non-whitespace characters. Generate randomly. |
| `ENCRYPTION_KEY` | Yes | Exactly 64 hexadecimal characters representing 32 bytes. Keep stable. |
| `PORT` | No | `0–65535`; default `3000`. |
| `REQUEST_RETENTION_DAYS` | No | `1–365`; default `7`. Applies when future jobs become terminal. |
| `WORKER_CONCURRENCY` | No | `1–128`; default `1`. Simultaneous LLM jobs per worker process. |
| `PROVIDER_ALLOWED_ORIGINS` | No | Comma-separated canonical origins in addition to official provider origins. |
| `WEBHOOK_ALLOWED_ORIGINS` | No | Comma-separated canonical HTTPS origins or `https://*.example.com` subdomain wildcards; empty denies callback sending. |

Canonical origins have no path, trailing slash, credentials, query, or fragment.
Provider origins require HTTPS except exact loopback HTTP for local development.
Webhook origins always require HTTPS. A wildcard matches subdomains at any depth,
but not the apex domain or nonstandard ports.

The process exits on invalid configuration and reports field names without
printing secret values. Environment files are not loaded automatically.

## Deployment

From the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @llm-providers/llm-gateway db:migrate
```

Review generated SQL and run one migration process before rolling out API or
worker binaries. Include `apps/llm-gateway/migrations/` beside the compiled app.
Applied migrations are tracked in `drizzle.__drizzle_migrations`; rerunning the
migrator is safe.

Start and supervise the processes separately:

```sh
pnpm --filter @llm-providers/llm-gateway start
pnpm --filter @llm-providers/llm-gateway worker
```

Both processes need the same database, encryption key, retention, and destination
policy. The API can accept jobs without a worker, but they remain queued.

### Automated production deployment

Every push to `main` runs `.github/workflows/deploy-gateway.yml`. The workflow:

1. installs dependencies and runs the build and non-live test suite;
2. exchanges GitHub's short-lived OIDC token for the narrowly scoped Google
   Cloud deployer identity, with no stored service-account key;
3. builds an image in Cloud Build and tags it with the immutable Git commit SHA;
4. uploads the deployment manifests to the VM through IAP-only SSH;
5. pulls the image, applies pending migrations, replaces the API, verifies
   readiness, and then replaces the worker; and
6. verifies public liveness and database readiness over HTTPS.

Deployments are serialized and are never cancelled by a newer push. The old API
continues serving while migrations run. Replacing the single API container causes
a brief connection window, normally a few seconds; clients should retry job
submission with the same idempotency key. Queued jobs remain durable in Postgres.

Replacing the worker aborts active provider calls. Their leases expire and the
jobs become eligible for another attempt. Because provider execution is at least
once, an interrupted call can rarely be repeated upstream and charged twice.
Migrations must therefore remain backward-compatible with the currently running
image. Use expand-and-contract migrations for destructive schema changes.

## Health checks

- `GET /healthz` is a public liveness check. It does not access PostgreSQL.
- `GET /readyz` verifies PostgreSQL connectivity and access to the core `jobs`
  table. It returns `503` before migrations or during database failure.

Both responses disable caching and reveal no connection details. Readiness is not
a schema-version check and does not prove worker availability, provider access,
account balance, or webhook reachability.

Monitor process health separately and alert on at least:

- oldest `queued`/`retry_wait` job age;
- count and age of expired `running` leases;
- job success/failure/retry rates and provider latency;
- oldest pending/retrying webhook and terminal delivery failures;
- PostgreSQL connections, lock/statement timeouts, storage, and transaction age;
- process RSS, event-loop delay, and restarts.

The application currently emits deliberately terse error logs. Production
observability should add structured request/job IDs and metrics without logging
credentials, prompts, native responses, or raw provider errors.

## Scaling workers

Set concurrency in the worker environment:

```sh
WORKER_CONCURRENCY=16 pnpm --filter @llm-providers/llm-gateway worker
```

Start low and measure representative context and response sizes. Raising the
setting increases concurrent network calls, in-memory request/response payloads,
heartbeat writes, and database completion transactions. It does not change
provider limits, webhook concurrency, or user fairness.

Multiple worker processes coordinate through PostgreSQL. Total potential LLM
concurrency is approximately:

```text
worker process count × WORKER_CONCURRENCY
```

The pool limit is ten connections per process. Provider calls release database
connections while awaiting upstream I/O, so concurrency can exceed pool size;
claim and completion queries queue at the pool. Scale PostgreSQL connection
budgets with process count, not only execution-slot count.

Before raising concurrency substantially, load-test:

- normal and high-percentile context sizes;
- continuation-heavy traffic;
- provider latency and large responses;
- database and callback traffic at the same time;
- graceful shutdown with all slots active.

Add queue admission, per-user fairness, and memory-aware limits before exposing
high concurrency to untrusted or highly variable workloads.

## Database behavior

Runtime database limits are:

- five-second connection/acquisition timeout;
- three-second PostgreSQL lock timeout;
- five-second PostgreSQL statement timeout;
- ten-second client query timeout;
- thirty-second idle-in-transaction timeout.

Migrations allow five-minute statements and a 310-second client query timeout,
while retaining the three-second lock timeout. A large rewriting migration may
therefore require an explicit maintenance window rather than competing with live
traffic.

Request input expires only after a job reaches a terminal state. Cleanup removes
expired inputs in batches of 100. Responses, attempts, webhook payloads, job
metadata, and idempotency records currently have no automatic retention policy.
Capacity planning must include them.

Continuation children store complete reconstructed snapshots, so storage grows
with context size and turn count. Shorten input retention when continuation needs
allow, and monitor the database's actual compressed size and write-ahead-log
volume.

## Graceful shutdown and recovery

SIGINT/SIGTERM:

- stops API admission and closes its pool;
- aborts active provider and webhook HTTP calls;
- stops all execution, cleanup, and delivery loops;
- leaves ambiguous in-flight claims to expire and recover;
- forces process exit after ten seconds if shutdown cannot complete.

Recovery can repeat an external request. A lease proves which worker may commit
state, not whether an unreachable provider processed a request. Treat duplicate
provider charges and duplicate webhook attempts as possible operational events.

If workers are unavailable, accepted jobs remain durable. Restore workers and
watch queue age. Do not manually change job state unless the lease/retry invariants
in [Database design](./database.md) are understood.

## Secret and destination operations

- Back up `ENCRYPTION_KEY` in a secret manager. Do not rotate it by replacement;
  no multi-key decryption or bulk re-encryption procedure is implemented.
- Rotate user webhook secrets through the API. Receivers should briefly accept
  both old and new secrets because an already claimed delivery may use the old one.
- Provider credential updates affect subsequent attempts; an already dispatched
  call uses the credential snapshot held by that worker.
- Allowlist only destinations controlled or explicitly trusted by the operator.
  Apply egress firewall policy as a second boundary.
- Put authentication rate limits, body limits, and abuse controls at the ingress.

## Webhook receivers

Verify `X-LLM-Gateway-Signature` against the exact raw body before JSON parsing.
The signed input is:

```text
timestamp + "." + eventId + "." + rawBody
```

The signature is `v1=` plus a hexadecimal HMAC-SHA256 digest using the literal
UTF-8 `whsec_...` secret. Validate timestamp freshness, ensure the body event ID
matches the header, durably deduplicate by event ID, and return 2xx promptly.

Delivery retries network errors, timeouts, and HTTP 408/429/500/502/503/504. Each
cycle permits eight attempts within 24 hours. Manual redelivery retains event ID,
payload, destination, and prior history while starting a new retry cycle.

## Release checklist

1. Build and run all non-live tests.
2. Review and apply unapplied migrations.
3. Verify the encryption key and destination allowlists.
4. Deploy API and worker processes with explicit concurrency.
5. Check `/healthz` and `/readyz`.
6. Submit a non-billable fixture or approved smoke job.
7. Confirm queue processing, result persistence, callback delivery, and metrics.
8. Watch latency, errors, memory, and database growth during rollout.
