CREATE TABLE model_watches (
  account_id text NOT NULL REFERENCES accounts(id),
  model_id text NOT NULL,
  watching boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  state jsonb NOT NULL,
  PRIMARY KEY (account_id, model_id)
);
