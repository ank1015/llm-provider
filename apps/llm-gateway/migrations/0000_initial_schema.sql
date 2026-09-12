CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"account_config_version" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"provider_response_id" text,
	"resolved_model_id" text,
	"error" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"input_cost_usd" numeric(30, 12),
	"output_cost_usd" numeric(30, 12),
	"cache_read_cost_usd" numeric(30, 12),
	"cache_write_cost_usd" numeric(30, 12),
	"total_cost_usd" numeric(30, 12),
	CONSTRAINT "job_attempts_number_unique" UNIQUE("job_id","attempt_number"),
	CONSTRAINT "job_attempts_number_check" CHECK ("job_attempts"."attempt_number" > 0 and "job_attempts"."account_config_version" > 0),
	CONSTRAINT "job_attempts_status_check" CHECK ("job_attempts"."status" in ('running', 'succeeded', 'failed', 'cancelled', 'unknown')),
	CONSTRAINT "job_attempts_finished_check" CHECK (("job_attempts"."status" <> 'running') = ("job_attempts"."finished_at" is not null)),
	CONSTRAINT "job_attempts_counts_check" CHECK ("job_attempts"."duration_ms" >= 0 and "job_attempts"."input_tokens" >= 0 and "job_attempts"."output_tokens" >= 0 and "job_attempts"."cache_read_tokens" >= 0 and "job_attempts"."cache_write_tokens" >= 0),
	CONSTRAINT "job_attempts_input_cost_usd_check" CHECK ("job_attempts"."input_cost_usd" >= 0 and "job_attempts"."input_cost_usd" <> 'NaN'::numeric),
	CONSTRAINT "job_attempts_output_cost_usd_check" CHECK ("job_attempts"."output_cost_usd" >= 0 and "job_attempts"."output_cost_usd" <> 'NaN'::numeric),
	CONSTRAINT "job_attempts_cache_read_cost_usd_check" CHECK ("job_attempts"."cache_read_cost_usd" >= 0 and "job_attempts"."cache_read_cost_usd" <> 'NaN'::numeric),
	CONSTRAINT "job_attempts_cache_write_cost_usd_check" CHECK ("job_attempts"."cache_write_cost_usd" >= 0 and "job_attempts"."cache_write_cost_usd" <> 'NaN'::numeric),
	CONSTRAINT "job_attempts_total_cost_usd_check" CHECK ("job_attempts"."total_cost_usd" >= 0 and "job_attempts"."total_cost_usd" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "job_requests" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"request" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "job_requests_messages_check" CHECK (coalesce(jsonb_typeof("job_requests"."request"->'messages') = 'array', false))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"previous_job_id" uuid,
	"model_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"response" jsonb,
	"error" jsonb,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_user_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "jobs_idempotency_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_outcome_check" CHECK (
    ("jobs"."status" = 'succeeded' and "jobs"."response" is not null and "jobs"."error" is null)
    or ("jobs"."status" = 'failed' and "jobs"."error" is not null and "jobs"."response" is null)
    or ("jobs"."status" in ('queued', 'running', 'retry_wait', 'cancelled') and "jobs"."response" is null and "jobs"."error" is null)
  ),
	CONSTRAINT "jobs_finished_check" CHECK (("jobs"."status" in ('succeeded', 'failed', 'cancelled')) = ("jobs"."finished_at" is not null)),
	CONSTRAINT "jobs_lease_check" CHECK (("jobs"."lease_token" is null) = ("jobs"."lease_expires_at" is null)),
	CONSTRAINT "jobs_parent_check" CHECK ("jobs"."previous_job_id" <> "jobs"."id")
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_encrypted" "bytea" NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_accounts_user_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "provider_accounts_provider_check" CHECK ("provider_accounts"."provider" in ('openai', 'chatgpt', 'fireworks')),
	CONSTRAINT "provider_accounts_version_check" CHECK ("provider_accounts"."config_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"callback_url" text NOT NULL,
	"webhook_secret_encrypted" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"callback_url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "webhook_deliveries_event_check" CHECK ("webhook_deliveries"."event_type" in ('job.succeeded', 'job.failed', 'job.cancelled')),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'delivering', 'retry_wait', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_delivered_check" CHECK ("webhook_deliveries"."status" <> 'delivered' or "webhook_deliveries"."delivered_at" is not null),
	CONSTRAINT "webhook_deliveries_lease_check" CHECK (("webhook_deliveries"."lease_token" is null) = ("webhook_deliveries"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"http_status" integer,
	"error" jsonb,
	CONSTRAINT "webhook_delivery_attempts_number_unique" UNIQUE("delivery_id","attempt_number"),
	CONSTRAINT "webhook_delivery_attempts_number_check" CHECK ("webhook_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "webhook_delivery_attempts_http_check" CHECK ("webhook_delivery_attempts"."http_status" between 100 and 599)
);
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requests" ADD CONSTRAINT "job_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_owner_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."provider_accounts"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_owner_fk" FOREIGN KEY ("user_id","previous_job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_job_owner_fk" FOREIGN KEY ("user_id","job_id") REFERENCES "public"."jobs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_requests_expiry_idx" ON "job_requests" USING btree ("expires_at","job_id") WHERE "job_requests"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "jobs_user_created_idx" ON "jobs" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_user_account_created_idx" ON "jobs" USING btree ("user_id","account_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_parent_idx" ON "jobs" USING btree ("user_id","previous_job_id") WHERE "jobs"."previous_job_id" is not null;--> statement-breakpoint
CREATE INDEX "jobs_runnable_idx" ON "jobs" USING btree ("next_attempt_at","id") WHERE "jobs"."status" in ('queued', 'retry_wait');--> statement-breakpoint
CREATE INDEX "jobs_expired_lease_idx" ON "jobs" USING btree ("lease_expires_at") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "provider_accounts_live_user_provider_idx" ON "provider_accounts" USING btree ("user_id","provider") WHERE "provider_accounts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "user_api_keys_user_idx" ON "user_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_user_created_idx" ON "webhook_deliveries" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_runnable_idx" ON "webhook_deliveries" USING btree ("next_attempt_at","id") WHERE "webhook_deliveries"."status" in ('pending', 'retry_wait');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_expired_lease_idx" ON "webhook_deliveries" USING btree ("lease_expires_at") WHERE "webhook_deliveries"."status" = 'delivering';