import { pgTable, text, integer, bigint, jsonb, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
export const hostBondCursor = pgTable("host_bond_cursor", {
  scope: text("scope").primaryKey(), block: bigint("block", { mode: "bigint" }).notNull(), blockHash: text("block_hash"),
  checkpoints: jsonb("checkpoints").notNull(), checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});
export const hostBondEvents = pgTable("host_bond_events", {
  scope: text("scope").notNull(), txHash: text("tx_hash").notNull(), logIndex: integer("log_index").notNull(),
  block: bigint("block", { mode: "bigint" }).notNull(), blockHash: text("block_hash").notNull(), event: text("event").notNull(), args: jsonb("args").notNull(),
}, t => [primaryKey({ columns: [t.scope, t.txHash, t.logIndex] }), index("host_bond_events_order").on(t.scope, t.block, t.logIndex)]);
export const hostBondProjection = pgTable("host_bond_projection", {
  scope: text("scope").notNull(), kind: text("kind").notNull(), id: text("id").notNull(), data: jsonb("data").notNull(),
}, t => [primaryKey({ columns: [t.scope, t.kind, t.id] })]);
export const hostSlashEvidence = pgTable("host_slash_evidence", {
  scope: text("scope").notNull(), root: text("root").notNull(), providerId: text("provider_id").notNull(), hostId: text("host_id").notNull(),
  canonical: text("canonical").notNull(), reason: integer("reason").notNull(), amount: text("amount").notNull(),
  status: text("status").notNull().default("ready"), proposalTx: text("proposal_tx"), proposalRaw: text("proposal_raw"), executionTx: text("execution_tx"), executionRaw: text("execution_raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.scope, t.root] })]);
