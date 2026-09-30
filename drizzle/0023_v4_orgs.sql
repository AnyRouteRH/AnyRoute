CREATE TABLE "team_audit" (
	"team_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "team_audit_team_id_seq_pk" PRIMARY KEY("team_id","seq")
);
--> statement-breakpoint
CREATE TABLE "team_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"public_key" text,
	"alg" integer,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "owner_address" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "owner_kind" text DEFAULT 'account' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "owner_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "budget" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "team_principals_team_kind_subject_uq" ON "team_principals" USING btree ("team_id","kind","subject");--> statement-breakpoint
CREATE OR REPLACE FUNCTION team_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'team_audit is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER team_audit_no_update BEFORE UPDATE OR DELETE ON team_audit
  FOR EACH ROW EXECUTE FUNCTION team_audit_append_only();
