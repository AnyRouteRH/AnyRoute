CREATE TABLE "makegood_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"payer" text NOT NULL,
	"usdg" bigint NOT NULL,
	"status" text DEFAULT 'signed' NOT NULL,
	"tx_hash" text NOT NULL,
	"signed_tx_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "makegood_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"generation_id" text,
	"account_id" text NOT NULL,
	"key_hash" text,
	"rule" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"charged" bigint DEFAULT 0 NOT NULL,
	"evidence" jsonb NOT NULL,
	"provider_id" text,
	"strike" boolean DEFAULT false NOT NULL,
	"payer" text,
	"onchain_usdg" bigint,
	"payout_status" text DEFAULT 'none' NOT NULL,
	"payout_id" text,
	"receipt" jsonb,
	"receipt_sig" text,
	"receipt_key_id" text,
	"receipt_leaf" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "makegood_refunds" ADD CONSTRAINT "makegood_refunds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "makegood_refunds" ADD CONSTRAINT "makegood_refunds_payout_id_makegood_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."makegood_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "makegood_payouts_tx_uq" ON "makegood_payouts" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "makegood_payouts_status_idx" ON "makegood_payouts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "makegood_refunds_source_uq" ON "makegood_refunds" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "makegood_refunds_status_idx" ON "makegood_refunds" USING btree ("status","detected_at");--> statement-breakpoint
CREATE INDEX "makegood_refunds_account_idx" ON "makegood_refunds" USING btree ("account_id","detected_at");--> statement-breakpoint
CREATE INDEX "makegood_refunds_payout_idx" ON "makegood_refunds" USING btree ("payout_status","payer");