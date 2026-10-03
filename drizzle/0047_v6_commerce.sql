CREATE TABLE "commerce_transfers" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"value_usdg" bigint NOT NULL,
	"authorized" boolean DEFAULT false NOT NULL,
	"tx_from" text,
	CONSTRAINT "commerce_transfers_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE INDEX "commerce_transfers_to_idx" ON "commerce_transfers" USING btree ("to_address","block_time");--> statement-breakpoint
CREATE INDEX "commerce_transfers_from_idx" ON "commerce_transfers" USING btree ("from_address","block_time");