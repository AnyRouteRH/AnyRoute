CREATE TABLE "tlog_checkpoints" (
	"size" bigint PRIMARY KEY NOT NULL,
	"root_hash" text NOT NULL,
	"checkpoint" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlog_cosignatures" (
	"size" bigint NOT NULL,
	"witness" text NOT NULL,
	"key_id" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tlog_cosignatures_size_witness_key_id_pk" PRIMARY KEY("size","witness","key_id")
);
--> statement-breakpoint
CREATE TABLE "tlog_entries" (
	"idx" bigint PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"subject" text NOT NULL,
	"entry" text NOT NULL,
	"leaf_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tlog_entries_kind_sha256_uq" ON "tlog_entries" USING btree ("kind","sha256");--> statement-breakpoint
CREATE INDEX "tlog_entries_subject_idx" ON "tlog_entries" USING btree ("kind","subject");