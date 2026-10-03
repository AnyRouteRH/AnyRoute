import { sql } from "drizzle-orm";
import { pgTable, text, bigint, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { accounts } from "../db/schema.ts";

// V6 R: make-good refunds (src/services/makegood.ts). Money is pico-USD unless a column is named *_usdg (USDG base units).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const makegoodPayouts = pgTable("makegood_payouts", {
  id: text("id").primaryKey(),
  payer: text("payer").notNull(),
  usdg: bigint("usdg", { mode: "bigint" }).notNull(),
  status: text("status").notNull().default("signed"), // signed | paid | failed
  txHash: text("tx_hash").notNull(),
  signedTxEnc: text("signed_tx_enc").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  settledAt: ts("settled_at"),
}, (t) => [uniqueIndex("makegood_payouts_tx_uq").on(t.txHash), index("makegood_payouts_status_idx").on(t.status, t.createdAt)]);

export const makegoodRefunds = pgTable("makegood_refunds", {
  id: text("id").primaryKey(), // also the id of the signed refund receipt
  sourceId: text("source_id").notNull(), // the generation id, or payment:<tx> for a paid call no provider served
  generationId: text("generation_id"),
  accountId: text("account_id").notNull().references(() => accounts.id),
  keyHash: text("key_hash"),
  rule: text("rule").notNull(),
  status: text("status").notNull().default("pending"), // pending | issued | void
  amount: bigint("amount", { mode: "bigint" }).notNull().default(sql`0`),
  charged: bigint("charged", { mode: "bigint" }).notNull().default(sql`0`),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  providerId: text("provider_id"),
  strike: boolean("strike").notNull().default(false),
  payer: text("payer"),
  onchainUsdg: bigint("onchain_usdg", { mode: "bigint" }),
  payoutStatus: text("payout_status").notNull().default("none"), // none | owed | batched | paid
  payoutId: text("payout_id").references(() => makegoodPayouts.id),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  receiptSig: text("receipt_sig"),
  receiptKeyId: text("receipt_key_id"),
  receiptLeaf: text("receipt_leaf"),
  detectedAt: ts("detected_at").notNull().defaultNow(),
  issuedAt: ts("issued_at"),
}, (t) => [
  uniqueIndex("makegood_refunds_source_uq").on(t.sourceId),
  index("makegood_refunds_status_idx").on(t.status, t.detectedAt),
  index("makegood_refunds_account_idx").on(t.accountId, t.detectedAt),
  index("makegood_refunds_payout_idx").on(t.payoutStatus, t.payer),
]);
