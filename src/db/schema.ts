import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  timestamp,
  real,
  primaryKey,
  index,
  uniqueIndex,
  serial,
} from "drizzle-orm/pg-core";

// Money columns are pico-USD (1e-12 USD) bigints unless named *_usdg (USDG base units, 1e-6)
// or *_raw (token base units). Privacy invariant: no table stores prompts or completions.

const money = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("key"), // key | wallet
    wallet: text("wallet"),
    balance: money("balance").notNull().default(sql`0`), // settled ledger sum (denormalized, trigger-checked)
    held: money("held").notNull().default(sql`0`), // open holds
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accounts_wallet_uq").on(t.wallet)],
);

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerAccount: text("owner_account").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: text("team_id").notNull(),
    keyHash: text("key_hash").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | member | viewer
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.keyHash] })],
);

export const keys = pgTable(
  "keys",
  {
    keyHash: text("key_hash").primaryKey(), // sha256(secret)
    chainKeyHash: text("chain_key_hash").notNull(), // keccak256(derived key address)
    keyAddress: text("key_address").notNull(),
    accountId: text("account_id").notNull(),
    parentHash: text("parent_hash"),
    name: text("name").notNull().default(""),
    label: text("label").notNull(), // sk-ar-v1-abcd...wxyz
    budget: money("budget"), // null = unlimited (pico)
    budgetReset: text("budget_reset"), // null | daily | weekly | monthly
    periodStart: ts("period_start"),
    spent: money("spent").notNull().default(sql`0`), // spend in current budget period
    spentTotal: money("spent_total").notNull().default(sql`0`),
    rpm: integer("rpm"),
    tpm: integer("tpm"),
    teamId: text("team_id"),
    allowedModels: text("allowed_models").array(),
    payWithDefault: text("pay_with_default"),
    management: boolean("management").notNull().default(false),
    routing: jsonb("routing"), // imported presets (LiteLLM aliases, default provider prefs)
    guardrails: jsonb("guardrails"),
    disabled: boolean("disabled").notNull().default(false),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsed: ts("last_used"),
  },
  (t) => [uniqueIndex("keys_chain_uq").on(t.chainKeyHash), index("keys_account_idx").on(t.accountId)],
);
