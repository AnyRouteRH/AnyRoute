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
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"amount" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"generation_id" text,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ctx" integer DEFAULT 8192 NOT NULL,
	"max_out" integer,
	"arch" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hf_repo" text,
	"creator" text,
	"royalty_bps" integer DEFAULT 0 NOT NULL,
	"created_unix" integer NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"price_prompt" bigint NOT NULL,
	"price_completion" bigint NOT NULL,
	"price_request" bigint DEFAULT 0 NOT NULL,
	"price_image" bigint DEFAULT 0 NOT NULL,
	"price_web_search" bigint DEFAULT 0 NOT NULL,
	"price_reasoning" bigint DEFAULT 0 NOT NULL,
	"price_cache_read" bigint,
	"price_cache_write" bigint,
	"quant" text DEFAULT 'unknown' NOT NULL,
	"ctx" integer,
	"max_out" integer,
	"supported_parameters" text[] DEFAULT '{}' NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_moderated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_model_id_provider_id_pk" PRIMARY KEY("model_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"usdg" bigint NOT NULL,
	"to" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywith_debts" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"token" text NOT NULL,
	"amount" bigint NOT NULL,
	"raw_estimate" bigint,
	"fair_price18" text,
	"swap_id" text,
	"raw_allocated" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywith_sessions" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"cap_raw_day" bigint NOT NULL,
	"spent_raw_today" bigint DEFAULT 0 NOT NULL,
	"day_start" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"opened_tx" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywith_swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"token" text NOT NULL,
	"raw_spent" bigint,
	"fair_price" text,
	"usdg_out" bigint NOT NULL,
	"tx" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"allocations" jsonb
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text,
	"kind" text DEFAULT 'openai' NOT NULL,
	"headers" jsonb,
	"data_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"datacenter" text[],
	"attested" boolean DEFAULT false NOT NULL,
	"attestation_url" text,
	"attestation_hash" text,
	"attested_at" timestamp with time zone,
	"tee_kind" text,
	"bond_usdg" bigint DEFAULT 0 NOT NULL,
	"anyr_stake" bigint DEFAULT 0 NOT NULL,
	"operator" text,
	"payout_mode" text DEFAULT 'invoice' NOT NULL,
	"payout_address" text,
	"status" text DEFAULT 'applied' NOT NULL,
	"shadow_until" timestamp with time zone,
	"timeout_ms" integer,
	"contact" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"nonce" text PRIMARY KEY NOT NULL,
	"price_usdg" bigint NOT NULL,
	"price_pico" bigint NOT NULL,
	"request_sha256" text NOT NULL,
	"model_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payer" text,
	"tx_hash" text,
	"account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" text,
	"valid_from" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"onchain_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalties" (
	"model_id" text NOT NULL,
	"period" text NOT NULL,
	"amount" bigint NOT NULL,
	"usdg" bigint NOT NULL,
	"creator" text,
	"stream_tx" text,
	"claimed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "royalties_model_id_period_pk" PRIMARY KEY("model_id","period")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"provider_id" text NOT NULL,
	"period" text NOT NULL,
	"tokens" bigint NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"upstream" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"usdg_owed" bigint NOT NULL,
	"payout_id" text,
	"paid_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_provider_id_period_pk" PRIMARY KEY("provider_id","period")
);
--> statement-breakpoint
CREATE TABLE "slashes" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text,
	"kind" text NOT NULL,
	"amount_usdg" bigint NOT NULL,
	"delist" boolean DEFAULT false NOT NULL,
	"evidence_root" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executable_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"dispute_hash" text,
	"disputed_at" timestamp with time zone,
	"onchain_id" text,
	"tx_hash" text,
	"refunded" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spent_roots" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"total_spent_usdg" bigint NOT NULL,
	"leaves" jsonb NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_key_hash_pk" PRIMARY KEY("team_id","key_hash")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_account" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_wallet_uq" ON "accounts" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "attestations_provider_ts" ON "attestations" USING btree ("provider_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "byok_account_provider_uq" ON "byok_keys" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE INDEX "canaries_mp_ts_idx" ON "canaries" USING btree ("model_id","provider_id","ts");--> statement-breakpoint
CREATE INDEX "chain_events_unprocessed" ON "chain_events" USING btree ("processed","event");--> statement-breakpoint
CREATE INDEX "gen_ts_idx" ON "generations" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "gen_key_ts_idx" ON "generations" USING btree ("key_hash","ts");--> statement-breakpoint
CREATE INDEX "gen_provider_ts_idx" ON "generations" USING btree ("provider_id","ts");--> statement-breakpoint
CREATE INDEX "gen_anchor_idx" ON "generations" USING btree ("anchor_index");--> statement-breakpoint
CREATE INDEX "health_mp_ts_idx" ON "health" USING btree ("model_id","provider_id","ts");--> statement-breakpoint
CREATE INDEX "holds_account_status_idx" ON "holds" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "holds_expiry_idx" ON "holds" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keys_chain_uq" ON "keys" USING btree ("chain_key_hash");--> statement-breakpoint
CREATE INDEX "keys_account_idx" ON "keys" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_ref_uq" ON "ledger" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "offers_provider_idx" ON "offers" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "paywith_debts_open_idx" ON "paywith_debts" USING btree ("chain_key_hash","swap_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_tx_uq" ON "quotes" USING btree ("tx_hash");