ALTER TABLE "job_requests" DROP CONSTRAINT "job_requests_messages_check";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "usage" jsonb;--> statement-breakpoint
UPDATE "jobs" SET "usage" = "response"->'usage' WHERE "response" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "job_requests" ALTER COLUMN "request" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "response" SET DATA TYPE json;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "payload" SET DATA TYPE json;
