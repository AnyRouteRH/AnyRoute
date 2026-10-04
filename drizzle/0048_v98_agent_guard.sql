CREATE TABLE agent_action_decisions (
  id text PRIMARY KEY, key_hash text NOT NULL REFERENCES keys(key_hash), event_id bigint NOT NULL,
  action text NOT NULL, target text, amount_pico numeric(78,0) NOT NULL, details_sha256 text,
  decision text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  outcome_status text, outcome_amount_pico numeric(78,0), outcome_at timestamptz,
  CONSTRAINT agent_action_decisions_amount_check CHECK (amount_pico >= 0 AND (outcome_amount_pico IS NULL OR outcome_amount_pico >= 0)),
  CONSTRAINT agent_action_decisions_decision_check CHECK (decision IN ('allow','deny','approval_required')),
  CONSTRAINT agent_action_decisions_outcome_check CHECK (outcome_status IS NULL OR (decision = 'allow' AND outcome_status IN ('executed','skipped','failed') AND outcome_at IS NOT NULL AND (outcome_status <> 'executed' OR outcome_amount_pico IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX agent_action_decisions_key_created_idx ON agent_action_decisions(key_hash, created_at);
--> statement-breakpoint
-- Preserve all existing ceilings and support the guard's full decimal amount range.
ALTER TABLE agent_approvals ALTER COLUMN max_cost_pico TYPE numeric(78,0);
