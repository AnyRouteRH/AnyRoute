-- Auto top-up: a key's rule {below_usd, add_usd, max_per_week_usd}, or null, and one record per top-up or skipped top-up.
ALTER TABLE keys ADD COLUMN topup jsonb;
--> statement-breakpoint
CREATE TABLE key_topups (
  id text PRIMARY KEY, ref text NOT NULL, key_hash text NOT NULL REFERENCES keys(key_hash), account_id text NOT NULL,
  outcome text NOT NULL, amount_pico bigint NOT NULL, limit_before_pico bigint NOT NULL, limit_after_pico bigint NOT NULL,
  spent_pico bigint NOT NULL, available_pico bigint NOT NULL, week_start timestamptz NOT NULL, week_total_pico bigint NOT NULL,
  max_per_week_pico bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT key_topups_outcome_check CHECK (outcome IN ('added','skipped_balance','skipped_weekly','skipped_org_budget')),
  CONSTRAINT key_topups_amount_check CHECK (amount_pico > 0 AND max_per_week_pico > 0 AND week_total_pico >= 0),
  CONSTRAINT key_topups_limit_check CHECK ((outcome = 'added' AND limit_after_pico = limit_before_pico + amount_pico AND week_total_pico <= max_per_week_pico) OR (outcome <> 'added' AND limit_after_pico = limit_before_pico))
);
--> statement-breakpoint
CREATE UNIQUE INDEX key_topups_ref_uq ON key_topups(ref);
--> statement-breakpoint
CREATE INDEX key_topups_key_created_idx ON key_topups(key_hash, created_at);
