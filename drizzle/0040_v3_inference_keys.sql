ALTER TABLE "accounts" ADD COLUMN "inference_keys_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "keys" ADD COLUMN "scope" text;
--> statement-breakpoint
ALTER TABLE "keys" ADD COLUMN "include_byok_in_limit" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "keys" ADD CONSTRAINT "keys_scope_valid" CHECK ("scope" IS NULL OR "scope" = 'inference');
--> statement-breakpoint
ALTER TABLE "keys" ADD CONSTRAINT "keys_scope_management" CHECK ("scope" IS DISTINCT FROM 'inference' OR "management" = false);
