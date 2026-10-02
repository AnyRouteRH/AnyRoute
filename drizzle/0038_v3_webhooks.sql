CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"destination_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event" text NOT NULL,
	"reference" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"event_status" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"attempted_at" timestamp with time zone,
	"next_attempt" timestamp with time zone DEFAULT now() NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"created_by" text NOT NULL,
	"key_hash" text,
	"rule_id" text,
	"url_enc" text NOT NULL,
	"secret_enc" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"events" jsonb NOT NULL,
	"scan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_destination_id_webhook_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."webhook_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_created_by_keys_key_hash_fk" FOREIGN KEY ("created_by") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_rule_id_spend_alerts_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."spend_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("destination_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt");--> statement-breakpoint
CREATE INDEX "webhook_destinations_account_idx" ON "webhook_destinations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_destinations_rule_idx" ON "webhook_destinations" USING btree ("rule_id");