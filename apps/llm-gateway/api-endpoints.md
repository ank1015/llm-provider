# LLM Gateway API Endpoints

All endpoints in this document are implemented, alongside `GET /` for the
application name. Run both the API and worker processes for job execution and
callback delivery.

## Conventions

- API base path: `/v1`.
- Admin endpoints require a separate admin credential.
- Other API endpoints require a user API key and are scoped to that user.
- Health endpoints do not require a user API key.
- Account and job IDs never grant access by themselves.
- List endpoints use cursor pagination where applicable.
- Account reads never return secrets. Newly minted gateway keys are returned
  only at creation; key listings return metadata only.
- Implemented API endpoints use `Authorization: Bearer <key>` and return
  `Cache-Control: no-store`. Admin and user credentials are not interchangeable.
- Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid or
  inactive credentials return `401`; valid requests for absent resources return
  `404`. Internal database errors are not exposed.

## 1. Admin: user management

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/v1/admin/users` | Create a user with name and callback URL; mint the initial user key. |
| GET | `/v1/admin/users` | List users. |
| GET | `/v1/admin/users/:userId` | Get user details. |
| PATCH | `/v1/admin/users/:userId` | Update user details or enable/disable access. |
| POST | `/v1/admin/users/:userId/keys` | Mint an additional or replacement user key. |
| GET | `/v1/admin/users/:userId/keys` | List key metadata, without secret values. |
| DELETE | `/v1/admin/users/:userId/keys/:keyId` | Revoke a key. |

### Implemented request and response shapes

- `POST /v1/admin/users` accepts `{ name, callbackUrl }`, creates the user and
  initial API key atomically, and returns `201` with
  `{ user, key, webhookSecret }`. New users are enabled by default.
- `user` contains `id`, `name`, `enabled`, `callbackUrl`, `createdAt`, and
  `updatedAt`. Timestamps are ISO strings. It never contains encrypted secrets.
- Issued `key` contains `id`, `userId`, `name`, `keyPrefix`, `createdAt`,
  `revokedAt`, and the one-time `secret`. Read/list responses omit `secret`,
  and no endpoint exposes `keyHash`.
- `PATCH /v1/admin/users/:userId` accepts one or more of `name`, `callbackUrl`,
  and `enabled`; it returns the updated user. Disabling a user invalidates all
  their keys for subsequent user-authenticated requests, without revoking the
  keys. Re-enabling restores access through unrevoked keys.
- `POST /v1/admin/users/:userId/keys` accepts `{ name? }` (send `{}` for an
  unnamed key) and returns `201` with the issued key. Existing keys remain valid
  until separately revoked; issuance is not automatic replacement.
- Revocation returns `204`. Repeating revocation for the same owned key also
  returns `204`, preserving its original revocation timestamp. A key under the
  wrong user path returns `404`.
- Both list endpoints accept `limit` (1–100, default 50) and an opaque `cursor`,
  returning `{ data, nextCursor }`. Order is newest first with ID as tie-breaker.
  Revoked keys remain in key listings. A null `nextCursor` marks the last page.
- User/key path identifiers must be UUIDs. Names are trimmed and must contain
  1–200 characters. JSON body endpoints require `application/json`, reject
  unknown fields, and require a nonempty patch. User-management bodies are
  limited to 16 KiB (`413`); invalid fields/JSON return `400`, and missing or
  unsupported content types return `415`.
- Callback URLs must be HTTPS, at most 2048 characters, and have no embedded
  credentials or fragment. Registration/update only stores the URL; it does
  not contact it. Delivery separately requires an operator-trusted HTTPS origin
  in `WEBHOOK_ALLOWED_ORIGINS`, with no redirects. Operator DNS and deployment
  egress policy are part of that trust boundary.

## 2. User settings

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/me` | Get current user details and callback settings. |
| PATCH | `/v1/me` | Update the name or callback URL. |
| POST | `/v1/me/webhook-secret/rotate` | Rotate the secret used to sign callbacks. |

`GET /v1/me` returns the authenticated user's safe `user` fields. `PATCH /v1/me`
accepts only `name` and/or `callbackUrl` and returns the updated user. It cannot
change user identity, enabled status, keys, or another user's settings.

Rotation takes no body and returns `{ webhookSecret }` once. It replaces the
stored encrypted secret immediately, without changing API keys or other users.
Secrets cannot be retrieved later through GET endpoints. New delivery claims
use the current secret, including retries/redeliveries. An already claimed call
may still use the previous secret; receivers should briefly accept both during
rotation. The gateway does not retain old signing secrets.

