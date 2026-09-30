import { pgTable, text, integer, boolean, jsonb, timestamp, bigserial, index } from "drizzle-orm/pg-core";
import { keys } from "../db/schema.ts";
import type { AgentPolicy } from "./policy.ts";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const agentPolicies = pgTable("agent_policies", {
  keyHash: text("key_hash").primaryKey().references(() => keys.keyHash),
  version: integer("version").notNull(), spec: jsonb("spec").$type<AgentPolicy>().notNull(), sha256: text("sha256").notNull(),
  killed: boolean("killed").notNull().default(false), killedAt: ts("killed_at"), killedReason: text("killed_reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(), updatedBy: text("updated_by").notNull(),
});
export const agentPolicyEvents = pgTable("agent_policy_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(), keyHash: text("key_hash").notNull(), ts: ts("ts").notNull().defaultNow(),
  kind: text("kind").notNull(), decision: text("decision"), reasons: jsonb("reasons").notNull(), intent: jsonb("intent"),
  policySha256: text("policy_sha256").notNull(), prevHash: text("prev_hash").notNull(), hash: text("hash").notNull(),
}, t => [index("agent_policy_events_key_idx").on(t.keyHash, t.id), index("agent_policy_events_ts_idx").on(t.ts)]);
