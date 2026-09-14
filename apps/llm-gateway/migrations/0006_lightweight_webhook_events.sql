UPDATE "webhook_deliveries" AS "delivery"
SET "payload" = json_build_object(
	'eventId', "delivery"."id",
	'type', "delivery"."event_type",
	'jobId', "delivery"."job_id",
	'completedAt', to_char("job"."finished_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
FROM "jobs" AS "job"
WHERE "job"."id" = "delivery"."job_id";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_payload_check" CHECK (json_typeof("webhook_deliveries"."payload") = 'object'
    and "webhook_deliveries"."payload"::jsonb ?& array['eventId', 'type', 'jobId', 'completedAt']
    and "webhook_deliveries"."payload"::jsonb - array['eventId', 'type', 'jobId', 'completedAt'] = '{}'::jsonb
    and "webhook_deliveries"."payload"->>'eventId' = "webhook_deliveries"."id"::text
    and "webhook_deliveries"."payload"->>'type' = "webhook_deliveries"."event_type"
    and "webhook_deliveries"."payload"->>'jobId' = "webhook_deliveries"."job_id"::text
    and json_typeof("webhook_deliveries"."payload"->'completedAt') = 'string');