## 3. Provider accounts

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/v1/accounts` | Add a named provider account with configuration and secrets. |
| GET | `/v1/accounts` | List accounts, optionally filtered by provider. |
| GET | `/v1/accounts/:accountId` | Get account details without secrets. |
| PATCH | `/v1/accounts/:accountId` | Update name, configuration, secrets, or enabled status. |
| DELETE | `/v1/accounts/:accountId` | Remove the account from future use while preserving job history. |

The provider (`openai`, `chatgpt`, or `fireworks`) is fixed at account creation.
A user may have multiple accounts for each provider. Secret updates replace
supplied values; omitted fields remain unchanged.

The gateway account ID is distinct from ChatGPT's provider-specific account ID,
which belongs inside its provider configuration. Store only serializable client
options; `fetch` is not an API configuration field. Arbitrary custom headers are
not currently supported by the provider clients.

### Implemented account behavior

`POST /v1/accounts` accepts a user-authenticated request such as:

```json
{
  "name": "My OpenAI account",
  "provider": "openai",
  "config": { "project": "project-id", "timeoutMs": 120000 },
  "secrets": { "apiKey": "provider-api-key" }
}
```

`enabled` is optional and defaults to true. `config` defaults to `{}` when
omitted, although ChatGPT requires `config.accountId`. `secrets` is required.

| Provider | Accepted config fields | Required secrets |
| --- | --- | --- |
| `openai` | `baseUrl`, `timeoutMs`, `organization`, `project` | `apiKey` |
| `chatgpt` | `baseUrl`, `timeoutMs`, `accountId` (required) | `accessToken` |
| `fireworks` | `baseUrl`, `timeoutMs` | `apiKey` |

- Creation returns `201` with the safe account record: `id`, `userId`, `name`,
  `provider`, `config`, `configVersion`, `enabled`, `createdAt`, and `updatedAt`.
  GET and PATCH return the same shape. Neither plaintext credentials nor their
  encrypted representation are ever returned, including on creation.
- GET list accepts `provider`, `limit` (1–100, default 50), and `cursor`. It
  returns `{ data, nextCursor }`, newest first, with full-precision timestamp/ID
  pagination. Disabled accounts remain visible; deleted accounts are excluded.
- PATCH accepts `name`, `enabled`, `config`, and/or `secrets`. Config/secrets
  objects are shallow-merged by field; omitted values remain unchanged. Null
  is not a reset operation and is rejected. An empty patch or explicitly empty
  config/secrets patch is rejected. Optional client fields can be set to an
  explicit desired value; field-removal semantics are not implemented.
- The merged provider-specific settings are validated before saving. Unknown
  fields, provider changes, owner/ID changes, caller-supplied versions, and
  secrets placed in `config` are rejected.
- `configVersion` starts at 1 and increments once when effective config or
  secrets change. Name/enabled-only updates and identical setting values do not
  increment it. Updates lock the account row in a transaction to avoid losing
  concurrent edits. Successful patches maintain `updatedAt`.
- DELETE returns `204`, sets `enabled = false`, and soft-deletes the account.
  Repeating DELETE as the owner returns `204` without changing its deletion
  timestamp. GET/PATCH on deleted accounts return `404`; PATCH cannot restore
  them. Their database record and existing job relationships are preserved.
- All operations derive ownership from the user bearer key. Unknown or
  foreign-owned account IDs return `404`; an admin key alone cannot access
  these user endpoints. Invalid/revoked keys and disabled users return `401`.
- UUID, JSON content-type, strict fields, name-length, and 16 KiB management-body
  limits match the user endpoints. Invalid client settings return `400` without
  exposing credentials or raw provider errors.

Validation uses the existing provider client constructors and does not call
provider APIs, check credential validity remotely, or refresh access tokens.
Client URL rules permit HTTPS and loopback HTTP for development, without embedded
credentials, query strings, or fragments. Job submission/execution additionally
requires the provider's default origin or an exact operator-configured
`PROVIDER_ALLOWED_ORIGINS` entry. Redirects are not followed.

Soft deletion currently retains encrypted credentials in the historical row.
Credential purge remains a future decision. Disabling/deleting an account blocks
new worker attempts; an already claimed call may finish. Each attempt uses current
settings and records `configVersion`. Account routes themselves do not execute,
cancel, retry, or change job status.

## 4. Provider and model catalogs

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/providers` | List supported providers. |
| GET | `/v1/models` | List catalog models, optionally filtered by provider. |
| GET | `/v1/accounts/:accountId/models` | Get catalog models for the account's provider. |

