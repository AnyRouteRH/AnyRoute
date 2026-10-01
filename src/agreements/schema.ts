import { pgTable, text, integer, bigint, jsonb, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
export const agreementCursor = pgTable("agreement_cursor", {
  scope: text("scope").primaryKey(), block: bigint("block", { mode: "bigint" }).notNull(), blockHash: text("block_hash"),
  checkpoints: jsonb("checkpoints").notNull(), checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});
export const agreementEvents = pgTable("agreement_events", {
  scope: text("scope").notNull(), txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(), block: bigint("block", { mode: "bigint" }).notNull(),
  blockHash: text("block_hash").notNull(), event: text("event").notNull(), args: jsonb("args").notNull(),
}, t => [primaryKey({ columns: [t.scope, t.txHash, t.logIndex] }), index("agreement_events_order").on(t.scope, t.block, t.logIndex)]);
export const agreementProjection = pgTable("agreement_projection", {
  scope: text("scope").notNull(), kind: text("kind").notNull(), id: text("id").notNull(), data: jsonb("data").notNull(),
}, t => [primaryKey({ columns: [t.scope, t.kind, t.id] })]);
export const agreementEvidence = pgTable("agreement_evidence", {
  scope: text("scope").notNull(), agreementId: text("agreement_id").notNull(), dispute: text("dispute").notNull(), party: text("party").notNull(),
  sha256: text("sha256").notNull(), content: text("content").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.scope, t.agreementId, t.dispute, t.party, t.sha256] })]);
export const agreementJury = pgTable("agreement_jury", {
  scope: text("scope").notNull(), agreementId: text("agreement_id").notNull(), dispute: text("dispute").notNull(), root: text("root").notNull(),
  status: text("status").notNull(), statement: jsonb("statement").notNull(), keyId: text("key_id").notNull(), signature: text("signature").notNull(),
  postingTx: text("posting_tx"), postingRaw: text("posting_raw"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.scope, t.agreementId, t.dispute] })]);
