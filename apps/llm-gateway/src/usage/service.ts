import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { jobs, jobAttempts, providerAccounts } from "../db/schema.js";
import { cursorKey, encodeCursor, type UsageQuery } from "./validation.js";

const tokenColumns = { input: "input_tokens", output: "output_tokens", cacheRead: "cache_read_tokens", cacheWrite: "cache_write_tokens" };
const costColumns = { input: "input_cost_usd", output: "output_cost_usd", cacheRead: "cache_read_cost_usd", cacheWrite: "cache_write_cost_usd", total: "total_cost_usd" };
const metricColumns = [...Object.values(tokenColumns), ...Object.values(costColumns)];
type Bucket = { knownTotal: string | null; knownAttempts: string; missingAttempts: string };
type JobStatus = typeof jobs.$inferSelect.status;
type AttemptStatus = typeof jobAttempts.$inferSelect.status;
type Metrics = {
  jobs: Record<JobStatus | "total", string>;
  attempts: Record<AttemptStatus | "total", string>;
  tokens: Record<keyof typeof tokenColumns, Bucket>;
  costUsd: Record<keyof typeof costColumns, Bucket>;
};
type Group = { accountId: string; provider: string } | { provider: string; modelId?: string } | { day: string };
type Row = Metrics & { is_summary: boolean; group_key: string | null; group: Group | null };

function count(kind: "job" | "attempt", status?: string) {
  return sql`count(*) filter (where kind = ${kind}${status ? sql` and status = ${status}` : sql``})`;
}

function statusCounts(kind: "job" | "attempt", statuses: readonly string[]) {
  const entries = [sql`'total', ${count(kind)}::text`, ...statuses.map((status) => sql`${status}::text, ${count(kind, status)}::text`)];
  return sql`jsonb_build_object(${sql.join(entries, sql`, `)})`;
}

function buckets(columns: Record<string, string>) {
  return sql`jsonb_build_object(${sql.join(Object.entries(columns).map(([name, field]) => {
    const column = sql.identifier(field);
    return sql`${name}::text, jsonb_build_object(
      'knownTotal', sum(${column})::text,
      'knownAttempts', count(${column})::text,
      'missingAttempts', (${count("attempt")} - count(${column}))::text
    )`;
  }), sql`, `)})`;
}

function period(column: SQL, input: UsageQuery) {
  return sql`${input.from ? sql`${column} >= ${input.from}::timestamptz` : sql`true`}
    and ${input.to ? sql`${column} < ${input.to}::timestamptz` : sql`true`}`;
}

function groupKey(groupBy: UsageQuery["groupBy"], time: SQL) {
  switch (groupBy) {
    case "account": return sql`j.account_id::text`;
    case "provider": return sql`j.provider`;
    case "model": return sql`j.provider || ':' || j.model_id`;
    case "day": return sql`to_char(${time} at time zone 'UTC', 'YYYY-MM-DD')`;
    default: return sql`null::text`;
  }
}

function groupFields(groupBy: UsageQuery["groupBy"]) {
  switch (groupBy) {
    case "account": return sql`jsonb_build_object('accountId', group_key, 'provider', min(provider))`;
    case "provider": return sql`jsonb_build_object('provider', group_key)`;
    case "model": return sql`jsonb_build_object('provider', min(provider), 'modelId', min(model_id))`;
    case "day": return sql`jsonb_build_object('day', group_key)`;
    default: return sql`null::jsonb`;
  }
}

/** One statement/snapshot; job facts and attempt facts cannot multiply each other's counts. */
export async function getUsage(db: Database, userId: string, input: UsageQuery) {
  const after = cursorKey(input);
  const result = await db.execute<Row>(sql`
    with selected_jobs as not materialized (
      select ${jobs.id} as id, ${jobs.accountId} as account_id, ${jobs.modelId} as model_id,
        ${jobs.status} as status, ${jobs.createdAt} as created_at, ${providerAccounts.provider} as provider
      from ${jobs} join ${providerAccounts} on ${providerAccounts.id} = ${jobs.accountId}
      where ${jobs.userId} = ${userId}::uuid
        ${input.accountId ? sql`and ${jobs.accountId} = ${input.accountId}::uuid` : sql``}
        ${input.provider ? sql`and ${providerAccounts.provider} = ${input.provider}` : sql``}
        ${input.modelId ? sql`and ${jobs.modelId} = ${input.modelId}` : sql``}
    ), facts as (
      select 'job' as kind, j.status, j.provider, j.model_id, ${groupKey(input.groupBy, sql`j.created_at`)} as group_key,
        ${sql.join(metricColumns.map((name) => sql`null::numeric as ${sql.identifier(name)}`), sql`, `)}
      from selected_jobs j where ${period(sql`j.created_at`, input)}
      union all
      select 'attempt' as kind, a.status, j.provider, j.model_id, ${groupKey(input.groupBy, sql`a.started_at`)} as group_key,
        ${sql.join(metricColumns.map((name) => sql`${sql.identifier("a")}.${sql.identifier(name)}`), sql`, `)}
      from ${jobAttempts} a join selected_jobs j on j.id = a.job_id
      where ${period(sql`a.started_at`, input)}
    ), aggregates as (
      select ${input.groupBy ? sql`grouping(group_key) = 1` : sql`true`} as is_summary,
        ${input.groupBy ? sql`group_key` : sql`null::text`} as group_key,
        ${input.groupBy ? sql`case when grouping(group_key) = 0 then ${groupFields(input.groupBy)} else null end` : sql`null::jsonb`} as "group",
        ${statusCounts("job", ["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"])} as jobs,
        ${statusCounts("attempt", ["running", "succeeded", "failed", "cancelled", "unknown"])} as attempts,
        ${buckets(tokenColumns)} as tokens, ${buckets(costColumns)} as "costUsd"
      from facts group by ${input.groupBy ? sql`grouping sets ((), (group_key))` : sql`() `}
    )
    select * from aggregates
    where is_summary ${input.groupBy ? sql`or ${after ? sql`group_key collate "C" > ${after} collate "C"` : sql`true`}` : sql``}
    order by is_summary desc, group_key collate "C" asc limit ${input.limit + 2}
  `);
  const [{ is_summary: _, group_key: __, group: ___, ...summary }, ...groups] = result.rows as [Row, ...Row[]];
  const selected = groups.slice(0, input.limit);
  return {
    period: { from: input.from ?? null, to: input.to ?? null, timeZone: "UTC" },
    groupBy: input.groupBy ?? null, summary,
    data: selected.map(({ is_summary: _, group_key: __, ...item }) => item),
    nextCursor: groups.length > input.limit ? encodeCursor(input.groupBy!, selected.at(-1)!.group_key!) : null,
  };
}
