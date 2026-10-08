// D144: append-only rulebook revisions, including repeated saves of the same rules.
import { sql } from "drizzle-orm";
import { bigserial, check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { keys } from "../db/schema.ts";
import type { AgentPolicy } from "./policy.ts";

export const policyVersions = pgTable("policy_versions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  keyHash: text("key_hash").notNull().references(() => keys.keyHash),
  sha256: text("sha256").notNull(),
  spec: jsonb("spec").$type<AgentPolicy>().notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  savedBy: text("saved_by").notNull(),
  source: text("source").$type<"save" | "approve_and_allow" | "restore" | "playbook">().notNull(),
}, t => [index("policy_versions_key_idx").on(t.keyHash, t.id), check("policy_versions_source_check", sql`${t.source} in ('save', 'approve_and_allow', 'restore', 'playbook')`)]);
