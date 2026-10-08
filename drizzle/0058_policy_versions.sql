CREATE TABLE policy_versions (
  id bigserial PRIMARY KEY,
  key_hash text NOT NULL REFERENCES keys(key_hash),
  sha256 text NOT NULL,
  spec jsonb NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  saved_by text NOT NULL,
  source text NOT NULL CHECK (source IN ('save', 'approve_and_allow', 'restore', 'playbook'))
);
--> statement-breakpoint
CREATE INDEX policy_versions_key_idx ON policy_versions (key_hash, id);
--> statement-breakpoint
-- The earliest available revision is the current copy, not a reconstruction of lost rules.
INSERT INTO policy_versions (key_hash, sha256, spec, saved_at, saved_by, source)
SELECT key_hash, sha256, spec, updated_at, updated_by,
  CASE WHEN playbook_id IS NULL THEN 'save' ELSE 'playbook' END
FROM agent_policies;
