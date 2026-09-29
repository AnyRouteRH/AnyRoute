CREATE TABLE "provider_disclosure" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"retention" text DEFAULT 'logs' NOT NULL,
	"jurisdiction" text DEFAULT 'unknown' NOT NULL,
	"legal_hold" boolean,
	"legal_hold_note" text,
	"training_use" text DEFAULT 'unknown' NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
