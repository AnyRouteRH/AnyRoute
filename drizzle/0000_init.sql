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
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"key_hash" text,
	"account_id" text,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"upstream_cost" bigint DEFAULT 0 NOT NULL,
	"royalty" bigint DEFAULT 0 NOT NULL,
	"margin" bigint DEFAULT 0 NOT NULL,
	"cache_discount" bigint DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"latency_ms" integer,
	"generation_time_ms" integer,
	"finish_reason" text,
	"native_finish_reason" text,
	"streamed" boolean DEFAULT false NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"quant" text,
	"data_region" text,
	"is_byok" boolean DEFAULT false NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"attestation_hash" text,
	"receipt_id" text,
	"receipt_sig" text,
	"receipt_key_id" text,
	"receipt" jsonb,
	"receipt_leaf" text,
	"anchor_index" integer,
	"leaf_index" integer,
	"paid_with" jsonb,
	"payment_tx" text,
	"app_id" text,
	"attempts" jsonb,
	"request_sha256" text,
	"response_sha256" text,
	"settled_period" text
);
--> statement-breakpoint
CREATE TABLE "health" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"tps" real,
	"empty200" boolean DEFAULT false NOT NULL,
	"status_code" integer,
	"error_kind" text,
	"source" text DEFAULT 'traffic' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"kind" text DEFAULT 'usage' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"chain_key_hash" text NOT NULL,
	"key_address" text NOT NULL,
	"account_id" text NOT NULL,
	"parent_hash" text,
	"name" text DEFAULT '' NOT NULL,
	"label" text NOT NULL,
	"budget" bigint,
	"budget_reset" text,
	"period_start" timestamp with time zone,
	"spent" bigint DEFAULT 0 NOT NULL,
	"spent_total" bigint DEFAULT 0 NOT NULL,
	"rpm" integer,
	"tpm" integer,
	"team_id" text,
	"allowed_models" text[],
	"pay_with_default" text,
	"management" boolean DEFAULT false NOT NULL,
	"routing" jsonb,
	"guardrails" jsonb,
	"disabled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone
);
