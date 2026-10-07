-- C134: owner-chosen project labels, separate from signed receipts.
ALTER TABLE keys ADD COLUMN project text;
--> statement-breakpoint
ALTER TABLE generations ADD COLUMN project text;
--> statement-breakpoint
CREATE INDEX gen_account_project_ts_idx ON generations (account_id, project, ts);
