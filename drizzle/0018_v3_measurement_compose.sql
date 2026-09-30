ALTER TABLE "measurements" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "measurements" ADD COLUMN "superseded_by" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "measurements_provider_image_compose_uq" ON "measurements" USING btree ("provider_id","image_digest","compose_hash");--> statement-breakpoint
DROP INDEX "measurements_provider_image_uq";
