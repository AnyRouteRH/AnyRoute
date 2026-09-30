CREATE TABLE "sanctions_addresses" (
	"address" text PRIMARY KEY NOT NULL,
	"list_date" timestamp with time zone NOT NULL,
	"source_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanctions_meta" (
	"id" integer PRIMARY KEY NOT NULL,
	"list_date" timestamp with time zone NOT NULL,
	"source_hash" text NOT NULL,
	"entry_count" integer NOT NULL,
	"ignored_count" integer NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