Account model listings reflect the gateway catalog, not a live check of the
credentials' model access.

### Implemented catalog behavior

- All three endpoints require an active user bearer key, including the general
  provider/model lists. Admin credentials alone cannot access them. A user
  does not need any accounts to read `/v1/providers` or `/v1/models`.
- GET providers returns `{ data: [{ id, name }, ...] }`: `openai` / `OpenAI`,
  `chatgpt` / `ChatGPT`, and `fireworks` / `Fireworks`, in that order.
- GET models returns `{ data: Model[] }`. Optional `provider` selects one of
  those three providers; without it, all models are returned in provider order,
  preserving each package's catalog order. Model IDs are provider-qualified by
  their `provider` field; equal IDs across providers remain separate entries.
- Models are returned unchanged from the provider packages: `provider`, `id`,
  `name`, `pricing`, `contextWindow`, and `maxTokens`. Pricing is the contracts
  shape: numeric USD per million tokens, with `base` rates and an optional
  long-context `above` tier (or null). These are packaged catalog estimates,
  not a live pricing or account-entitlement lookup.
- GET account models first resolves the owned, nondeleted account, then returns
  `{ data: Model[] }` for its provider. Disabled accounts remain readable;
  missing, foreign, or deleted accounts return `404`. This endpoint takes no
  provider override or other query fields. A catalog entry does not imply the
  disabled account can submit a job.
- Invalid provider filters, malformed UUIDs, and unsupported query fields return
  `400`. These finite static lists are unpaginated: no `limit`, `cursor`, or
  `nextCursor`. Provider listings also take no query fields.
- Responses use `Cache-Control: no-store`. No credentials are decrypted or
  exposed, and no provider API calls are made. Catalog reads do not refresh
  account tokens or validate remote model access. Job model validation uses
  the same gateway catalog lookup, backed by the existing package exports.

No new tables, migrations, configuration, or worker tasks are needed.

