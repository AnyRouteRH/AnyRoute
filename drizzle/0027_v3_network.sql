CREATE TABLE "network_waitlist" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"hardware" text NOT NULL,
	"readiness" text NOT NULL,
	"region" text NOT NULL,
	"contact" text,
	"paid_in" text NOT NULL,
	"delete_code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_role" CHECK ("network_waitlist"."role" in ('host_gpu','host_cpu','relay','witness','developer')),
	CONSTRAINT "network_region" CHECK ("network_waitlist"."region" in ('africa','antarctica','asia','europe','north_america','oceania','south_america')),
	CONSTRAINT "network_paid_in" CHECK ("network_waitlist"."paid_in" in ('usdg','anyr','any')),
	CONSTRAINT "network_lengths" CHECK (char_length("network_waitlist"."hardware") <= 200 and char_length("network_waitlist"."readiness") <= 300 and char_length("network_waitlist"."contact") <= 120 and char_length("network_waitlist"."delete_code_hash") = 64)
);
