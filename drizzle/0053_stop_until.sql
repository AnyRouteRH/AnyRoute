-- B117: optional owner-selected stop deadline; no timer worker.
ALTER TABLE agent_policies ADD COLUMN kill_until timestamp with time zone;
