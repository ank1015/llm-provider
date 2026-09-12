DROP INDEX "user_api_keys_user_idx";--> statement-breakpoint
CREATE INDEX "user_api_keys_user_created_idx" ON "user_api_keys" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);