import { sql } from "drizzle-orm";
import { pgTable, text, bigint, integer, numeric, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { keys } from "../db/schema.ts";
import { agentActionDecisions } from "./guard-schema.ts";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });
export type AgentPaymentStatus = "awaiting_transfer" | "seen" | "final" | "reversed";
// Pay another agent: one row per allowed pay.agent decision. The paying wallet sends USDG straight to the recipient;
// the router only records what it decided, the transfer it later found on chain and the receipt it signed.
export const agentPayments = pgTable("agent_payments", {
  decisionId: text("decision_id").primaryKey().references(() => agentActionDecisions.id),
  keyHash: text("key_hash").notNull().references(() => keys.keyHash),
  accountId: text("account_id").notNull(),
  policySha256: text("policy_sha256").notNull(),
  recipientProfile: text("recipient_profile"),
  recipientKeyHash: text("recipient_key_hash"),
  recipientWallet: text("recipient_wallet").notNull(),
  amountUnits: units("amount_units").notNull(),
  memoSha256: text("memo_sha256"),
  status: text("status").$type<AgentPaymentStatus>().notNull().default("awaiting_transfer"),
  statusAt: ts("status_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
  txHash: text("tx_hash"),
  logIndex: integer("log_index"),
  blockNumber: bigint("block_number", { mode: "bigint" }),
  blockHash: text("block_hash"),
  payerWallet: text("payer_wallet"),
  paidUnits: units("paid_units"),
  verifiedAt: ts("verified_at"),
  checkedAt: ts("checked_at"),
  reason: text("reason"),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  receiptSig: text("receipt_sig"),
  receiptKeyId: text("receipt_key_id"),
}, t => [
  uniqueIndex("agent_payments_transfer_uq").on(t.txHash, t.logIndex),
  index("agent_payments_account_status_idx").on(t.accountId, t.statusAt),
  index("agent_payments_recipient_status_idx").on(t.recipientKeyHash, t.statusAt),
  index("agent_payments_status_idx").on(t.status, t.blockNumber),
  check("agent_payments_status_check", sql`${t.status} in ('awaiting_transfer', 'seen', 'final', 'reversed')`),
  check("agent_payments_amount_check", sql`${t.amountUnits} > 0 and (${t.paidUnits} is null or ${t.paidUnits} >= ${t.amountUnits})`),
  check("agent_payments_transfer_check", sql`${t.status} = 'awaiting_transfer' or (${t.txHash} is not null and ${t.logIndex} is not null and ${t.blockNumber} is not null and ${t.blockHash} is not null and ${t.payerWallet} is not null and ${t.paidUnits} is not null and ${t.verifiedAt} is not null)`),
]);
