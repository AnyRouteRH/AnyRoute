CREATE TABLE "network_fee_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"period" text NOT NULL,
	"gross_pico" numeric(78, 0) NOT NULL,
	"fee_pico" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'accrued' NOT NULL,
	"swap_tx" text,
	"burn_tx" text,
	"anyr_amount" numeric(78, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_fee_status" CHECK ("network_fee_ledger"."status" in ('accrued','swapped','burned')),
	CONSTRAINT "network_fee_amounts" CHECK ("network_fee_ledger"."gross_pico" >= 0 and "network_fee_ledger"."fee_pico" >= 0 and "network_fee_ledger"."fee_pico" <= "network_fee_ledger"."gross_pico")
);
--> statement-breakpoint
CREATE TABLE "network_payout_dispatch" (
	"payout_id" text PRIMARY KEY NOT NULL,
	"signed_tx_enc" text NOT NULL,
	"tx_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_receipt_links" (
	"generation_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"accrued_period" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "network_fee_period_uq" ON "network_fee_ledger" USING btree ("provider_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "network_receipt_once_uq" ON "network_receipt_links" USING btree ("provider_id","receipt_id");