import { pgTable, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "../db/schema.ts";

// E154: one verified secondary wallet belongs to one account; unlink deletes this association.
export const accountLinkedWallets = pgTable("account_linked_wallets", {
  wallet: text("wallet").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [index("account_linked_wallets_account_idx").on(t.accountId), check("account_linked_wallets_wallet_check", sql`${t.wallet} ~ '^0x[0-9a-f]{40}$'`)]);
