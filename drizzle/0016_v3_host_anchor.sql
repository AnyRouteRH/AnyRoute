CREATE TABLE "host_anchor_leaves" (
	"provider_id" text NOT NULL,
	"leaf" text NOT NULL,
	"anchor_id" integer NOT NULL,
	"leaf_index" integer NOT NULL,
	"receipt_id" text NOT NULL,
	"receipt_ts" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_anchor_leaves_provider_id_leaf_pk" PRIMARY KEY("provider_id","leaf")
);
--> statement-breakpoint
CREATE TABLE "host_anchors" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"attestation_ref" text NOT NULL,
	"receipt_key_id" text NOT NULL,
	"receipt_public_key" text NOT NULL,
	"root" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"chain_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "host_anchor_leaves_leaf_idx" ON "host_anchor_leaves" USING btree ("leaf");--> statement-breakpoint
CREATE UNIQUE INDEX "host_anchor_leaves_position_idx" ON "host_anchor_leaves" USING btree ("anchor_id","leaf_index");--> statement-breakpoint
CREATE INDEX "host_anchors_provider_idx" ON "host_anchors" USING btree ("provider_id","to_ts");--> statement-breakpoint
CREATE INDEX "host_anchors_status_idx" ON "host_anchors" USING btree ("status");