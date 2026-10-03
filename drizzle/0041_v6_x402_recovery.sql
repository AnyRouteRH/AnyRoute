CREATE TABLE "x402_paid_results" (
	"payer" text NOT NULL,
	"nonce" text NOT NULL,
	"request_sha256" text NOT NULL,
	"response_sha256" text NOT NULL,
	"body_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x402_paid_results_payer_nonce_pk" PRIMARY KEY("payer","nonce")
);
--> statement-breakpoint
CREATE INDEX "x402_paid_results_created_idx" ON "x402_paid_results" USING btree ("created_at");
