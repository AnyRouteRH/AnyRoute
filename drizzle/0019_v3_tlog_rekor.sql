CREATE TABLE "tlog_rekor_anchors" (
	"id" serial PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"root_hash" text NOT NULL,
	"note" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"key_id" text NOT NULL,
	"rekor_url" text NOT NULL,
	"uuid" text NOT NULL,
	"status" text NOT NULL,
	"log_index" bigint,
	"integrated_time" bigint,
	"log_id" text,
	"entry_base64" text,
	"inclusion_proof" jsonb,
	"signed_entry_timestamp" text,
	"checkpoint_verified" boolean DEFAULT false NOT NULL,
	"set_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tlog_rekor_anchors_uuid_uq" ON "tlog_rekor_anchors" USING btree ("rekor_url","uuid");--> statement-breakpoint
CREATE INDEX "tlog_rekor_anchors_status_size_idx" ON "tlog_rekor_anchors" USING btree ("status","size");