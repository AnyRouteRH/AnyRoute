CREATE TABLE "status_dp_hours" (
	"instance" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"epsilon" real NOT NULL,
	"counts" jsonb NOT NULL,
	CONSTRAINT "status_dp_hours_instance_hour_pk" PRIMARY KEY("instance","hour")
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"impact" text DEFAULT 'minor' NOT NULL,
	"lanes" jsonb NOT NULL,
	"surfaces" jsonb NOT NULL,
	"source" text NOT NULL,
	"updates" jsonb NOT NULL,
	"evidence" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_windows" (
	"surface" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"ok" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"latency" integer[] NOT NULL,
	CONSTRAINT "status_windows_surface_bucket_pk" PRIMARY KEY("surface","bucket")
);
--> statement-breakpoint
CREATE INDEX "status_dp_hours_hour_idx" ON "status_dp_hours" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "status_incidents_started_idx" ON "status_incidents" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "status_windows_bucket_idx" ON "status_windows" USING btree ("bucket");