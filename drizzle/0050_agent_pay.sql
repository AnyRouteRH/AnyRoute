CREATE TABLE agent_payments (
  decision_id text PRIMARY KEY REFERENCES agent_action_decisions(id), key_hash text NOT NULL REFERENCES keys(key_hash),
  account_id text NOT NULL, policy_sha256 text NOT NULL,
  recipient_profile text, recipient_key_hash text, recipient_wallet text NOT NULL,
  amount_units numeric(78,0) NOT NULL, memo_sha256 text,
  status text NOT NULL DEFAULT 'awaiting_transfer', status_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  tx_hash text, log_index integer, block_number bigint, block_hash text, payer_wallet text, paid_units numeric(78,0),
  verified_at timestamptz, checked_at timestamptz, reason text,
  receipt jsonb, receipt_sig text, receipt_key_id text,
  CONSTRAINT agent_payments_status_check CHECK (status IN ('awaiting_transfer','seen','final','reversed')),
  CONSTRAINT agent_payments_amount_check CHECK (amount_units > 0 AND (paid_units IS NULL OR paid_units >= amount_units)),
  CONSTRAINT agent_payments_transfer_check CHECK (status = 'awaiting_transfer' OR (tx_hash IS NOT NULL AND log_index IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL AND payer_wallet IS NOT NULL AND paid_units IS NOT NULL AND verified_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_payments_transfer_uq ON agent_payments(tx_hash, log_index);
--> statement-breakpoint
CREATE INDEX agent_payments_account_status_idx ON agent_payments(account_id, status_at);
--> statement-breakpoint
CREATE INDEX agent_payments_recipient_status_idx ON agent_payments(recipient_key_hash, status_at);
--> statement-breakpoint
CREATE INDEX agent_payments_status_idx ON agent_payments(status, block_number);
