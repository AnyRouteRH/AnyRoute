-- B120: preference lives on the existing Telegram link; account marker survives unlink/relink.
ALTER TABLE kv ADD COLUMN weekly_summary_opted_in boolean;
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN last_sent_week text;
