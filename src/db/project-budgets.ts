// D139: project accounting follows the existing ledger holds, not response completion.
import { bigint, boolean, check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const money = (name: string) => bigint(name, { mode: "bigint" });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const projectBudgets = pgTable("project_budgets", {
  accountId: text("account_id").notNull(), name: text("name").notNull(), budget: money("budget_pico").notNull(),
}, t => [primaryKey({ columns: [t.accountId, t.name] }), check("project_budget_nonnegative", sql`${t.budget} >= 0`)]);
export const projectReservations = pgTable("project_reservations", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), name: text("name").notNull(),
  charged: money("charged_pico").notNull().default(0n), chargedAt: time("charged_at"),
}, t => [index("project_reservations_account_name_idx").on(t.accountId, t.name)]);
export const projectBudgetNotices = pgTable("project_budget_notices", {
  accountId: text("account_id").notNull(), name: text("name").notNull(), month: text("month").notNull(),
  spent: money("spent_pico").notNull(), budget: money("budget_pico").notNull(),
  at: time("at").notNull().defaultNow(), telegramClaimed: boolean("telegram_claimed").notNull().default(false),
}, t => [primaryKey({ columns: [t.accountId, t.name, t.month] })]);
