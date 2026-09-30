CREATE TABLE "batch_lines" (
	"batch_id" text NOT NULL,
	"idx" integer NOT NULL,
	"api" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status_code" integer,
	"generation_id" text,
	"cost" bigint DEFAULT 0 NOT NULL,
	"list_cost" bigint DEFAULT 0 NOT NULL,
	"failure_code" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "batch_lines_batch_id_idx_pk" PRIMARY KEY("batch_id","idx")
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"api" text NOT NULL,
	"status" text DEFAULT 'validating' NOT NULL,
	"total" integer NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"list_cost" bigint DEFAULT 0 NOT NULL,
	"discount_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"cancelling_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"results_expire_at" timestamp with time zone,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "batch_lines_queue_idx" ON "batch_lines" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "batches_key_created_idx" ON "batches" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "batches_status_idx" ON "batches" USING btree ("status","created_at");