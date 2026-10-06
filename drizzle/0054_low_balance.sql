ALTER TABLE accounts ADD COLUMN low_balance_pico bigint CHECK (low_balance_pico >= 0);
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN low_balance_alerted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE low_balance_alerts (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  balance_pico bigint NOT NULL,
  threshold_pico bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX low_balance_alerts_account_at_idx ON low_balance_alerts(account_id, created_at);
