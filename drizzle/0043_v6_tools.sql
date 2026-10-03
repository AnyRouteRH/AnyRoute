CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"seller_id" text,
	"pay_to" text NOT NULL,
	"resource" text NOT NULL,
	"method" text NOT NULL,
	"network" text NOT NULL,
	"x402_version" integer NOT NULL,
	"price_units" bigint NOT NULL,
	"price" bigint NOT NULL,
	"take" bigint NOT NULL,
	"hold_id" text NOT NULL,
	"payer" text NOT NULL,
	"nonce" text NOT NULL,
	"valid_before" timestamp with time zone NOT NULL,
	"settle_tx" text,
	"response_sha256" text,
	"seller_status" integer,
	"status" text NOT NULL,
	"failure" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tool_calls_status_valid" CHECK ("tool_calls"."status" in ('paying','ok','failed','released','charged_after_failure')),
	CONSTRAINT "tool_calls_amounts_valid" CHECK ("tool_calls"."price_units" > 0 and "tool_calls"."price" >= 0 and "tool_calls"."take" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tool_canary_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"failure" text,
	"price_units" bigint,
	"settle_tx" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"created_by" text NOT NULL,
	"skill_id" text,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"resource" text NOT NULL,
	"method" text NOT NULL,
	"price_units" bigint NOT NULL,
	"pay_to" text NOT NULL,
	"network" text NOT NULL,
	"canary" jsonb NOT NULL,
	"status" text DEFAULT 'listed' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"delisted_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_listings_status_valid" CHECK ("tool_listings"."status" in ('listed','delisted','removed')),
	CONSTRAINT "tool_listings_method_valid" CHECK ("tool_listings"."method" in ('GET','POST')),
	CONSTRAINT "tool_listings_price_positive" CHECK ("tool_listings"."price_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "tool_canary_runs" ADD CONSTRAINT "tool_canary_runs_seller_id_tool_listings_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."tool_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_listings" ADD CONSTRAINT "tool_listings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_listings" ADD CONSTRAINT "tool_listings_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_calls_key_idx" ON "tool_calls" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_status_idx" ON "tool_calls" USING btree ("status","valid_before");--> statement-breakpoint
CREATE INDEX "tool_calls_created_idx" ON "tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_canary_runs_seller_idx" ON "tool_canary_runs" USING btree ("seller_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_listings_resource_uq" ON "tool_listings" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "tool_listings_status_idx" ON "tool_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tool_listings_skill_idx" ON "tool_listings" USING btree ("skill_id");