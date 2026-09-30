CREATE TABLE "agent_policies" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"killed" boolean DEFAULT false NOT NULL,
	"killed_at" timestamp with time zone,
	"killed_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_policy_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"decision" text,
	"reasons" jsonb NOT NULL,
	"intent" jsonb,
	"policy_sha256" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_policy_events_key_idx" ON "agent_policy_events" USING btree ("key_hash","id");--> statement-breakpoint
CREATE INDEX "agent_policy_events_ts_idx" ON "agent_policy_events" USING btree ("ts");