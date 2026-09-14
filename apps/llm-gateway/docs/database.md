# Database design

## Status and scope

This document records the discussed PostgreSQL schema and its reasoning for the
[API reference](./api-reference.md). The eight-table schema is implemented in
`src/db/schema.ts`, with generated SQL and metadata in `migrations/` and a
connection factory/migration entry point in `src/db`. User management,
key issuance/revocation, authentication, webhook-secret rotation, and provider
account CRUD are implemented in `src/users`, `src/accounts`, and the shared
auth/crypto modules. `src/jobs` implements submission/continuation, queries,
cancellation, provider attempts with leased recovery/retries, atomic terminal
callbacks, and input cleanup. `src/worker.ts` runs job execution separately from
HTTP. `src/webhooks` implements signed callback delivery, scoped APIs, retry cycles,
and recovery; the worker process runs job slots, delivery, and cleanup independently. `src/usage`
implements scoped aggregate reporting. `src/catalogs` exposes the existing
provider/model catalogs and owned-account model lists without new tables.
`src/health.ts` exposes liveness and database/core-table readiness without new
tables or migrations. Migration
`0003_webhook_retry_cycles.sql` adds two cycle fields without adding tables.
`0004_usage_attempt_index.sql` adds an attempt-time reporting index.
`0005_lossless_payloads.sql` preserves provider-native JSON and separates usage.
`0006_lightweight_webhook_events.sql` reduces stored terminal events to canonical
completion metadata and enforces that shape.

The schema has **eight tables**. `job_requests` keeps large request payloads
separate so they can expire independently
of job metadata, idempotency records, results, and usage history.

Use one shared database schema with user ownership expressed through `user_id`,
not a separate PostgreSQL schema per user. PostgreSQL can also hold the durable
job and callback queues; a separate queue service is not required initially.

## Conventions

- IDs use `uuid`; timestamps use `timestamptz`.
- Columns are non-null unless marked nullable below.
- Native requests, responses, and webhook payloads use `json` to preserve escaped
  NULs and lone UTF-16 surrogates without altering opaque content. Configuration
  and sanitized errors use `jsonb`; filtering, scheduling, and reporting use columns.
- Provider and status fields use `text` with allowed-value constraints.
- Token counts and durations use nonnegative `bigint` values when known.
- USD estimates use nonnegative `numeric(30, 12)`, not floating-point storage.
  NaN is rejected. The driver returns decimal strings to preserve precision;
  attempt endpoints use decimal strings for bigint counts/durations and USD
  costs. `AssistantResponse` JSON retains its numeric contracts shape.
- Missing usage and costs remain null; null does not mean zero.
- Account secrets and webhook signing secrets are encrypted, not hashed,
  because the gateway must recover them for outbound requests. Ciphertext must
  carry or reference encryption/key-version information. Encryption keys live
  outside the database.
- User API keys are randomly generated and stored only as hashes. Account
  reads, API responses, logs, and stored errors must not expose credentials.
- User-owned queries are scoped to the authenticated user. Foreign keys enforce
  relationships but do not replace API authorization.

### Database implementation boundary

The migration enforces required fields, allowed provider/status values, positive
attempt/version numbers, per-user idempotency, composite ownership references,
outcome/finished-time consistency, paired lease fields, and nonnegative known
counts/costs. The submission API validates the required messages array. The
database stores valid JSON but does not inspect native payload contents, since
JSON field extraction can reject otherwise storable Unicode escapes.

Foreign keys use non-cascading behavior. Request payload rows can be deleted
independently; referenced historical jobs/accounts cannot be silently deleted.
No database triggers implement business workflows. Services must maintain
`updated_at`, immutable provider/parent identity, configuration versions,
continuation eligibility, retention expiry, and terminal-job/outbox transactions.
They must also filter every operation by the authenticated user.

