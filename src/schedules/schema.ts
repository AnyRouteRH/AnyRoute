import { pgTable, text, timestamp, integer, boolean, bigint, index, uniqueIndex } from "drizzle-orm/pg-core";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), ownerHash: text("owner_hash").notNull(),
  keyHash: text("key_hash").notNull(), name: text("name").notNull(), promptEnc: text("prompt_enc").notNull(),
  model: text("model").notNull(), cadence: text("cadence").notNull(), timeUtc: text("time_utc"),
  maxCostPico: bigint("max_cost_pico", { mode: "bigint" }).notNull(), paused: boolean("paused").notNull().default(false),
  failures: integer("failures").notNull().default(0), nextAt: ts("next_at").notNull(), createdAt: ts("created_at").notNull().defaultNow(),
}, t => [index("schedules_due_idx").on(t.paused, t.nextAt), index("schedules_account_idx").on(t.accountId)]);
export const scheduleRuns = pgTable("schedule_runs", {
  id: text("id").primaryKey(), scheduleId: text("schedule_id").notNull().references(() => schedules.id, { onDelete: "cascade" }),
  dueAt: ts("due_at").notNull(), startedAt: ts("started_at").notNull().defaultNow(), finishedAt: ts("finished_at"),
  status: text("status").notNull().default("running"), replyEnc: text("reply_enc"), reason: text("reason"),
  generationId: text("generation_id"), notified: boolean("notified").notNull().default(false),
}, t => [uniqueIndex("schedule_runs_slot_uq").on(t.scheduleId, t.dueAt)]);
export type Schedule = typeof schedules.$inferSelect;