## 5. Jobs: LLM requests

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/v1/jobs` | Submit a fresh request or continue a previous job; return `202 Accepted` with a job ID. |
| GET | `/v1/jobs` | List recent jobs and metadata. |
| GET | `/v1/jobs/:jobId` | Get job status and the stored result or final error. |
| GET | `/v1/jobs/:jobId/attempts` | Inspect provider attempts, timings, and errors. |
| POST | `/v1/jobs/:jobId/cancel` | Request cancellation of queued, running, or retry-waiting work. |

### Submission forms

For a fresh request, `previousJobId` is absent or null. Supply `accountId`,
`idempotencyKey`, and the existing provider request inputs: `modelId`,
`instructions`, `messages`, `tools`, and `providerOptions`, with their existing
required/optional rules. The selected account determines the provider;
credentials are not supplied with each job.

For a continuation, supply a non-null `previousJobId`, a new `idempotencyKey`,
and a required, non-null `messages` array containing the additional messages:

```json
{
  "idempotencyKey": "turn-2",
  "previousJobId": "previous-job-id",
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "Explain the second option." }]
    }
  ]
}
```

Continuation inherits the parent's account, model, instructions, tools, and
provider options. Those fields must not be supplied as overrides. The gateway
assembles messages in this order:

1. The previous job's stored input messages.
2. The previous job's `response.message` (the assistant message, not the full
   `AssistantResponse` envelope).
3. The newly supplied messages, such as user messages or tool results.

Omitted or null `messages` is invalid for continuation; it is not normalized to
an empty array. Continuation always includes the previous assistant message and
is not a way to rerun exactly the previous input.

The parent must belong to the authenticated user, have succeeded, and retain
both its unexpired request payload and its response. Its account must remain
usable. Unknown/inaccessible parents return `404`; parents that have not
succeeded return `409`; expired or removed request input returns `410` with
`previous_request_expired`. Missing retained response data also prevents
continuation. Invalid submission shapes return `400`.

The parent is immutable and may have multiple children, allowing independent
branches. Each child stores a complete reconstructed request, with its own
retention window. Later cleanup of the parent's input does not break an
already accepted child's execution or retries. Inheriting the account does not
freeze credentials; normal account-update rules still apply.

This reduces caller-to-gateway payload size, not the full context sent to the
provider, token usage, or storage of reconstructed requests. It requires no
provider-specific continuation feature and no additional endpoint.

### Acceptance, idempotency, and retrieval

Acceptance means the job has been durably recorded. The eventual
`AssistantResponse` is available through job lookup and the callback, not in the
initial submission response.

Idempotency is scoped to `userId + idempotencyKey`. Fingerprint the normalized
submission: fresh input/account for fresh requests, or `previousJobId` plus
additional messages for continuations. The same key and fingerprint return the
existing job; a different submission with that key returns a conflict.

Check for an existing idempotent job before reconstructing a continuation or
requiring the parent's payload to remain available. Repeating an accepted
submission must still return its child job after the parent's payload expires.
This deduplicates submissions, not necessarily provider execution after an
ambiguous network failure.

Job-list filters: `accountId`, `provider`, `modelId`, `status`, `from`, `to`, and
exact `idempotencyKey` lookup, with cursor pagination. Lists return metadata
rather than full prompts and responses. Job details and list entries expose
`previousJobId`, which is null for fresh requests.

Cancellation is best-effort and does not undo provider charges. Jobs represent
requests; a separate requests resource is unnecessary.

### Implemented job behavior

- POST returns `202` with `{ id, status }`, including idempotent replays of
  terminal jobs. `idempotencyKey` is a non-whitespace string of 1–200 characters.
  Fresh requests normalize absent/null `previousJobId` to null, absent tools to
  `[]`, and absent provider options to `{}`. Fingerprints ignore object-key
  ordering but preserve message/array order. These defaults do not apply as
  overrides on a continuation.
- The HTTP JSON body and the assembled stored input each have a 16 MiB limit
  (`413`), including reconstructed continuations. Message/tool envelopes match
  contracts; native assistant items and custom `data` remain opaque JSON.
  Model/catalog, ownership, account availability, and destination checks happen
  before acceptance. Provider-specific request semantics are checked by the
  existing adapter during execution; invalid requests fail the job without
  retries. Credentials belong only to accounts, not job inputs.
- GET list returns `{ data, nextCursor }`, newest first; `limit` is 1–100,
  default 50. Time filters use UTC ISO timestamps and `[from, to)`. Each entry
  includes ID/account/provider/model, parent/idempotency key, status, scheduling
  and lifecycle timestamps, plus the successful response's `usage` (or null).
  It never includes prompts, full responses, leases, or credentials.
- GET detail returns that metadata plus `response`, `error`, `request`,
  `requestExpiresAt`, and `requestStatus: "retained" | "expired"`. Unavailable
  response/error/request fields are null. Expired input is hidden even before
  cleanup runs; after deletion its expiry timestamp is also unavailable.
- GET attempts returns `{ data }`, in attempt-number order. There are at most
  three attempts. Fields include config version, status, timestamps, provider
  response ID/resolved model, error, duration, token counts, and cost breakdown.
  Database bigint counts/durations and numeric USD costs are **decimal strings**;
  unknown values are null. The `AssistantResponse` itself retains its contracts
  shape and numeric usage fields. Attempt costs include observed calls even if
  the job was subsequently cancelled; a successful response's usage is not an
  aggregate of earlier attempts.
- POST cancel returns `200` with `{ id, status, cancelRequestedAt }`. Queued or
  retry-waiting work becomes cancelled immediately. Running work records the
  request, then the worker aborts on its next heartbeat (normally within ten
  seconds) or honors it when the call completes. Repeated cancellation preserves
  timestamps. Already terminal outcomes do not change. A provider response
  arriving after cancellation can still contribute observed attempt usage,
  without turning the job into a success.
- All reads/cancellation are user-scoped, including after account soft deletion.
  Foreign/missing jobs return `404`. Internal lease tokens and request hashes
  are never API fields.

The API process only persists jobs. Run the separate worker described in
[README.md](./README.md#jobs-and-worker) to execute them. Retries allow up to three
attempts within 30 minutes from acceptance. Transport errors, timeouts, and
selected transient HTTP errors use exponential jitter with applicable
`Retry-After` hints. See the exact policy in [db_schema.md](./db_schema.md#implemented-job-policy).

Errors expose a safe gateway code, message, retry eligibility, and, for provider
errors, provider/HTTP status when available. Raw provider errors and free-form
provider error strings are not stored or returned because they can echo prompts
or secrets. `retryable` describes eligibility, not a promise of another attempt:
attempt/deadline limits still apply.

Completion atomically saves the result, sets the input retention deadline, and
creates one pending terminal callback event. Request retention defaults to seven
days and can be set with `REQUEST_RETENTION_DAYS`. Responses, attempts, events,
and idempotency records are not purged. Webhook sending is an independent worker
consumer; a pending callback does not delay result retrieval.

## 6. Webhook deliveries

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/webhook-deliveries` | List deliveries, optionally filtered by job or delivery status. |
| GET | `/v1/webhook-deliveries/:deliveryId` | Get delivery status and attempt history. |
| POST | `/v1/webhook-deliveries/:deliveryId/redeliver` | Schedule another delivery of the same event. |

