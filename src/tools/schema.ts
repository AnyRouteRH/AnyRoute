import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, jsonb, integer, boolean, bigint, bigserial, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { accounts, skills } from "../db/schema.ts";

// v6 T tables (drizzle/0043_v6_tools.sql). Amounts: *_units are USDG base units (1e-6), price and take are pico-USD.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A known-answer probe: the request a canary sends and what a correct answer must contain. */
export type CanarySpec = { method: "GET" | "POST"; query?: string; body?: unknown; expect: { contains?: string; sha256?: string } };

export const toolListings = pgTable("tool_listings", {
  id: text("id").primaryKey(), // tl_ + random hex
  accountId: text("account_id").notNull().references(() => accounts.id),
  createdBy: text("created_by").notNull(), // key hash that listed it
  skillId: text("skill_id").references(() => skills.id), // set when the listing is a Skills Hub skill's paid invocation
  name: text("name").notNull(),
  summary: text("summary").notNull(),
  resource: text("resource").notNull(), // https origin + path, no query
  method: text("method").notNull(), // GET | POST
  priceUnits: bigint("price_units", { mode: "bigint" }).notNull(), // the 402 quote seen when listed
  payTo: text("pay_to").notNull(),
  network: text("network").notNull(),
  canary: jsonb("canary").$type<CanarySpec>().notNull(),
  status: text("status").notNull().default("listed"), // listed | delisted | removed
  failures: integer("failures").notNull().default(0), // consecutive failed canary probes
  delistedAt: ts("delisted_at"),
  checkedAt: ts("checked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("tool_listings_resource_uq").on(t.resource), index("tool_listings_status_idx").on(t.status), index("tool_listings_skill_idx").on(t.skillId),
  check("tool_listings_status_valid", sql`${t.status} in ('listed','delisted','removed')`), check("tool_listings_method_valid", sql`${t.method} in ('GET','POST')`), check("tool_listings_price_positive", sql`${t.priceUnits} > 0`)]);

export const toolCalls = pgTable("tool_calls", {
  id: text("id").primaryKey(), // tc_ + random hex; also the hold id
  keyHash: text("key_hash").notNull(),
  accountId: text("account_id").notNull(),
  sellerId: text("seller_id"), // tool listing id when the resource is listed
  payTo: text("pay_to").notNull(),
  resource: text("resource").notNull(), // https origin + path, no query
  method: text("method").notNull(),
  network: text("network").notNull(),
  x402Version: integer("x402_version").notNull(),
  priceUnits: bigint("price_units", { mode: "bigint" }).notNull(),
  price: bigint("price", { mode: "bigint" }).notNull(),
  take: bigint("take", { mode: "bigint" }).notNull(),
  holdId: text("hold_id").notNull(),
  payer: text("payer").notNull(), // the router's buyer wallet that signed
  nonce: text("nonce").notNull(), // EIP-3009 nonce of the signed authorization
  validBefore: ts("valid_before").notNull(),
  settleTx: text("settle_tx"), // from the seller's PAYMENT-RESPONSE
  responseSha256: text("response_sha256"),
  sellerStatus: integer("seller_status"), // the tool's HTTP status code
  status: text("status").notNull(), // paying | ok | failed | released | charged_after_failure
  failure: text("failure"), // fixed code
  receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  createdAt: ts("created_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
}, (t) => [index("tool_calls_key_idx").on(t.keyHash, t.createdAt), index("tool_calls_status_idx").on(t.status, t.validBefore), index("tool_calls_created_idx").on(t.createdAt),
  check("tool_calls_status_valid", sql`${t.status} in ('paying','ok','failed','released','charged_after_failure')`), check("tool_calls_amounts_valid", sql`${t.priceUnits} > 0 and ${t.price} >= 0 and ${t.take} >= 0`)]);

export const toolCanaryRuns = pgTable("tool_canary_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sellerId: text("seller_id").notNull().references(() => toolListings.id, { onDelete: "cascade" }),
  ok: boolean("ok").notNull(),
  latencyMs: integer("latency_ms"),
  failure: text("failure"),
  priceUnits: bigint("price_units", { mode: "bigint" }),
  settleTx: text("settle_tx"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("tool_canary_runs_seller_idx").on(t.sellerId, t.at)]);
