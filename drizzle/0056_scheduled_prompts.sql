CREATE TABLE schedules (
  id text PRIMARY KEY, account_id text NOT NULL, owner_hash text NOT NULL, key_hash text NOT NULL,
  name text NOT NULL, prompt_enc text NOT NULL, model text NOT NULL, cadence text NOT NULL,
  time_utc text, max_cost_pico bigint NOT NULL CHECK (max_cost_pico > 0), paused boolean NOT NULL DEFAULT false,
  failures integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX schedules_due_idx ON schedules(paused, next_at);
--> statement-breakpoint
CREATE INDEX schedules_account_idx ON schedules(account_id);
--> statement-breakpoint
CREATE TABLE schedule_runs (
  id text PRIMARY KEY, schedule_id text NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'running', reply_enc text, reason text, generation_id text,
  notified boolean NOT NULL DEFAULT false, CONSTRAINT schedule_runs_slot_uq UNIQUE(schedule_id, due_at)
);
