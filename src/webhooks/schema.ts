import { pgTable, text, timestamp, jsonb, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { accounts, keys, spendAlerts } from "../db/schema.ts";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export type ScanState = { from: string; to?: string; cursor?: string };
export const webhookDestinations = pgTable("webhook_destinations", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull().references(() => accounts.id),
  createdBy: text("created_by").notNull().references(() => keys.keyHash), keyHash: text("key_hash"),
  ruleId: text("rule_id").references(() => spendAlerts.id, { onDelete: "cascade" }),
  urlEnc: text("url_enc").notNull(), secretEnc: text("secret_enc"), revoked: boolean("revoked").notNull().default(false),
  events: jsonb("events").$type<string[]>().notNull(), scan: jsonb("scan").$type<ScanState>().notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, t => [index("webhook_destinations_account_idx").on(t.accountId), uniqueIndex("webhook_destinations_rule_idx").on(t.ruleId)]);
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(), destinationId: text("destination_id").notNull().references(() => webhookDestinations.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(), event: text("event").notNull(), reference: text("reference").notNull(), eventAt: ts("event_at").notNull(),
  eventStatus: text("event_status"), attempts: integer("attempts").notNull().default(0),
  status: text("status").notNull().default("pending"), httpStatus: integer("http_status"), latencyMs: integer("latency_ms"),
  attemptedAt: ts("attempted_at"), nextAttempt: ts("next_attempt").notNull().defaultNow(),
  history: jsonb("history").$type<{ at: string; status: string; http_status: number | null; latency_ms: number; retry_count: number }[]>().notNull().default([]),
}, t => [uniqueIndex("webhook_deliveries_event_idx").on(t.destinationId, t.eventId), index("webhook_deliveries_due_idx").on(t.status, t.nextAttempt)]);
