ALTER TABLE "escrow_deposits" ADD COLUMN "block_hash" text;--> statement-breakpoint
ALTER TABLE "escrow_deposits" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "escrow_deposits" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "escrow_deposits" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "escrow_deposits" ADD COLUMN "reviewed_at" timestamp with time zone;