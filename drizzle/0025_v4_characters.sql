CREATE TABLE "character_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"sealed" text NOT NULL,
	"key_id" text NOT NULL,
	"bytes" integer NOT NULL,
	"embedding" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_usage" (
	"character_id" text NOT NULL,
	"period" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "character_usage_character_id_period_pk" PRIMARY KEY("character_id","period")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"visibility" text NOT NULL,
	"name" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"creator" text,
	"spec" text,
	"card" jsonb,
	"sealed_card" text,
	"card_hash" text NOT NULL,
	"default_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "character_memory_account_scope_idx" ON "character_memory" USING btree ("account_id","scope");--> statement-breakpoint
CREATE INDEX "characters_account_idx" ON "characters" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "characters_visibility_idx" ON "characters" USING btree ("visibility","updated_at");