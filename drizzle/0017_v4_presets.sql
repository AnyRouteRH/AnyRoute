CREATE TABLE "preset_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"source" text DEFAULT 'put' NOT NULL,
	"restored_from" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "preset_versions_account_name_version_uq" ON "preset_versions" USING btree ("account_id","name","version");