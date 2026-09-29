CREATE TABLE "ohttp_keys" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"key_id" integer NOT NULL,
	"kem_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"config" text NOT NULL,
	"config_sha256" text NOT NULL,
	"private_enc" text,
	"valid_from" timestamp with time zone NOT NULL,
	"accept_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ohttp_keys_key_id_idx" ON "ohttp_keys" USING btree ("key_id");