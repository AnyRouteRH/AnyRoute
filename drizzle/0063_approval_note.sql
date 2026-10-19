-- K186: optional owner-written explanation; no change to approval validity or authority.
ALTER TABLE agent_approvals ADD COLUMN decision_note text;
--> statement-breakpoint
ALTER TABLE agent_approvals ADD CONSTRAINT agent_approvals_note_check CHECK (decision_note IS NULL OR char_length(decision_note) <= 280);
