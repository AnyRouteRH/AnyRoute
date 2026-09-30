import { pgTable, text, bigserial, bigint, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agentPolicyEvents } from "./schema.ts";
export const agentLedgerLinks = pgTable("agent_ledger_links", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  requestId: text("request_id").notNull(), keyHash: text("key_hash").notNull(),
  ts: timestamp("ts", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  eventId: bigint("event_id", { mode: "number" }).references(() => agentPolicyEvents.id, { onDelete: "cascade" }),
  generationId: text("generation_id"), approvalId: text("approval_id"),
}, t => [index("agent_ledger_links_key_request_idx").on(t.keyHash, t.requestId), index("agent_ledger_links_ts_idx").on(t.ts), uniqueIndex("agent_ledger_links_event_uq").on(t.eventId), uniqueIndex("agent_ledger_links_generation_uq").on(t.generationId)]);
