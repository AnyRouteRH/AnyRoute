CREATE TABLE project_budgets (
  account_id text NOT NULL REFERENCES accounts(id), name text NOT NULL,
  budget_pico bigint NOT NULL CHECK (budget_pico >= 0), PRIMARY KEY (account_id, name)
);
--> statement-breakpoint
CREATE TABLE project_reservations (
  id text PRIMARY KEY REFERENCES holds(id), account_id text NOT NULL REFERENCES accounts(id), name text NOT NULL,
  charged_pico bigint NOT NULL DEFAULT 0 CHECK (charged_pico >= 0), charged_at timestamptz
);
--> statement-breakpoint
CREATE INDEX project_reservations_account_name_idx ON project_reservations(account_id, name);
--> statement-breakpoint
CREATE TABLE project_budget_notices (
  account_id text NOT NULL REFERENCES accounts(id), name text NOT NULL, month text NOT NULL,
  spent_pico bigint NOT NULL, budget_pico bigint NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  telegram_claimed boolean NOT NULL DEFAULT false, PRIMARY KEY (account_id, name, month)
);
