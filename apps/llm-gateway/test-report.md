# Gateway completion verification

Verified locally on September 12, 2026, using Node.js, PostgreSQL 14, compiled
API/worker processes, and a trusted local HTTPS receiver. No deployment was made.

## Results

| Check | Result |
| --- | --- |
| Monorepo type checks and builds | Passed |
| Provider package tests | 334 passed |
| Gateway database-free tests | 26 passed |
| Gateway PostgreSQL integration tests | 95 passed |
| Full-process local end-to-end scenario | Passed |
| Live OpenAI end-to-end scenario | Passed |
| Live Fireworks end-to-end scenario | Passed |

458 tests passed across these suites. Live tests are deliberately separate from
the default test command because they require credentials and can incur charges.

The local end-to-end scenario covers registration/authentication, account CRUD
and ownership, catalogs, durable submission, idempotency/conflicts, all three
provider wire protocols, native assistant replay in continuations, transient
provider retries, permanent failure, queued cancellation, signed HTTPS callbacks,
callback retry/redelivery, usage, worker restart, expired input cleanup, key
revocation, and graceful shutdown. Compiled migrations run twice against an empty
database; readiness changes from 503 before migration to 200 afterward.

## Live calls

| Provider | Catalog model | Jobs | Recorded output tokens | Recorded estimated cost (USD) |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-5.6-luna` | Initial + continuation | 10 | 0.000020000000 |
| Fireworks | `accounts/fireworks/models/glm-5p3-flash` | Initial + continuation | 95 | 0.000064900000 |

Both providers returned successful stored `AssistantResponse` results and signed
callbacks. Continuations replayed the prior native assistant message; duplicate
submissions returned the same job. The aggregate catalog-based estimate is
USD 0.0000849, not a provider billing reconciliation.

No live ChatGPT call was made because no access token/account ID was supplied.
Its complete SSE-to-result path passed against the local protocol fixture,
including output-item fallback when the terminal event omits the output array.

Keys were supplied through hidden terminal input, never saved in source/env
files, printed in logs, or used as command-line arguments. Account credentials
were encrypted in disposable databases. Generated test databases, TLS files, and
processes were cleaned up. Revoke the temporary provider keys after testing.

## Running the application

All documented endpoints are implemented, including `/healthz` and `/readyz`.
Follow [README.md](./README.md) for environment settings, migrations, separate
API/worker startup, and repeatable test commands. No new migration was needed for
the completion wiring. Production HTTPS termination, access/rate controls,
process supervision, and trusted callback origins remain operator configuration.
Readiness probes the API/database, not worker health or provider availability.
