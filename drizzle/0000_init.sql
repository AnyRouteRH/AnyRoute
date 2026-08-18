CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'key' NOT NULL,
	"wallet" text,
	"balance" bigint DEFAULT 0 NOT NULL,
	"held" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anchors" (
	"index" integer PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"tee_kind" text,
	"report_hash" text,
	"nonce" text,
	"measurements" jsonb,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "byok_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"key_enc" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canaries" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"quant_match" boolean,
	"quant_guess" text,
	"distance" real,
	"quality" real,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "canary_references" (
	"model_id" text NOT NULL,
	"quant" text NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canary_references_model_id_quant_pk" PRIMARY KEY("model_id","quant")
);
--> statement-breakpoint
CREATE TABLE "chain_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"contract" text NOT NULL,
	"event" text NOT NULL,
	"block_number" bigint NOT NULL,
	"args" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