UUIDs and initial timestamps have database defaults. Retention expiry has no
creation-time default: the completion workflow sets it only after the
job becomes terminal. Cost/count nulls stay null rather than defaulting to zero.
See [Development and testing](./development.md#schema-changes) for migration and
test commands.

## 1. `users`

Represents a customer of the gateway, not an individual agent or a provider
account. One user can own many API keys, provider accounts, and jobs.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `name` | `text` | Display name. |
| `enabled` | `boolean` | Whether the user can access the API. |
| `callback_url` | `text` | Registered callback destination. |
| `webhook_secret_encrypted` | `bytea` | Secret used to sign callbacks. |
| `created_at` | `timestamptz` | Creation time. |
| `updated_at` | `timestamptz` | Last settings change. |

No admin table is needed initially if the separate admin credential is supplied
through deployment configuration. The webhook secret is distinct from the user
API key.

The implementation creates a user and initial API key in one transaction and
returns the API key and webhook secret only once. Webhook ciphertext uses an
AES-256-GCM envelope (version byte, nonce, tag, ciphertext), authenticated against
`user:<id>:webhook`. The current deployment uses one persistent encryption key;
re-encryption/key-ring support is not implemented. Secret rotation replaces the
user's encrypted secret and updates `updated_at`.

`users_created_idx` supports admin cursor pagination by descending creation time
and ID. Cursors preserve PostgreSQL microseconds even though ordinary API
timestamps are serialized through JavaScript `Date`.

## 2. `user_api_keys`

A separate table supports multiple keys and independent revocation without
recreating or deleting the user.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key; key-management identifier. |
| `user_id` | `uuid` | Foreign key to `users.id`. |
| `name` | `text`, nullable | Optional label. |
| `key_hash` | `text` | Hash of the randomly generated API key. |
| `key_prefix` | `text` | Safe display prefix, not an authentication credential. |
| `created_at` | `timestamptz` | Issued time. |
| `revoked_at` | `timestamptz`, nullable | Revocation time; null means not revoked. |

Constraints and behavior:

- Unique `key_hash`.
- Return the plaintext key only when minted; never persist it.
- Revocation sets `revoked_at` rather than deleting the record.
- Authentication must also check that the owning user is enabled.

Generated user keys use 32 random bytes and an `lgw_` prefix. The stored hash is
SHA-256; only a short prefix is exposed for display. Repeated revocation preserves
the first `revoked_at`. `user_api_keys_user_created_idx` supports per-user key
pagination and replaces the original user-only index in
`migrations/0001_user_listing_indexes.sql`.

## 3. `provider_accounts`

One table covers all three providers. Separate provider-specific tables would
add structure without helping the current account-management workflow.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key; gateway account ID. |
| `user_id` | `uuid` | Foreign key to `users.id`. |
| `name` | `text` | Account name. |
| `provider` | `text` | `openai`, `chatgpt`, or `fireworks`; immutable after creation. |
| `config` | `jsonb` | Non-secret, serializable client configuration. |
| `secrets_encrypted` | `bytea` | Encrypted provider credentials. |
| `config_version` | `integer` | Positive version incremented when configuration or secrets change. |
| `enabled` | `boolean` | Whether the account can be used for new work. |
| `deleted_at` | `timestamptz`, nullable | Soft deletion time. |
| `created_at` | `timestamptz` | Creation time. |
| `updated_at` | `timestamptz` | Last update. |

Provider-specific values:

| Provider | Configuration | Secrets |
| --- | --- | --- |
| OpenAI | `baseUrl`, `timeoutMs`, `organization`, `project` | `apiKey` |
| ChatGPT | `baseUrl`, `timeoutMs`, `accountId` | `accessToken` |
| Fireworks | `baseUrl`, `timeoutMs` | `apiKey` |

ChatGPT's `config.accountId` is a provider identifier, not this table's gateway
`id`. Application-owned functions such as `fetch` are not stored. Arbitrary
custom headers are not currently supported by the provider clients.

Add a unique constraint on `(user_id, id)` to support ownership-enforcing
composite foreign keys. Users may have multiple accounts for each provider.

### Implemented account lifecycle

- Routes derive `user_id` from authentication and reject attempts to supply or
  change ownership, provider, identifiers, or version numbers.
- Config/secrets are checked against strict provider-specific fields, then the
  existing client constructors validate their semantics without network calls.
  Native client validation does not replace the separate job origin allowlist.
- Store the complete secret object as encrypted JSON with authenticated context
  `user:<userId>:account:<accountId>:<provider>:secrets`. Safe response projections
  omit ciphertext and plaintext credentials on every operation.
- PATCH reads the owned live account with `FOR UPDATE`, merges supplied config
  and secret fields, validates the result, and saves within the same transaction.
  Omitted fields remain unchanged; null and explicitly empty config/secrets
  patches are rejected. There is no field-removal/reset operation yet.
- Increment `config_version` once per effective config/secret change. Metadata
  changes or identical settings do not increment it. Existing ciphertext is
  preserved when credentials do not change. A version number identifies the
  configuration used; it does not retain old configurations or secrets.
- Deletion is soft and idempotent: set `enabled = false` and the first
  `deleted_at`/`updated_at`, preserving historical account/job relationships.
  Live reads/lists/updates exclude deleted rows. Repeated owner deletion does
  not change the original timestamp; restoring through PATCH is disallowed.
- Disabled but nondeleted accounts remain visible and can be re-enabled.

`migrations/0002_account_listing_indexes.sql` adds partial live-account indexes
for `(user_id, created_at, id)` and `(user_id, provider, created_at, id)`, replacing
the original user/provider-only index. Cursor queries preserve microseconds.

Encrypted credentials are currently retained on soft-deleted accounts.
Credential purge remains future work. Workers block new attempts for disabled
users or disabled/deleted accounts, while already claimed calls may finish.
Each new attempt reads current settings/secrets and records its config version.
Account operations themselves do not change job status or make provider requests.

## 4. `jobs`

One row represents one logical LLM request, regardless of how many provider
attempts it takes. Large request input lives in `job_requests`, not in this table.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key; externally visible job ID. |
| `user_id` | `uuid` | Foreign key to `users.id`; owner. |
| `account_id` | `uuid` | Selected gateway provider account. |
| `previous_job_id` | `uuid`, nullable | Parent job being continued; null for a fresh request. |
| `model_id` | `text` | Requested catalog model. |
| `idempotency_key` | `text` | Caller-supplied submission identity. |
| `request_hash` | `text` | Fingerprint of the normalized submission; see continuation/idempotency rules below. |
| `status` | `text` | Current job state. |
| `response` | `json`, nullable | Complete `AssistantResponse`. |
| `usage` | `jsonb`, nullable | Final response usage summary for lightweight job listings; written atomically with the response. |
| `error` | `jsonb`, nullable | Serialized final error. |
| `next_attempt_at` | `timestamptz` | When queued or retrying work becomes eligible; ignored for terminal jobs. |
| `lease_token` | `uuid`, nullable | Identifies the current worker claim. |
| `lease_expires_at` | `timestamptz`, nullable | Allows recovery after worker failure. |
| `cancel_requested_at` | `timestamptz`, nullable | Cancellation request time. |
| `created_at` | `timestamptz` | Durable acceptance time. |
| `started_at` | `timestamptz`, nullable | First attempt start. |
| `finished_at` | `timestamptz`, nullable | Terminal outcome time. |

Allowed states: `queued`, `running`, `retry_wait`, `succeeded`, `failed`,
`cancelled`.

Constraints and behavior:

- Unique `(user_id, idempotency_key)` with both columns non-null.
- Composite foreign key `(user_id, account_id)` references
  `provider_accounts(user_id, id)`, preventing cross-user account references.
- Add unique `(user_id, id)` for ownership-enforcing references from deliveries
  and child jobs.
- Composite foreign key `(user_id, previous_job_id)` references
  `jobs(user_id, id)`, preventing cross-user continuation links. A null parent
  is allowed for fresh requests. Parent linkage is immutable and not unique:
  multiple children may branch from one parent. Do not cascade parent deletion
  into child jobs; request cleanup deletes payloads, not job records.
- Successful jobs have a response; failed jobs have a final error. Terminal
  jobs have `finished_at` set. Final responses and errors are not both populated.
- The account determines the provider; its immutable provider field can be
  joined for filtering without another independent provider value on the job.
- Same user/key and same normalized submission return the existing job. A
  different submission with the same key produces a conflict, including
  concurrent calls.
- Define a deterministic, submission-mode-aware fingerprint: fresh requests
  include normalized input, model, and account ID; continuations include
  `previousJobId` and additional messages, not the reconstructed parent input.
  Normalize absent/null `previousJobId` to fresh mode. Do not hash credentials
  or depend on incidental JSON object-key order.
- Check an existing idempotency record before parent reconstruction/retention
  checks. Repeating an accepted continuation must return its existing child
  even after the parent's payload expires. The fingerprint is retained on
  `jobs` for this purpose; it is not a hash of the expanded child payload.
- No separate requests API resource, conversation table, or normalized native
  output-item tables are needed. Native assistant output remains in JSON.

## 5. `job_requests`

Holds the large, immutable request payload while it is needed for execution and
for a limited debugging period afterward.

| Column | Type | Purpose |
| --- | --- | --- |
| `job_id` | `uuid` | Primary key and foreign key to `jobs.id`; one payload per job. |
| `request` | `json` | Complete execution input: instructions, assembled messages, tools, and provider options. |
| `expires_at` | `timestamptz`, nullable | Scheduled cleanup time; null during nonterminal execution. |

The model and account are stored on `jobs`; together with this payload they
provide the complete execution input. Insert the job and its payload in the
same transaction before returning `202 Accepted`.

### Continuation through `previousJobId`

`POST /v1/jobs` accepts either a fresh request or a continuation, as described in
[API reference](./api-reference.md). No additional table or endpoint is needed.

For continuation, `messages` is a required, non-null array. Omitted/null values
are invalid rather than being converted to an empty array. Account, model,
instructions, tools, and provider options are inherited; overrides are rejected.

Build the child's complete messages array in this order:

1. Parent's stored input messages.
2. Parent's stored `response.message`, preserving native assistant content.
3. Caller-supplied additional messages.

Use the assistant message, not the entire `AssistantResponse` envelope. The
feature always includes that assistant message; it is continuation, not an
identical rerun of the previous request.

The parent must belong to the authenticated user, have `status = succeeded`,
retain its response, and have an unexpired request payload. Its account must
still be usable. Enforce the retention deadline even if the cleanup worker has
not physically deleted an expired row yet. Missing/expired input prevents new
continuations, but does not invalidate existing child jobs.

Persist the child's resolved account/model on `jobs` and its fully reconstructed
input in `job_requests`. Do not store only a message delta or require workers to
walk parent chains. Read/copy the parent data and insert the child within a
transaction coordinated with payload cleanup so acceptance cannot leave a
partially reconstructed child. Do not mutate or extend the parent's retention.

Each child has its own seven-day-after-completion retention window (or the
configured period). Parent payload deletion cannot break an accepted child's
execution/retries because the child has an independent input snapshot. A child
that later succeeds can itself be continued while its input/result are retained.

This saves caller-to-gateway bandwidth but still stores a full input for every
child and sends the full assembled context through the provider adapter. It
does not inherently reduce provider token usage or database duplication. Delta
storage would introduce chain-reconstruction and retention dependencies and is
not part of the initial design.

Inherited account identity does not freeze secrets/configuration. New attempts
follow the account-update policy and record the configuration version used.
If response-retention cleanup is added later, it must also coordinate with
continuation creation, since reconstruction needs the parent's assistant output.

### Request retention

Agentic callers can submit multiple requests per minute, repeatedly including
growing context. Storing every full input indefinitely would accumulate large
amounts of duplicated data. For roughly linear context growth, cumulative
storage over a conversation can grow roughly quadratically; it is not
necessarily exponential.

The agreed starting policy is:

- Global, configurable retention, initially **7 days after job completion**.
  Deployments can choose a shorter or longer period, such as 1 or 30 days.
- Keep the payload while the job is queued, running, or waiting to retry.
  `expires_at` stays null during these states.
- When the job reaches a terminal state, set
  `expires_at = finished_at + retention period` in the completion transaction.
- A cleanup worker deletes expired payload rows in bounded batches, confirming
  the associated jobs are terminal. A cancellation request alone is not a
  terminal outcome and must not trigger expiry.
- Deleting a payload does not delete the job, response, attempts, usage,
  idempotency key, or request hash.
- Job detail should explicitly indicate when request input has expired, rather
  than presenting missing input as an empty original request.
- Idempotent resubmission still returns the existing job after request cleanup;
  the stored submission fingerprint allows comparison without retaining the
  original payload or reconstructing a continuation from its parent.

Separating this table gives input its own lifecycle and keeps frequently read
job metadata separate from large, short-lived request data. Job-list queries
should not load payloads or full responses.

Full responses and lightweight webhook events also need retention policies, but
their periods are not yet decided. Request expiry must not implicitly remove them
or break pending callback delivery/result retrieval.

## 6. `job_attempts`

One row per attempt to call the provider. Attempt history is independent of the
logical job's final outcome and survives request-payload cleanup.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `job_id` | `uuid` | Foreign key to `jobs.id`. |
| `attempt_number` | `integer` | Positive attempt sequence within the job. |
| `account_config_version` | `integer` | Account configuration version used. |
| `status` | `text` | `running`, `succeeded`, `failed`, `cancelled`, or `unknown`. |
| `provider_response_id` | `text`, nullable | Provider response ID, if received. |
| `resolved_model_id` | `text`, nullable | Provider-reported model, when available. |
| `error` | `jsonb`, nullable | Serialized attempt error, excluding credentials. |
| `started_at` | `timestamptz` | Attempt start. |
| `finished_at` | `timestamptz`, nullable | Attempt end. |
| `duration_ms` | `bigint`, nullable | Provider-call duration. |
| `input_tokens` | `bigint`, nullable | Input tokens excluding cache reads/writes. |
| `output_tokens` | `bigint`, nullable | Output tokens, including reasoning where counted by the provider. |
| `cache_read_tokens` | `bigint`, nullable | Cache-read tokens. |
| `cache_write_tokens` | `bigint`, nullable | Cache-write tokens. |
| `input_cost_usd` | `numeric`, nullable | Estimated uncached input cost. |
| `output_cost_usd` | `numeric`, nullable | Estimated output cost. |
| `cache_read_cost_usd` | `numeric`, nullable | Estimated cache-read cost. |
| `cache_write_cost_usd` | `numeric`, nullable | Estimated cache-write cost. |
| `total_cost_usd` | `numeric`, nullable | Estimated total cost. |

Unique constraint: `(job_id, attempt_number)`.

`unknown` represents an ambiguous outcome, such as a worker disappearing after
dispatch without learning whether the provider completed the request. It must
not be reported as a confirmed provider failure or known zero-cost attempt.

The usage columns are a reporting projection of the adapter result, not a
second calculation. Populate the final response and corresponding attempt
usage consistently from that result. Do not duplicate the full request in each
attempt, since that would undermine request retention.

## 7. `webhook_deliveries`

One row per terminal job event. This table is also the durable callback outbox;
there is no separate events/outbox table initially.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key; delivery ID and stable event ID. |
| `job_id` | `uuid` | Job whose terminal outcome is being reported. |
| `user_id` | `uuid` | Owning user. |
| `event_type` | `text` | `job.succeeded`, `job.failed`, or `job.cancelled`. |
| `callback_url` | `text` | Destination captured for this event. |
| `payload` | `json` | Stable lightweight event body containing job identity and completion metadata. |
| `status` | `text` | `pending`, `delivering`, `retry_wait`, `delivered`, or `failed`. |
| `retry_from_attempt` | `integer` | First lifetime attempt number in the current retry cycle; positive, default 1. |
| `retry_started_at` | `timestamptz` | Start of the current 24-hour retry window; defaults to event creation time. |
| `next_attempt_at` | `timestamptz` | Next delivery eligibility. |
| `lease_token` | `uuid`, nullable | Current worker claim. |
| `lease_expires_at` | `timestamptz`, nullable | Claim expiry. |
| `created_at` | `timestamptz` | Event creation time. |
| `delivered_at` | `timestamptz`, nullable | Successful delivery time. |

Constraints and behavior:

- Unique `job_id`: one terminal event per logical job in the current design.
- Composite foreign key `(user_id, job_id)` references `jobs(user_id, id)`.
- Save the terminal result, finalize request expiry, and insert the pending
  delivery in the same transaction. A crash must not leave a completed job
  without its recoverable notification.
- Event payload is `{ eventId, type, jobId, completedAt }`. Responses, errors,
  request input, credentials, and account data are retrieved from their owning
  resources rather than copied into delivery records.
- Deliveries are signed using the current user webhook secret at claim time.
  Rotation affects future claims; already claimed calls may use the previous
  secret. Receivers handle that brief overlap; old secrets are not retained.
- Manual redelivery requeues this row, retains its event ID/payload, and adds to
  attempt history. It never reruns the provider request.
- Delivery can happen more than once; consumers deduplicate by event ID.
- Callback failure does not change the job's outcome or block result retrieval.
- Manual redelivery is allowed only after `delivered`/`failed`. Under a row lock,
  set the cycle's first attempt to `last lifetime attempt + 1`, set its start to
  now, and queue it. Keep the payload, destination, original creation timestamp,
  history, and previous successful `delivered_at`. The latter updates on another
  success. Active cycles return an API conflict instead of resetting retries.

Migration `0003` initializes existing rows to `retry_from_attempt = 1` and the
migration time for `retry_started_at`, then enforces a positive first attempt.
Apply migrations before starting the API or worker.

## 8. `webhook_delivery_attempts`

Preserves delivery history without overwriting earlier failures.

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `delivery_id` | `uuid` | Foreign key to `webhook_deliveries.id`. |
| `attempt_number` | `integer` | Positive sequence within the delivery. |
| `started_at` | `timestamptz` | Attempt start. |
| `finished_at` | `timestamptz`, nullable | Attempt end. |
| `http_status` | `integer`, nullable | Callback HTTP response status, if received. |
| `error` | `jsonb`, nullable | Network, timeout, or delivery error. |

Unique constraint: `(delivery_id, attempt_number)`.

There is no need to store arbitrary callback response bodies by default. A
successful HTTP acknowledgement means delivery, not that the receiving
application has finished processing the event.

An unfinished attempt has null `finished_at`; recovered lost-worker attempts
finish with a safe `lease_expired` error and null HTTP status. Their acknowledgement
is unknown. The queue consumer has a ten-second HTTP timeout and 60-second lease;
no lease-renewal loop is needed for this bounded call. Completion locks the row
and checks its current token and expiry before changing either delivery or
attempt history. No callback transaction stays open during network I/O.

## Usage reporting and intentionally omitted tables

`GET /v1/usage` aggregates `job_attempts` and joins jobs/accounts for ownership,
account, provider, and model filters. No separate usage table is needed initially.

- Sum known usage across attempts, not just the final successful response.
- Count logical jobs separately so retries do not inflate job counts.
- Report missing-usage coverage alongside known totals; partial sums must not
  appear to be a complete bill.
- Store costs when received/calculated; do not recalculate historical estimates
  using later catalog prices.
- Costs are catalog estimates, not provider billing reconciliation. Failed or
  interrupted attempts may incur charges the gateway cannot observe.
- Add daily aggregate tables only if measured query volume requires them.

### Implemented reporting semantics

- Filter usage/attempt counts by `job_attempts.started_at` and submitted-job
  counts by `jobs.created_at`, independently, with `[from, to)` UTC bounds.
  Day groups use explicit UTC conversion, independent of PostgreSQL's session
  timezone. Accept up to PostgreSQL's six fractional-second digits without
  truncating bounds through JavaScript `Date`. Status breakdowns use current
  row state, not a historical reconstruction at the range end.
- A filtered, lean jobs selection supplies ownership/account/provider/model
  metadata. Separate job facts and attempt facts are combined with `UNION ALL`;
  aggregating those facts prevents retry joins from multiplying logical jobs.
  SQL grouping sets calculate summary and groups in one statement/snapshot.
  Neither request nor response JSON is selected for reporting.
- Every usage/cost bucket exposes a sum of recorded values and separate counts
  of known/missing attempts. A recorded zero counts as known; no observations
  yields a null sum. Running and unknown attempts also contribute to missing
  coverage. Missing data is not estimated from catalog prices or other buckets.
  The total-cost sum uses `total_cost_usd` directly.
- PostgreSQL performs sums and counts, casting results to text before JSON
  serialization. Token sums can exceed an individual bigint column's range;
  the API preserves them, as well as exact numeric USD sums, as decimal strings.
- Account/provider/model filters apply to both fact streams, including historical
  data for disabled/deleted accounts. Model groups are provider-qualified. Job
  creation on one day and a retry on another appear in their respective day
  groups; there need not be a submitted job for every day with attempt usage.
- Group pagination uses ascending, deterministic keys with `C` collation. It
  limits grouped rows only; the summary always covers all matching facts.
  Each page is a new live snapshot, not a multi-request snapshot guarantee.
- `job_attempts_started_job_idx(started_at, job_id)` supports attempt-time filters.
  Existing job user/creation indexes and the unique attempt `(job_id, attempt_number)`
  index support ownership/creation and job-linked lookup. The shared jobs CTE is
  not materialized so filters can be planned independently for each fact stream.

Providers and models stay in the existing package catalogs, not database
tables. The implemented account-model endpoint reuses the owned, nondeleted
account lookup and reads its provider's package catalog; it does not decrypt
credentials or contact upstream APIs. Disabled accounts remain readable. Job
model validation shares the same catalog lookup. No catalog migration or
background synchronization is needed. Health endpoints need no tables of their own.

## Initial indexes

In addition to primary keys and indexes backing unique constraints, start with
indexes supporting:

- API keys by user.
- Accounts by user and provider, including an appropriate live-account filter.
- Jobs by `(user_id, created_at, id)` for cursor pagination.
- Jobs by `(user_id, account_id, created_at, id)` for account history.
- Child jobs by `(user_id, previous_job_id)` where the parent is not null, for
  parent references and lineage lookups.
- Runnable jobs by `(next_attempt_at, id)`, limited to eligible queue states.
- Expired running-job leases for worker recovery.
- Request cleanup by `(expires_at, job_id)` where `expires_at` is not null.
- Deliveries by `(user_id, created_at, id)` for delivery listings.
- Runnable deliveries by `(next_attempt_at, id)` and expired delivery leases.

Attempt parent lookups are already covered by the unique parent/attempt-number
indexes. Avoid adding every possible filter combination or JSON index before
query plans demonstrate a need.

## Transactions, leases, retries, and recovery

1. Submission authenticates the caller, normalizes/fingerprints the submission,
   and resolves any existing idempotency record before reconstructing input.
   For a new job, verify account ownership/usability. For a continuation, also
   verify parent ownership/success/retention and assemble the complete input.
   Atomically create the job and request payload under the idempotency
   constraint, coordinating parent reads with cleanup. Concurrent submissions
   must still resolve to one job or a fingerprint conflict. Return acceptance
   only after commit.
2. A worker claims eligible work in a short transaction, records the attempt and
   lease, then commits before making the provider call.
3. Renew leases during long calls. Completion updates must verify the current
   lease token so a stale worker cannot overwrite newer authoritative state.
4. A retryable failure records its attempt outcome and the next eligible time.
   The job remains nonterminal, so request input must remain available.
5. A terminal transition saves the outcome, finalizes payload expiry, and
   creates the pending callback together.
6. Delivery workers claim and send callbacks independently, preserving delivery
   history and retrying without executing the LLM again.
7. Cleanup removes only expired request payload rows, not their parent jobs.

Workers can use `FOR UPDATE SKIP LOCKED` for queue-like claims. Do not hold a
database transaction or row lock throughout a long provider/callback request.
Runtime connections bound pool acquisition to five seconds, lock waits to three
seconds, statements to five seconds, and client query waits to ten seconds.
Idle transactions are closed after thirty seconds. Local lease/deadline timers
abort provider I/O independently of a stalled heartbeat query. Migrations use
longer statement/query limits; see [Operations](./operations.md#database-behavior).

Provider retries and webhook retries have independent schedules. Both policies
below are implemented.

Gateway idempotency deduplicates submissions, not external provider execution.
Leases protect database state, but cannot undo an already dispatched request.
Recovery or retries after an ambiguous failure may execute again and incur
additional charges. Cancellation is also best-effort, not a billing rollback.

### Implemented job policy

- Each worker process runs `WORKER_CONCURRENCY` execution slots (1–128, default 1),
  sharing one database pool. Cleanup and webhook delivery each have one independent
  loop per process. Slots have independent job leases and all observe shutdown.
- Three attempts maximum; 30-minute deadline measured from job creation,
  including queue/backoff time. Account per-call timeouts still apply and are
  capped by the remaining deadline. Deadlines are derived from `created_at`,
  and attempt numbers from the attempt history; no redundant counters needed.
- Retry `network_error`, `timeout`, and `provider_error` HTTP 408, 429, 500, 502,
  503, 504. Known quota/billing/usage-limit codes are excluded. Other HTTP
  statuses, invalid config/request/response, cancellation, unknown exceptions,
  and response-level failures without a matching HTTP status are non-retryable.
  A successful adapter result with stop reason `length`, `refusal`, or
  `tool_use` is still a successful job, not a retry signal.
- Delay is `min(30s, 1s × 2^(attempt−1))` multiplied by jitter in `[0.5, 1)`.
  A valid provider `Retry-After` hint is a minimum, not capped to 30 seconds.
  If another attempt would exceed the budget/deadline, finalize the failure.
  Error `retryable` denotes eligibility independently of remaining budget.
- Worker claims use `FOR UPDATE SKIP LOCKED`, renewable 60-second leases, and
  ten-second heartbeats. Finalization requires the current token and unexpired
  lease. Recovered running attempts become `unknown`; another attempt uses a
  new number/token if budget permits. Unknown usage is not fabricated as zero.
- SIGINT/SIGTERM abort provider I/O and leave the claim to lease recovery.
  Lease loss or renewal failure also aborts the call. These are not user
  cancellation events. Explicit cancellation is checked on heartbeat and
  finalization; terminal results remain immutable.
- Completion, input expiry, one pending callback event, and a transactional
  PostgreSQL terminal-job notification are one transaction.
  Callback URL is captured at completion, event ID equals delivery ID, and
  payload is `{ eventId, type, jobId, completedAt }` for every terminal status.
  An independent webhook consumer claims pending events; job completion does not
  wait for delivery. The notification wakes bounded API waiters, which re-read
  the authoritative job and do not hold a transaction or pool connection while idle.
- HTTP submission checks its normalized fingerprint under a per-user/key
  transaction advisory lock, backed by the existing unique constraint.
  Continuation locks the parent row while copying input. Cleanup locks the
  same parent rows with `SKIP LOCKED`, deleting at most 100 payloads per batch.
- Input retention defaults to seven days, configurable through
  `REQUEST_RETENTION_DAYS` (1–365). Changes affect future terminal transitions,
  not previously recorded expiry timestamps. Cleanup also checks terminal
  status, so active input cannot be deleted merely because of an expiry value.
- Responses remain native through the contracts adapters. Attempt usage is
  copied into typed columns; USD estimates are rounded to the database's
  12 decimal places. Missing buckets stay null. Raw provider error messages,
  codes/types, and payloads are not persisted because they may contain prompts
  or credentials; safe errors retain classification/provider/HTTP status and
  retry eligibility. Worker/HTTP logs likewise omit these values.
- Provider origins must be the account provider's default or explicitly
  operator-allowlisted; redirects are rejected. Arbitrary account URL storage
  alone does not grant outbound access. No live calls occur at submission.

### Implemented webhook policy

- Eight attempts per cycle and a 24-hour window measured from `retry_started_at`.
  Attempt numbers always increase across manual redelivery cycles; the two new
  fields record cycle boundaries without deleting or renumbering history.
- Retry network/timeouts and HTTP 408, 429, 500, 502, 503, 504. Other non-2xx
  statuses, destination restrictions, and preparation errors are terminal.
  Backoff is `min(1 hour, 30s × 2^(cycleAttempt−1))` with `[0.5, 1)` jitter;
  valid `Retry-After` seconds/dates are a minimum. Do not schedule beyond the
  cycle deadline. Crashed attempts also consume budget; a late/recovered claim
  finalizes as failed once the deadline/budget is exhausted.
- Each process has an independent job and webhook consumer. Queue claims use
  `SKIP LOCKED`; only enabled users are eligible for new callback claims. Their
  clock continues while disabled, and already claimed calls may finish.
- HTTPS destinations require exact operator-trusted `WEBHOOK_ALLOWED_ORIGINS`
  entries. Defaults allow none. No redirects or callback response bodies are
  followed/read; only acknowledgement status and safe classification are stored.
  Domains/DNS must be operator-controlled or trusted, with deployment egress
  rules as an additional network boundary.
- HMAC-SHA256 signs the raw JSON with the literal current webhook secret and a
  timestamp/event-ID prefix. URL and event payload are immutable snapshots;
  signing timestamps/secrets can change per attempt. See
  [Operations](./operations.md#webhook-receivers) for receiver verification,
  freshness checks, and event-ID deduplication.
- Shutdown leaves dispatched work for lease recovery. An acknowledgement lost
  before committing can produce a duplicate callback, never another LLM call.

## Future considerations

- **Credential purge:** old configuration versions are not retained; encrypted
  secrets on soft-deleted accounts currently remain until a purge policy exists.
- **Longer-term retention:** request input starts at seven days after completion;
  response, callback payload, job/attempt metadata, and idempotency retention
  windows still need decisions. Do not silently permit duplicate submissions
  by purging idempotency records too early. Preserve parent job references
  independently of payload expiry, and define continuation availability if
  full responses later expire.
- **Scheduling:** worker concurrency is configurable per process. Add per-user
  fairness/rate limits or memory-aware admission when needed.

## PostgreSQL references

- [Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html): unique
  constraints and composite foreign keys for idempotency and ownership integrity.
- [SELECT and row locking](https://www.postgresql.org/docs/current/sql-select.html):
  `SKIP LOCKED` for multiple workers consuming queue-like tables.
