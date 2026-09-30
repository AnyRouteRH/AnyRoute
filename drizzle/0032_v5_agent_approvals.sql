CREATE TABLE "agent_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"intent" jsonb NOT NULL,
	"intent_hash" text NOT NULL,
	"max_cost_pico" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "agent_approvals_status_check" CHECK ("agent_approvals"."status" in ('pending', 'approved', 'denied', 'expired', 'used')),
	CONSTRAINT "agent_approvals_cost_check" CHECK ("agent_approvals"."max_cost_pico" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_approvals_key_status_idx" ON "agent_approvals" USING btree ("key_hash","status");