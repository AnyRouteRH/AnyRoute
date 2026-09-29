CREATE TABLE "lane_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"hf_repo" text NOT NULL,
	"base_model" text NOT NULL,
	"revision" text,
	"license" text,
	"variant" text DEFAULT 'abliterated' NOT NULL,
	"creator_handle" text NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"reason" text,
	"model_id" text,
	"endpoint_provider" text,
	"source_created_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"servable_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"hf_repo" text NOT NULL,
	"handle" text NOT NULL,
	"address" text NOT NULL,
	"challenge" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"onchain_tx" text
);
--> statement-breakpoint
CREATE TABLE "lane_evals" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"refusal_rate" real,
	"capability_score" real,
	"canary_accuracy" real,
	"canary_quant_match" boolean,
	"passed" boolean NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "models_lane" (
	"model_id" text PRIMARY KEY NOT NULL,
	"variant" text DEFAULT 'mainstream' NOT NULL,
	"status" text DEFAULT 'servable' NOT NULL,
	"base_model" text,
	"license" text,
	"weights_source" text,
	"weights_revision" text,
	"weights_digest" text,
	"creator_handle" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "classifier_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lane_candidates_repo_uq" ON "lane_candidates" USING btree ("hf_repo");--> statement-breakpoint
CREATE INDEX "lane_candidates_status_idx" ON "lane_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lane_claims_model_idx" ON "lane_claims" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "lane_evals_candidate_idx" ON "lane_evals" USING btree ("candidate_id","ts");