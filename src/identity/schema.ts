import { sql } from "drizzle-orm";
import { pgTable, text, boolean, integer, bigint, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { keys } from "../db/schema.ts";
import type { SignedDocument } from "./signed.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// One row per agent key that touched identity or reputation settings. The ERC-8004 identity itself lives on chain;
// this keeps the owner's choices and the registration's progress.
export const agentIdentities = pgTable("agent_identities", {
  keyHash: text("key_hash").primaryKey().references(() => keys.keyHash, { onDelete: "cascade" }),
  id: text("id").notNull(), // random public id in the registration file URL; independent of the key hash and the profile slug
  identityOptOut: boolean("identity_opt_out"), // null: default (opted out only when the key's rulebook allows only the unlinkable lane)
  reputationOptIn: boolean("reputation_opt_in").notNull().default(false),
  status: text("status").notNull().default("none"), // none | awaiting_owner | queued | submitted | registered | failed
  mode: text("mode"), // owner | registrar
  registry: text("registry"), // eip155:<chain id>:<identity registry>
  agentId: text("agent_id"), // the ERC-8004 agent id (decimal uint256)
  ownerAddress: text("owner_address"), // lowercase holder of the identity token
  txHash: text("tx_hash"),
  error: text("error"), // fixed code of the last failure
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("agent_identities_id_uq").on(t.id)]);

// Paid feedback: one entry per receipt. The reviewer was the payer on that receipt and the subject its payee or the
// agent it served (src/identity/receipt-sources.ts). The reviewer's account is never published.
export const agentFeedback = pgTable("agent_feedback", {
  id: text("id").primaryKey(), // fb_<24 hex>
  subjectKeyHash: text("subject_key_hash").notNull().references(() => keys.keyHash, { onDelete: "cascade" }),
  reviewerAccountId: text("reviewer_account_id").notNull(),
  receiptKind: text("receipt_kind").notNull(),
  receiptId: text("receipt_id").notNull(),
  score: integer("score").notNull(),
  tag1: text("tag1"),
  tag2: text("tag2"),
  paidPico: bigint("paid_pico", { mode: "bigint" }).notNull(),
  paidAt: ts("paid_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
}, t => [
  uniqueIndex("agent_feedback_receipt_uq").on(t.receiptKind, t.receiptId),
  index("agent_feedback_subject_idx").on(t.subjectKeyHash, t.createdAt),
  check("agent_feedback_score_range", sql`${t.score} >= 0 AND ${t.score} <= 100`),
  check("agent_feedback_paid_positive", sql`${t.paidPico} > 0`),
]);

// The latest signed liveness probe of a listed agent's endpoint (job agent-liveness, daily by default).
export const agentLiveness = pgTable("agent_liveness", {
  keyHash: text("key_hash").primaryKey().references(() => keys.keyHash, { onDelete: "cascade" }),
  endpointSha256: text("endpoint_sha256").notNull(),
  live: boolean("live").notNull(),
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms"),
  error: text("error"), // fixed code: timeout | network | blocked | http
  probedAt: ts("probed_at").notNull(),
  receipt: jsonb("receipt").$type<SignedDocument>().notNull(),
});

// Portable track-record certificates: router-signed stats with a Merkle root over the key's anchored receipts.
export const agentTrackRecords = pgTable("agent_track_records", {
  id: text("id").primaryKey(), // tr_<24 hex>
  keyHash: text("key_hash").notNull().references(() => keys.keyHash, { onDelete: "cascade" }),
  certificate: jsonb("certificate").$type<SignedDocument>().notNull(),
  published: boolean("published").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
}, t => [index("agent_track_records_key_idx").on(t.keyHash, t.createdAt)]);
