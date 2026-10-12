import { pgTable, text, timestamp, jsonb, primaryKey, boolean } from "drizzle-orm/pg-core";
import { accounts } from "../db/schema.ts";
import type { WatchState } from "./state.ts";
// G159: account row locks enforce the twenty-watch cap; watch row locks serialize worker claims.
export const modelWatches = pgTable("model_watches", {
  accountId: text("account_id").notNull().references(() => accounts.id),
  modelId: text("model_id").notNull(),
  watching: boolean("watching").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  state: jsonb("state").$type<WatchState>().notNull(),
}, t => [primaryKey({ columns: [t.accountId, t.modelId] })]);
