-- E149: a key may be created read-only (scope 'read'): listed account GET routes only, no spending or changes.
ALTER TABLE "keys" DROP CONSTRAINT "keys_scope_valid";
--> statement-breakpoint
ALTER TABLE "keys" ADD CONSTRAINT "keys_scope_valid" CHECK ("scope" IS NULL OR "scope" IN ('inference', 'read'));
--> statement-breakpoint
ALTER TABLE "keys" ADD CONSTRAINT "keys_scope_read_management" CHECK ("scope" IS DISTINCT FROM 'read' OR ("management" = false AND "team_id" IS NULL));
