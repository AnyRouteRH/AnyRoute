CREATE TABLE "blind_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"denomination" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"spki" text NOT NULL,
	"private_enc" text,
	"valid_from" timestamp with time zone NOT NULL,
	"issue_until" timestamp with time zone NOT NULL,
	"redeem_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"issued" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blind_nullifiers" (
	"nullifier" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spent_at" timestamp with time zone,
	"generation_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "blind_keys_epoch_denomination_uq" ON "blind_keys" USING btree ("epoch","denomination");--> statement-breakpoint
CREATE INDEX "blind_nullifiers_key_idx" ON "blind_nullifiers" USING btree ("key_id");