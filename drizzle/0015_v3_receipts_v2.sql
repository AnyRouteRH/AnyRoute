ALTER TABLE "generations" ADD COLUMN "receipt_v2" jsonb;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "receipt_cose" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "receipt_leaf_v2" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN "leaf_index_v2" integer;