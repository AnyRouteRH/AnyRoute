CREATE TABLE "escrow_deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"from_address" text NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"account_id" text,
	"price18" text,
	"price_updated_at" timestamp with time zone,
	"credited" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "escrow_deposits_from_idx" ON "escrow_deposits" USING btree ("from_address");--> statement-breakpoint
CREATE INDEX "escrow_deposits_status_idx" ON "escrow_deposits" USING btree ("status");