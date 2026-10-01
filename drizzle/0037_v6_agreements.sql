CREATE TABLE "agreement_cursor" (
	"scope" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text,
	"checkpoints" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreement_events" (
	"scope" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	CONSTRAINT "agreement_events_scope_tx_hash_log_index_pk" PRIMARY KEY("scope","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "agreement_evidence" (
	"scope" text NOT NULL,
	"agreement_id" text NOT NULL,
	"dispute" text NOT NULL,
	"party" text NOT NULL,
	"sha256" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agreement_evidence_scope_agreement_id_dispute_party_sha256_pk" PRIMARY KEY("scope","agreement_id","dispute","party","sha256")
);
--> statement-breakpoint
CREATE TABLE "agreement_jury" (
	"scope" text NOT NULL,
	"agreement_id" text NOT NULL,
	"dispute" text NOT NULL,
	"root" text NOT NULL,
	"status" text NOT NULL,
	"statement" jsonb NOT NULL,
	"key_id" text NOT NULL,
	"signature" text NOT NULL,
	"posting_tx" text,
	"posting_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agreement_jury_scope_agreement_id_dispute_pk" PRIMARY KEY("scope","agreement_id","dispute")
);
--> statement-breakpoint
CREATE TABLE "agreement_projection" (
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "agreement_projection_scope_kind_id_pk" PRIMARY KEY("scope","kind","id")
);
--> statement-breakpoint
CREATE INDEX "agreement_events_order" ON "agreement_events" USING btree ("scope","block","log_index");