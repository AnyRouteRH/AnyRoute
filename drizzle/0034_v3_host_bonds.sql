CREATE TABLE "host_bond_cursor" (
	"scope" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text,
	"checkpoints" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_bond_events" (
	"scope" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	CONSTRAINT "host_bond_events_scope_tx_hash_log_index_pk" PRIMARY KEY("scope","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "host_bond_projection" (
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "host_bond_projection_scope_kind_id_pk" PRIMARY KEY("scope","kind","id")
);
--> statement-breakpoint
CREATE TABLE "host_slash_evidence" (
	"scope" text NOT NULL,
	"root" text NOT NULL,
	"provider_id" text NOT NULL,
	"host_id" text NOT NULL,
	"canonical" text NOT NULL,
	"reason" integer NOT NULL,
	"amount" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"proposal_tx" text,
	"proposal_raw" text,
	"execution_tx" text,
	"execution_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_slash_evidence_scope_root_pk" PRIMARY KEY("scope","root")
);
--> statement-breakpoint
CREATE INDEX "host_bond_events_order" ON "host_bond_events" USING btree ("scope","block","log_index");