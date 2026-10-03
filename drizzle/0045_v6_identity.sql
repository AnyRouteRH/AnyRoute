CREATE TABLE "agent_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_key_hash" text NOT NULL,
	"reviewer_account_id" text NOT NULL,
	"receipt_kind" text NOT NULL,
	"receipt_id" text NOT NULL,
	"score" integer NOT NULL,
	"tag1" text,
	"tag2" text,
	"paid_pico" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_feedback_score_range" CHECK ("agent_feedback"."score" >= 0 AND "agent_feedback"."score" <= 100),
	CONSTRAINT "agent_feedback_paid_positive" CHECK ("agent_feedback"."paid_pico" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_identities" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"identity_opt_out" boolean,
	"reputation_opt_in" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"mode" text,
	"registry" text,
	"agent_id" text,
	"owner_address" text,
	"tx_hash" text,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_liveness" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"endpoint_sha256" text NOT NULL,
	"live" boolean NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error" text,
	"probed_at" timestamp with time zone NOT NULL,
	"receipt" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_track_records" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"certificate" jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_subject_key_hash_keys_key_hash_fk" FOREIGN KEY ("subject_key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_liveness" ADD CONSTRAINT "agent_liveness_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_track_records" ADD CONSTRAINT "agent_track_records_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_feedback_receipt_uq" ON "agent_feedback" USING btree ("receipt_kind","receipt_id");--> statement-breakpoint
CREATE INDEX "agent_feedback_subject_idx" ON "agent_feedback" USING btree ("subject_key_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_id_uq" ON "agent_identities" USING btree ("id");--> statement-breakpoint
CREATE INDEX "agent_track_records_key_idx" ON "agent_track_records" USING btree ("key_hash","created_at");