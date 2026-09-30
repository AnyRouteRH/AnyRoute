import { pgTable, text, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const networkWaitlist = pgTable("network_waitlist", {
  id: text("id").primaryKey(),
  role: text("role").notNull(),
  hardware: text("hardware").notNull(),
  readiness: text("readiness").notNull(),
  region: text("region").notNull(),
  contact: text("contact"),
  paidIn: text("paid_in").notNull(),
  deleteCodeHash: text("delete_code_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("network_role", sql`${t.role} in ('host_gpu','host_cpu','relay','witness','developer')`),
  check("network_region", sql`${t.region} in ('africa','antarctica','asia','europe','north_america','oceania','south_america')`),
  check("network_paid_in", sql`${t.paidIn} in ('usdg','anyr','any')`),
  check("network_lengths", sql`char_length(${t.hardware}) <= 200 and char_length(${t.readiness}) <= 300 and char_length(${t.contact}) <= 120 and char_length(${t.deleteCodeHash}) = 64`),
]);

export const sanctionsAddresses = pgTable("sanctions_addresses", {
  address: text("address").primaryKey(),
  listDate: timestamp("list_date", { withTimezone: true, mode: "date" }).notNull(),
  sourceHash: text("source_hash").notNull(),
});
export const sanctionsMeta = pgTable("sanctions_meta", {
  id: integer("id").primaryKey(), // singleton, id = 1
  listDate: timestamp("list_date", { withTimezone: true, mode: "date" }).notNull(),
  sourceHash: text("source_hash").notNull(),
  entryCount: integer("entry_count").notNull(),
  ignoredCount: integer("ignored_count").notNull(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true, mode: "date" }).notNull(),
});

/** Immutable publication records. Canonical policy bytes are signed by the transparency log's Ed25519 key. */
export const hostPolicies = pgTable("host_policies", {
  version: integer("version").primaryKey(),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
  canonical: text("canonical").notNull(),
  sha256: text("sha256").notNull().unique(),
  signature: text("signature").notNull(),
  verifierKey: text("verifier_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