The gateway sends signed terminal events to the user's registered callback URL.
Events include a stable event ID, job ID, event type, completion timestamp, and
the `AssistantResponse` or serialized final error. The callback endpoint belongs
to the user's application, not this gateway.

Delivery retries are independent of provider retries. Redelivery preserves the
event ID and never reruns the LLM request. Consumers must handle duplicate
deliveries. A callback failure does not change a successful job's outcome or
prevent result retrieval.

### Implemented delivery behavior

- GET list accepts `jobId`, `status`, `limit` (1–100, default 50), and an opaque
  `cursor`; it returns `{ data, nextCursor }`, newest event first. List records
  include `id`, `jobId`, `eventType`, `callbackUrl`, `status`, `createdAt`,
  `deliveredAt`, `nextAttemptAt`, `retryFromAttempt`, and `retryStartedAt`.
  Lists omit payloads and attempt history.
- GET detail returns those fields plus immutable `payload` and
  `attempts: { data, nextCursor }`. Attempts are newest-number first. Pass
  `attemptLimit` (1–100, default 50) and the returned numeric `attemptCursor`
  for earlier attempts. Each attempt has `id`, `deliveryId`, `attemptNumber`,
  `startedAt`, `finishedAt`, `httpStatus`, and a safe `error` or null.
- POST redeliver takes no body. Delivered/failed events return `202` with the
  metadata record in `pending` status; their eight-attempt/24-hour retry budget
  restarts without deleting history. Concurrent requeues serialize. Pending,
  retry-waiting, or delivering events return `409 delivery_already_scheduled`;
  this endpoint does not reset or hurry an active cycle.
- Redelivery preserves event ID, payload, captured destination, and any earlier
  `deliveredAt`. A later successful acknowledgement updates `deliveredAt`.
  `retryFromAttempt` is the first lifetime attempt number in the current cycle;
  `retryStartedAt` is that cycle's start, not original event creation time.
- All operations require the owning user's active key. Missing/foreign IDs
  return `404`; malformed IDs/filters/cursors return `400`. Responses have
  `Cache-Control: no-store` and never expose lease tokens, signing secrets, or
  ciphertext. Callback response bodies and raw transport errors are not stored.
