import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, jsonb, timestamp, bigserial, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { accounts, keys, teams } from "../db/schema.ts";
import type { AgentPolicy } from "./policy.ts";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const agentPolicies = pgTable("agent_policies", {
  keyHash: text("key_hash").primaryKey().references(() => keys.keyHash),
  version: integer("version").notNull(), spec: jsonb("spec").$type<AgentPolicy>().notNull(), sha256: text("sha256").notNull(),
  killed: boolean("killed").notNull().default(false), killedAt: ts("killed_at"), killedReason: text("killed_reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(), updatedBy: text("updated_by").notNull(),
  // U115: the playbook this key follows. While set, spec and sha256 are kept equal to the playbook's current rules.
  playbookId: text("playbook_id").references(() => playbooks.id),
}, t => [index("agent_policies_playbook_idx").on(t.playbookId).where(sql`${t.playbookId} is not null`)]);
export const agentPolicyEvents = pgTable("agent_policy_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(), keyHash: text("key_hash").notNull(), ts: ts("ts").notNull().defaultNow(),
  kind: text("kind").notNull(), decision: text("decision"), reasons: jsonb("reasons").notNull(), intent: jsonb("intent"),
  policySha256: text("policy_sha256").notNull(), prevHash: text("prev_hash").notNull(), hash: text("hash").notNull(),
}, t => [index("agent_policy_events_key_idx").on(t.keyHash, t.id), index("agent_policy_events_ts_idx").on(t.ts)]);
// U115: a playbook is one named rulebook that many keys follow. version counts rule changes (1 at creation).
export const playbooks = pgTable("playbooks", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull().references(() => accounts.id), teamId: text("team_id").references(() => teams.id),
  name: text("name").notNull(), spec: jsonb("spec").$type<AgentPolicy>().notNull(), sha256: text("sha256").notNull(), version: integer("version").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(), updatedAt: ts("updated_at").notNull().defaultNow(), updatedBy: text("updated_by").notNull(),
}, t => [uniqueIndex("playbooks_account_name_uq").on(t.accountId, sql`lower(${t.name})`), check("playbooks_version_check", sql`${t.version} >= 1`)]);
// Every playbook change: create, update (new rules, new version), rename and delete, with the rules' digest and the keys following it.
export const playbookChanges = pgTable("playbook_changes", {
  id: bigserial("id", { mode: "number" }).primaryKey(), playbookId: text("playbook_id").notNull(), accountId: text("account_id").notNull(), teamId: text("team_id"),
  name: text("name").notNull(), action: text("action").$type<"create" | "update" | "rename" | "delete">().notNull(), version: integer("version").notNull(),
  sha256: text("sha256").notNull(), spec: jsonb("spec").$type<AgentPolicy>().notNull(), followers: integer("followers").notNull(), actor: text("actor").notNull(),
  notify: boolean("notify").notNull().default(false), at: ts("at").notNull().defaultNow(),
}, t => [index("playbook_changes_playbook_idx").on(t.playbookId, t.id), index("playbook_changes_account_at_idx").on(t.accountId, t.at),
  check("playbook_changes_action_check", sql`${t.action} in ('create', 'update', 'rename', 'delete')`)]);
