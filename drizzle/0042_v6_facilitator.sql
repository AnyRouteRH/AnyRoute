CREATE TABLE "facilitator_sellers" (
	"id" text PRIMARY KEY NOT NULL,
	"pay_to" text NOT NULL,
	"resource" text NOT NULL,
	"price_hint" numeric(78, 0),
	"result_schema" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilitator_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"payer" text NOT NULL,
	"pay_to" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"nonce" text NOT NULL,
	"tx_hash" text,
	"status" text NOT NULL,
	"error" text,
	"seller_id" text,
	"x402_version" smallint NOT NULL,
	"fee_value" numeric(78, 0),
	"fee_tx_hash" text,
	"gas_debit" numeric(78, 0),
	"settled_at" timestamp with time zone,
	"receipt_cose" text,
	"receipt_leaf" text,
	"receipt_key_id" text,
	"anchor_index" integer,
	"leaf_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilitator_settlements_status" CHECK ("facilitator_settlements"."status" IN ('verified','settled','failed')),
	CONSTRAINT "facilitator_settlements_kind" CHECK ("facilitator_settlements"."kind" IN ('payment','gas_float'))
);
--> statement-breakpoint
CREATE TABLE "seller_gas_floats" (
	"seller_id" text PRIMARY KEY NOT NULL,
	"balance" numeric(78, 0) DEFAULT 0 NOT NULL,
	"funded" numeric(78, 0) DEFAULT 0 NOT NULL,
	"debited" numeric(78, 0) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_gas_floats_balance" CHECK ("seller_gas_floats"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "seller_gas_floats" ADD CONSTRAINT "seller_gas_floats_seller_id_facilitator_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."facilitator_sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facilitator_sellers_resource_uq" ON "facilitator_sellers" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "facilitator_sellers_pay_to_idx" ON "facilitator_sellers" USING btree ("pay_to");--> statement-breakpoint
CREATE UNIQUE INDEX "facilitator_settlements_payer_nonce_uq" ON "facilitator_settlements" USING btree ("payer","nonce");--> statement-breakpoint
CREATE INDEX "facilitator_settlements_anchor_idx" ON "facilitator_settlements" USING btree ("anchor_index");--> statement-breakpoint
CREATE INDEX "facilitator_settlements_pay_to_idx" ON "facilitator_settlements" USING btree ("pay_to");