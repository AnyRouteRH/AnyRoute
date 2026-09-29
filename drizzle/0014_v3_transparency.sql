CREATE TABLE "measurement_bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"compose_hash" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"signature" text NOT NULL,
	"signer_key_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rekor_uuid" text,
	"rekor_entry" text,
	"rekor_log_index" bigint,
	"rekor_integrated_at" timestamp with time zone,
	"rekor_entry_json" jsonb,
	"rekor_inclusion_verified" boolean DEFAULT false NOT NULL,
	"rekor_checkpoint_verified" boolean DEFAULT false NOT NULL,
	"rekor_set_verified" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_bundles_provider_digest_uq" ON "measurement_bundles" USING btree ("provider_id","bundle_digest");--> statement-breakpoint
CREATE INDEX "measurement_bundles_compose_idx" ON "measurement_bundles" USING btree ("provider_id","compose_hash");--> statement-breakpoint
CREATE INDEX "measurement_bundles_status_idx" ON "measurement_bundles" USING btree ("status","checked_at");