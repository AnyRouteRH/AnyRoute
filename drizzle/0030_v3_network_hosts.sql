ALTER TABLE "providers" ADD COLUMN "network_host" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "network_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "network_models" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "providers_network_wallet_endpoint_uq" ON "providers" ("operator", "base_url") WHERE "network_host" = true;
