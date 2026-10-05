CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL REFERENCES "accounts"("id"),
	"team_id" text REFERENCES "teams"("id"),
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "playbooks_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_account_name_uq" ON "playbooks" USING btree ("account_id", lower("name"));
--> statement-breakpoint
CREATE TABLE "playbook_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"playbook_id" text NOT NULL,
	"account_id" text NOT NULL,
	"team_id" text,
	"name" text NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"spec" jsonb NOT NULL,
	"followers" integer NOT NULL,
	"actor" text NOT NULL,
	"notify" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_changes_action_check" CHECK ("action" IN ('create', 'update', 'rename', 'delete'))
);
--> statement-breakpoint
CREATE INDEX "playbook_changes_playbook_idx" ON "playbook_changes" USING btree ("playbook_id", "id");
--> statement-breakpoint
CREATE INDEX "playbook_changes_account_at_idx" ON "playbook_changes" USING btree ("account_id", "at");
--> statement-breakpoint
-- A key follows at most one playbook; its own rulebook row keeps kill state and holds a copy of the playbook's current rules.
ALTER TABLE "agent_policies" ADD COLUMN "playbook_id" text REFERENCES "playbooks"("id");
--> statement-breakpoint
CREATE INDEX "agent_policies_playbook_idx" ON "agent_policies" USING btree ("playbook_id") WHERE "playbook_id" IS NOT NULL;
