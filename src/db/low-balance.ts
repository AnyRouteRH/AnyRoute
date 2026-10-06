// B119: durable inbox history; balance and threshold snapshots contain no request text.
import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
export const lowBalanceAlerts = pgTable("low_balance_alerts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  balance: bigint("balance_pico", { mode: "bigint" }).notNull(),
  threshold: bigint("threshold_pico", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [index("low_balance_alerts_account_at_idx").on(t.accountId, t.createdAt)]);
