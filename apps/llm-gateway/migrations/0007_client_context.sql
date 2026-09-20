ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_payload_check";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "client_context" json;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_context_check" CHECK ("jobs"."client_context" is null or json_typeof("jobs"."client_context") = 'object');--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_payload_check" CHECK (json_typeof("webhook_deliveries"."payload") = 'object');