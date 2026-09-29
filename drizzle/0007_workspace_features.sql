CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"parent_key_hash" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"budget" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"kind" text NOT NULL,
	"window" text DEFAULT 'day' NOT NULL,
	"threshold" bigint,
	"pct" integer,
	"webhook_url_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_period" text,
	"state" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_key_uq" ON "agent_sessions" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "agent_sessions_account_idx" ON "agent_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_routes_account_slug_uq" ON "saved_routes" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX "spend_alerts_account_idx" ON "spend_alerts" USING btree ("account_id");