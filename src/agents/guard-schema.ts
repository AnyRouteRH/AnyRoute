import { sql } from "drizzle-orm";
import { pgTable, text, bigint, numeric, timestamp, index, check } from "drizzle-orm/pg-core";
import { keys } from "../db/schema.ts";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const amount = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
export const agentActionDecisions = pgTable("agent_action_decisions", {
  id: text("id").primaryKey(), keyHash: text("key_hash").notNull().references(() => keys.keyHash),
  eventId: bigint("event_id", { mode: "number" }).notNull(), action: text("action").notNull(), target: text("target"),
  amountPico: amount("amount_pico").notNull(), detailsSha256: text("details_sha256"),
  decision: text("decision").$type<"allow" | "deny" | "approval_required">().notNull(), createdAt: ts("created_at").notNull().defaultNow(),
  outcomeStatus: text("outcome_status").$type<"executed" | "skipped" | "failed">(), outcomeAmountPico: amount("outcome_amount_pico"), outcomeAt: ts("outcome_at"),
}, t => [index("agent_action_decisions_key_created_idx").on(t.keyHash, t.createdAt),
  check("agent_action_decisions_amount_check", sql`${t.amountPico} >= 0 and (${t.outcomeAmountPico} is null or ${t.outcomeAmountPico} >= 0)`),
  check("agent_action_decisions_decision_check", sql`${t.decision} in ('allow', 'deny', 'approval_required')`),
  check("agent_action_decisions_outcome_check", sql`${t.outcomeStatus} is null or (${t.decision} = 'allow' and ${t.outcomeStatus} in ('executed', 'skipped', 'failed') and ${t.outcomeAt} is not null and (${t.outcomeStatus} <> 'executed' or ${t.outcomeAmountPico} is not null))`)]);
