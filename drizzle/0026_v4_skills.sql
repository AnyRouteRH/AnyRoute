CREATE TABLE "skill_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"price_usdg" bigint NOT NULL,
	"author_share" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"description" text NOT NULL,
	"author" text NOT NULL,
	"account_id" text,
	"created_by" text,
	"source" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"tar_sha256" text NOT NULL,
	"archive" text NOT NULL,
	"size" integer NOT NULL,
	"file_count" integer NOT NULL,
	"level" text NOT NULL,
	"score" integer NOT NULL,
	"report" jsonb NOT NULL,
	"price_usdg" bigint DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_installs_skill_account_uq" ON "skill_installs" USING btree ("skill_id","account_id");--> statement-breakpoint
CREATE INDEX "skill_installs_account_idx" ON "skill_installs" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tar_sha256_uq" ON "skills" USING btree ("tar_sha256");--> statement-breakpoint
CREATE INDEX "skills_slug_idx" ON "skills" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skills_level_idx" ON "skills" USING btree ("level");