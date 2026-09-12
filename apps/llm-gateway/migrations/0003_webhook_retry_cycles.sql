ALTER TABLE "webhook_deliveries" ADD COLUMN "retry_from_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "retry_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_retry_check" CHECK ("webhook_deliveries"."retry_from_attempt" > 0);