- Any 2xx acknowledges delivery; redirects are not followed. HTTP calls time out
  after ten seconds. Transient failures use bounded backoff and `Retry-After`;
  see [README.md](./README.md#webhooks) for exact policy and signature verification.
- The callback destination is frozen on event creation. Updating the user's URL
  affects future events only. Each claim uses the current signing secret.
  Disabled users receive no new claims, but disabling does not reset the retry
  window; already claimed calls may finish. Expired lease attempts are recorded
  with `lease_expired`, indicating an unknown acknowledgement rather than a
  confirmed callback failure.
- `WEBHOOK_ALLOWED_ORIGINS` must explicitly permit the captured HTTPS origin.
  An empty allowlist sends nothing and fails attempted deliveries with
  `destination_not_allowed`; after correcting config, redeliver explicitly.

Signing headers are `X-LLM-Gateway-Event-Id`, `X-LLM-Gateway-Timestamp`, and
`X-LLM-Gateway-Signature`. The signature is `v1=<hex HMAC-SHA256>` over
`timestamp.eventId.rawBody`, keyed by the literal webhook secret. Receivers must
verify the raw bytes and a recent timestamp, then deduplicate the signed event
ID. No exactly-once delivery guarantee is implied by the queue lease.

## 7. Usage and costs

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/usage` | Get token usage, estimated costs, and job counts. |

Filters: `from`, `to`, `accountId`, `provider`, and `modelId`.
Grouping: `groupBy=account|provider|model|day`.

This supports user-wide and per-account reporting. Per-request costs are also
available through the jobs endpoints. Costs are catalog-based estimates, not
provider billing reconciliation; missing usage is unknown rather than zero.

### Implemented usage behavior

GET returns `{ period, groupBy, summary, data, nextCursor }`:

- `period` echoes `{ from, to, timeZone: "UTC" }`; omitted bounds are null and
  mean unbounded history. Bounds are inclusive `from`, exclusive `to`. Use UTC
  ISO timestamps with seconds and at most six fractional digits. Reversed
  ranges return `400`; equal bounds return an empty report.
- Token/cost and attempt counts use **attempt start time**. Job counts use
  **job creation time**, independently. A retry on another day contributes
  usage on that day, not another submitted job. Therefore a range can have
  attempts but zero submitted jobs. Status counts reflect current stored status,
  not the status as it was at the end of the requested period.
- `summary` covers every matching job/attempt regardless of group pagination.
  `summary.jobs` has `total`, `queued`, `running`, `retry_wait`, `succeeded`,
  `failed`, and `cancelled`; `summary.attempts` has `total`, `running`,
  `succeeded`, `failed`, `cancelled`, and `unknown`. Each count is a decimal string.
- `summary.tokens` has `input`, `output`, `cacheRead`, and `cacheWrite`.
  `summary.costUsd` has those four buckets plus `total`. Each bucket returns
  `{ knownTotal, knownAttempts, missingAttempts }`. For example:

  ```json
  { "knownTotal": "123.450000000000", "knownAttempts": "4", "missingAttempts": "2" }
  ```

  Here only four attempts have a recorded value; two lack it. `knownTotal` sums
  recorded values only and is null if none are known. A recorded zero is a
  known value, not missing. For an empty report, counts are `"0"` and bucket
  totals are null, with both coverage counts `"0"`. Coverage is per bucket,
  including running and ambiguous attempts. Missing values are never estimated
  from other buckets or replaced with zero.
- All counts/token totals and USD totals are **decimal strings**, preserving
  PostgreSQL bigint/numeric precision. Costs sum recorded estimates across all
  attempts, including retries and observed usage on failed/cancelled jobs.
  They are not recalculated from today's catalog prices, and `costUsd.total`
  sums the recorded total column rather than adding potentially different
  partial component samples. Input excludes cache reads/writes as in contracts.
- Without `groupBy`, `data` is empty and `nextCursor` is null. With grouping,
  every entry has `group` plus the same metrics as `summary`. Group shapes:

  | `groupBy` | `group` |
  | --- | --- |
  | `account` | `{ accountId, provider }` |
  | `provider` | `{ provider }` |
  | `model` | `{ provider, modelId }` |
  | `day` | `{ day: "YYYY-MM-DD" }` in UTC |

  Identical model IDs from different providers remain separate. Only groups
  with a matching job or attempt appear; missing days are not filled in.
- Groups sort ascending by account UUID, provider, provider/model, or UTC day,
  respectively. `limit` is 1–100 (default 50); `cursor` is opaque and requires
  the same `groupBy`. Keep all filters unchanged while paging. Summary and
  groups come from one database snapshot per request; reports are live, so
  values can change between page requests as work finishes. `limit` has no
  effect on an ungrouped summary.
- Account/provider/model filters apply to both job and attempt metrics. Model
  filters accept historical IDs without requiring membership in today's
  catalog. Disabled/deleted accounts and expired request inputs remain in
  historical usage. Missing/foreign account IDs produce an empty report, never
  another user's data.
- The owning user's active bearer key is required; admin credentials do not
  grant access. Invalid filters/cursors or unknown query fields return `400`.
  Responses have `Cache-Control: no-store`; no prompts, native responses,
  credentials, raw errors, or internal lease data are loaded or returned.

No reporting table or background aggregation task is used. Apply migration
`0004_usage_attempt_index.sql` for the attempt-time lookup index.

## 8. Operational health

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Process liveness. |
| GET | `/readyz` | Readiness to accept work. |

Both endpoints are unauthenticated and return `Cache-Control: no-store`.
Liveness returns `200 { "status": "ok" }` without querying PostgreSQL.
Readiness checks database connectivity and a zero-row query of the core `jobs`
table: `200 { "status": "ready" }` on success, otherwise
`503 { "status": "not_ready" }`, without exposing errors or connection details.
The query has a two-second timeout; pool connection/acquisition waits have a
separate five-second timeout. This does not verify every migration, worker
availability, provider credentials, quota, or webhook reachability. Migrations
and supervision of both API/worker processes remain deployment responsibilities.
