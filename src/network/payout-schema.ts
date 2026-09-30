import { pgTable, text, numeric, timestamp, primaryKey, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const amount = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
export const networkFeeLedger = pgTable("network_fee_ledger", {
  id: text("id").primaryKey(), providerId: text("provider_id").notNull(), period: text("period").notNull(),
  grossPico: amount("gross_pico").notNull(), feePico: amount("fee_pico").notNull(),
  status: text("status").notNull().default("accrued"), swapTx: text("swap_tx"), burnTx: text("burn_tx"), anyrAmount: amount("anyr_amount"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("network_fee_period_uq").on(t.providerId, t.period), check("network_fee_status", sql`${t.status} in ('accrued','swapped','burned')`), check("network_fee_amounts", sql`${t.grossPico} >= 0 and ${t.feePico} >= 0 and ${t.feePico} <= ${t.grossPico}`)]);
export const networkReceiptLinks = pgTable("network_receipt_links", {
  generationId: text("generation_id").primaryKey(), providerId: text("provider_id").notNull(), receiptId: text("receipt_id").notNull(), accruedPeriod: text("accrued_period"),
}, t => [uniqueIndex("network_receipt_once_uq").on(t.providerId, t.receiptId)]);
export const networkPayoutDispatch = pgTable("network_payout_dispatch", {
  payoutId: text("payout_id").primaryKey(), signedTxEnc: text("signed_tx_enc").notNull(), txHash: text("tx_hash").notNull(),
});
