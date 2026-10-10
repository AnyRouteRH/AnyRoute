-- E148: owner-supplied IP restrictions, never an observed caller address.
ALTER TABLE keys ADD COLUMN allowed_ips text[];
--> statement-breakpoint
ALTER TABLE keys ADD CONSTRAINT keys_allowed_ips_count CHECK (allowed_ips IS NULL OR cardinality(allowed_ips) BETWEEN 1 AND 32);
