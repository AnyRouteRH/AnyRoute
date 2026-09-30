CREATE TABLE "host_policies" (
	"version" integer PRIMARY KEY NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"canonical" text NOT NULL,
	"sha256" text NOT NULL,
	"signature" text NOT NULL,
	"verifier_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_policies_sha256_unique" UNIQUE("sha256")
);
