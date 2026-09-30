CREATE TABLE "agent_ledger_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" bigint,
	"generation_id" text,
	"approval_id" text
);
--> statement-breakpoint
ALTER TABLE "agent_ledger_links" ADD CONSTRAINT "agent_ledger_links_event_id_agent_policy_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."agent_policy_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_ledger_links_key_request_idx" ON "agent_ledger_links" USING btree ("key_hash","request_id");--> statement-breakpoint
CREATE INDEX "agent_ledger_links_ts_idx" ON "agent_ledger_links" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ledger_links_event_uq" ON "agent_ledger_links" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ledger_links_generation_uq" ON "agent_ledger_links" USING btree ("generation_id");