DROP INDEX "quotes_tx_uq";--> statement-breakpoint
CREATE INDEX "quotes_tx_idx" ON "quotes" USING btree ("tx_hash");