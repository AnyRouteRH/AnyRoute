import { pgTable, text, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { keys } from "../db/schema.ts";
import type { RecordCertificate } from "./record-certificate-shared.ts";
export type PublicProfile = { name: string; description: string; homepage?: string; endpoint?: string; payout_wallet?: string; capabilities: string[]; show: ("spending_caps" | "ask_first" | "kill_switch")[] };
export const agentProfiles = pgTable("agent_profiles", {
  slug: text("slug").primaryKey(),
  keyHash: text("key_hash").notNull().references(() => keys.keyHash, { onDelete: "cascade" }),
  settings: jsonb("settings").$type<PublicProfile>().notNull(),
  certificates: jsonb("certificates").$type<RecordCertificate[]>().notNull(),
}, t => [uniqueIndex("agent_profiles_key_uq").on(t.keyHash)]);
