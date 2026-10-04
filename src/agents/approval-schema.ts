import { pgTable, text, jsonb, numeric, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { keys } from "../db/schema.ts";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const agentApprovals = pgTable("agent_approvals", {
  id: text("id").primaryKey(), keyHash: text("key_hash").notNull().references(() => keys.keyHash),
  intent: jsonb("intent").notNull(), intentHash: text("intent_hash").notNull(),
  maxCostPico: numeric("max_cost_pico", { precision: 78, scale: 0, mode: "bigint" }).notNull(),
  status: text("status").$type<"pending" | "approved" | "denied" | "expired" | "used">().notNull().default("pending"),
  requestedAt: ts("requested_at").notNull().defaultNow(), decidedAt: ts("decided_at"), decidedBy: text("decided_by"),
  expiresAt: ts("expires_at").notNull(), usedAt: ts("used_at"),
}, t => [index("agent_approvals_key_status_idx").on(t.keyHash, t.status),
  check("agent_approvals_status_check", sql`${t.status} in ('pending', 'approved', 'denied', 'expired', 'used')`),
  check("agent_approvals_cost_check", sql`${t.maxCostPico} >= 0`)]);
