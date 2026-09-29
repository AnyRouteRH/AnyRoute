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
  numeric,
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

export const byokKeys = pgTable(
  "byok_keys",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    keyEnc: text("key_enc").notNull(),
    label: text("label").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("byok_account_provider_uq").on(t.accountId, t.providerId)],
);

export const ledger = pgTable(
  "ledger",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    keyHash: text("key_hash"),
    amount: money("amount").notNull(),
    kind: text("kind").notNull(), // deposit | credit | usage | refund | paywith | change | adjustment | withdrawal_lock | withdrawal
    ref: text("ref").notNull(),
    generationId: text("generation_id"),
    description: text("description").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ledger_ref_uq").on(t.ref), index("ledger_account_idx").on(t.accountId, t.createdAt)],
);

export const holds = pgTable(
  "holds",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    keyHash: text("key_hash"),
    amount: money("amount").notNull(),
    status: text("status").notNull().default("held"), // held | settled | released
    kind: text("kind").notNull().default("usage"),
    result: jsonb("result"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("holds_account_status_idx").on(t.accountId, t.status), index("holds_expiry_idx").on(t.status, t.expiresAt)],
);

export const providers = pgTable("providers", {
  id: text("id").primaryKey(), // slug, e.g. "deepinfra"
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc"),
  kind: text("kind").notNull().default("openai"), // openai | tee
  headers: jsonb("headers"),
  dataPolicy: jsonb("data_policy").notNull().default({}), // { training, retains_prompts, retention_days, zdr, moderated }
  datacenter: text("datacenter").array(),
  attested: boolean("attested").notNull().default(false),
  attestationUrl: text("attestation_url"),
  attestationHash: text("attestation_hash"),
  attestedAt: ts("attested_at"),
  teeKind: text("tee_kind"), // tdx | snp | nvidia-cc | tinfoil | dev
  bondUsdg: bigint("bond_usdg", { mode: "bigint" }).notNull().default(sql`0`),
  anyrStake: bigint("anyr_stake", { mode: "bigint" }).notNull().default(sql`0`),
  operator: text("operator"),
  payoutMode: text("payout_mode").notNull().default("invoice"), // invoice | usdg
  payoutAddress: text("payout_address"),
  status: text("status").notNull().default("applied"), // applied | shadow | live | suspended | delisted
  shadowUntil: ts("shadow_until"),
  timeoutMs: integer("timeout_ms"),
  staticModels: jsonb("static_models"), // provider-spec model list for APIs whose /models lacks pricing
  contact: text("contact"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const models = pgTable("models", {
  id: text("id").primaryKey(), // author/slug
  author: text("author").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ctx: integer("ctx").notNull().default(8192),
  maxOut: integer("max_out"),
  arch: jsonb("arch").notNull().default({}), // { modality, input_modalities, output_modalities, tokenizer, instruct_type }
  hfRepo: text("hf_repo"),
  creator: text("creator"),
  royaltyBps: integer("royalty_bps").notNull().default(0),
  createdUnix: integer("created_unix").notNull(),
  hidden: boolean("hidden").notNull().default(false),
});

export const offers = pgTable(
  "offers",
  {
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerModelId: text("provider_model_id").notNull(),
    pricePrompt: money("price_prompt").notNull(), // pico per token
    priceCompletion: money("price_completion").notNull(),
    priceRequest: money("price_request").notNull().default(sql`0`),
    priceImage: money("price_image").notNull().default(sql`0`),
    priceWebSearch: money("price_web_search").notNull().default(sql`0`),
    priceReasoning: money("price_reasoning").notNull().default(sql`0`),
    priceCacheRead: money("price_cache_read"),
    priceCacheWrite: money("price_cache_write"),
    quant: text("quant").notNull().default("unknown"),
    ctx: integer("ctx"),
    maxOut: integer("max_out"),
    supportedParameters: text("supported_parameters").array().notNull().default([]),
    features: jsonb("features").notNull().default({}),
    isModerated: boolean("is_moderated").notNull().default(false),
    status: text("status").notNull().default("live"), // live | shadow | disabled
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.providerId] }), index("offers_provider_idx").on(t.providerId)],
);

export const health = pgTable(
  "health",
  {
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    ts: ts("ts").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms"),
    tps: real("tps"),
    empty200: boolean("empty200").notNull().default(false),
    statusCode: integer("status_code"),
    errorKind: text("error_kind"),
    source: text("source").notNull().default("traffic"), // traffic | probe
    caller: text("caller"), // truncated hash of the calling account (never the account itself)
  },
  (t) => [index("health_mp_ts_idx").on(t.modelId, t.providerId, t.ts)],
);

export const canaries = pgTable(
  "canaries",
  {
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    ts: ts("ts").notNull().defaultNow(),
    quantMatch: boolean("quant_match"),
    quantGuess: text("quant_guess"),
    distance: real("distance"),
    quality: real("quality"),
    detail: jsonb("detail"),
  },
  (t) => [index("canaries_mp_ts_idx").on(t.modelId, t.providerId, t.ts)],
);

export const canaryReferences = pgTable(
  "canary_references",
  {
    modelId: text("model_id").notNull(),
    quant: text("quant").notNull(), // bf16 | fp8 | int4 ...
    fingerprint: jsonb("fingerprint").notNull(),
    source: text("source").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.quant] })],
);

export const apps = pgTable("apps", {
  id: text("id").primaryKey(), // sha256(origin)
  url: text("url"),
  title: text("title"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const generations = pgTable(
  "generations",
  {
    id: text("id").primaryKey(),
    ts: ts("ts").notNull().defaultNow(),
    keyHash: text("key_hash"),
    accountId: text("account_id"),
    modelId: text("model_id").notNull(),
    providerId: text("provider_id").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cost: money("cost").notNull().default(sql`0`), // total charged to caller
    upstreamCost: money("upstream_cost").notNull().default(sql`0`),
    royalty: money("royalty").notNull().default(sql`0`),
    margin: money("margin").notNull().default(sql`0`),
    cacheDiscount: money("cache_discount").notNull().default(sql`0`),
    mode: text("mode").notNull(), // prepaid | per_call | paywith | byok | cache
    latencyMs: integer("latency_ms"),
    generationTimeMs: integer("generation_time_ms"),
    finishReason: text("finish_reason"),
    nativeFinishReason: text("native_finish_reason"),
    streamed: boolean("streamed").notNull().default(false),
    cancelled: boolean("cancelled").notNull().default(false),
    quant: text("quant"),
    dataRegion: text("data_region"),
    isByok: boolean("is_byok").notNull().default(false),
    private: boolean("private").notNull().default(false),
    attestationHash: text("attestation_hash"),
    receiptId: text("receipt_id"),
    receiptSig: text("receipt_sig"),
    receiptKeyId: text("receipt_key_id"),
    receipt: jsonb("receipt"), // signed payload (hashes only, never content)
    receiptLeaf: text("receipt_leaf"),
    anchorIndex: integer("anchor_index"),
    leafIndex: integer("leaf_index"),
    paidWith: jsonb("paid_with"),
    paymentTx: text("payment_tx"),
    appId: text("app_id"),
    attempts: jsonb("attempts"),
    requestSha256: text("request_sha256"),
    responseSha256: text("response_sha256"),
    settledPeriod: text("settled_period"),
  },
  (t) => [
    index("gen_ts_idx").on(t.ts),
    index("gen_key_ts_idx").on(t.keyHash, t.ts),
    index("gen_provider_ts_idx").on(t.providerId, t.ts),
    index("gen_anchor_idx").on(t.anchorIndex),
  ],
);

export const receiptKeys = pgTable("receipt_keys", {
  id: text("id").primaryKey(), // 16 hex chars (bytes8)
  publicKey: text("public_key").notNull(), // raw 32-byte hex
  privateKeyEnc: text("private_key_enc"),
  validFrom: ts("valid_from").notNull(),
  retiredAt: ts("retired_at"),
  onchainTx: text("onchain_tx"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const anchors = pgTable("anchors", {
  index: integer("index").primaryKey(),
  root: text("root").notNull(),
  fromTs: ts("from_ts").notNull(),
  toTs: ts("to_ts").notNull(),
  count: integer("count").notNull(),
  txHash: text("tx_hash"),
  status: text("status").notNull().default("pending"), // pending | submitted | confirmed | local
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const spentRoots = pgTable("spent_roots", {
  epoch: integer("epoch").primaryKey(),
  root: text("root").notNull(),
  asOf: ts("as_of").notNull(),
  totalSpentUsdg: bigint("total_spent_usdg", { mode: "bigint" }).notNull(),
  leaves: jsonb("leaves").notNull(), // [[chainKeyHash, cumulativeSpentUsdg]] in tree order
  txHash: text("tx_hash"),
  status: text("status").notNull().default("pending"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const chainEvents = pgTable(
  "chain_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    contract: text("contract").notNull(),
    event: text("event").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    args: jsonb("args").notNull(),
    processed: boolean("processed").notNull().default(false),
    processedAt: ts("processed_at"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index("chain_events_unprocessed").on(t.processed, t.event)],
);

export const chainCursor = pgTable("chain_cursor", {
  id: text("id").primaryKey(),
  block: bigint("block", { mode: "bigint" }).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const quotes = pgTable(
  "quotes",
  {
    nonce: text("nonce").primaryKey(), // bytes32 hex
    priceUsdg: bigint("price_usdg", { mode: "bigint" }).notNull(),
    pricePico: money("price_pico").notNull(),
    requestSha256: text("request_sha256").notNull(),
    modelId: text("model_id").notNull(),
    expiresAt: ts("expires_at").notNull(),
    status: text("status").notNull().default("open"), // open | paid | used | expired
    payer: text("payer"),
    txHash: text("tx_hash"),
    accountId: text("account_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("quotes_tx_idx").on(t.txHash)], // one tx may pay several quotes (4337 bundles)
);

export const paywithSessions = pgTable("paywith_sessions", {
  keyHash: text("key_hash").primaryKey(), // chain key hash
  wallet: text("wallet").notNull(),
  token: text("token").notNull(),
  symbol: text("symbol").notNull(),
  capRawDay: bigint("cap_raw_day", { mode: "bigint" }).notNull(),
  spentRawToday: bigint("spent_raw_today", { mode: "bigint" }).notNull().default(sql`0`),
  dayStart: ts("day_start"),
  active: boolean("active").notNull().default(true),
  openedTx: text("opened_tx"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const paywithDebts = pgTable(
  "paywith_debts",
  {
    id: text("id").primaryKey(),
    chainKeyHash: text("chain_key_hash").notNull(),
    accountId: text("account_id").notNull(),
    generationId: text("generation_id").notNull(),
    token: text("token").notNull(),
    amount: money("amount").notNull(),
    rawEstimate: bigint("raw_estimate", { mode: "bigint" }),
    fairPrice18: text("fair_price18"),
    swapId: text("swap_id"),
    rawAllocated: bigint("raw_allocated", { mode: "bigint" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("paywith_debts_open_idx").on(t.chainKeyHash, t.swapId)],
);

export const paywithSwaps = pgTable("paywith_swaps", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull(),
  token: text("token").notNull(),
  rawSpent: bigint("raw_spent", { mode: "bigint" }),
  fairPrice: text("fair_price"),
  usdgOut: bigint("usdg_out", { mode: "bigint" }).notNull(),
  tx: text("tx"),
  status: text("status").notNull().default("pending"), // pending | submitted | confirmed | failed
  error: text("error"),
  ts: ts("ts").notNull().defaultNow(),
  allocations: jsonb("allocations"),
});

export const settlements = pgTable(
  "settlements",
  {
    providerId: text("provider_id").notNull(),
    period: text("period").notNull(), // ISO hour, e.g. 2026-09-26T13
    tokens: bigint("tokens", { mode: "bigint" }).notNull(),
    requests: integer("requests").notNull().default(0),
    upstream: money("upstream").notNull(),
    fee: money("fee").notNull(),
    usdgOwed: bigint("usdg_owed", { mode: "bigint" }).notNull(),
    payoutId: text("payout_id"),
    paidTx: text("paid_tx"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.period] })],
);

export const payouts = pgTable("payouts", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  usdg: bigint("usdg", { mode: "bigint" }).notNull(),
  to: text("to"),
  status: text("status").notNull().default("pending"), // pending | submitted | paid | invoice
  tx: text("tx"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const slashes = pgTable("slashes", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id"),
  kind: text("kind").notNull(), // empty200 | quant_fraud | uptime | param_drop
  amountUsdg: bigint("amount_usdg", { mode: "bigint" }).notNull(),
  delist: boolean("delist").notNull().default(false),
  evidenceRoot: text("evidence_root").notNull(),
  evidence: jsonb("evidence").notNull(),
  status: text("status").notNull().default("proposed"), // proposed | disputed | cancelled | executed | auto_refunded
  proposedAt: ts("proposed_at").notNull().defaultNow(),
  executableAt: ts("executable_at").notNull(),
  executedAt: ts("executed_at"),
  disputeHash: text("dispute_hash"),
  disputedAt: ts("disputed_at"),
  onchainId: text("onchain_id"),
  txHash: text("tx_hash"),
  refunded: money("refunded").notNull().default(sql`0`),
});

export const royalties = pgTable(
  "royalties",
  {
    modelId: text("model_id").notNull(),
    period: text("period").notNull(),
    amount: money("amount").notNull(),
    usdg: bigint("usdg", { mode: "bigint" }).notNull(),
    creator: text("creator"),
    streamTx: text("stream_tx"),
    claimed: boolean("claimed").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.period] })],
);

export const attestations = pgTable(
  "attestations",
  {
    id: serial("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    ts: ts("ts").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    teeKind: text("tee_kind"),
    reportHash: text("report_hash"),
    nonce: text("nonce"),
    measurements: jsonb("measurements"),
    detail: jsonb("detail"),
  },
  (t) => [index("attestations_provider_ts").on(t.providerId, t.ts)],
);

export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// Stock Token transfers into the escrow wallet (PAYMENTS_MODE=escrow). One row per Transfer log;
// the ledger credit uses ref `escrow:<tx>:<logIndex>`, so a deposit can never be credited twice, and a
// reversal (the transfer left the canonical chain after crediting) uses `escrow-reversal:<tx>:<logIndex>`.
// raw_amount is numeric: 18-decimal token amounts overflow bigint above ~9.2 whole tokens.
export const escrowDeposits = pgTable(
  "escrow_deposits",
  {
    id: text("id").primaryKey(), // <tx>:<logIndex>
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    token: text("token").notNull(),
    symbol: text("symbol").notNull(),
    fromAddress: text("from_address").notNull(),
    rawAmount: numeric("raw_amount", { precision: 78, scale: 0 }).notNull(),
    // pending_finality: seen above the finality point, not credited yet and may still disappear
    // pending: at or below the finality point, waiting for a price and the pre-credit canonical check
    // credited | orphaned (left the canonical chain before crediting; never credited)
    // reversed (left the canonical chain after crediting; a compensating debit was posted)
    status: text("status").notNull().default("pending"),
    blockHash: text("block_hash"), // hash of block_number when recorded; the credit is checked against it
    accountId: text("account_id"),
    price18: text("price18"), // USD per whole token, 18 decimals, as read from the feed
    priceUpdatedAt: ts("price_updated_at"),
    credited: money("credited"), // pico-USD after the haircut
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    creditedAt: ts("credited_at"),
    checkedAt: ts("checked_at"), // last time a credit was re-verified against the canonical chain
    reversedAt: ts("reversed_at"),
    reviewReason: text("review_reason"), // set when an operator must look (a reversal, or an orphan after finality)
    reviewedAt: ts("reviewed_at"), // set by the operator once reconciled; clears the readiness alert
  },
  (t) => [index("escrow_deposits_from_idx").on(t.fromAddress), index("escrow_deposits_status_idx").on(t.status)],
);

// ---- Workspace features (settings and billing data only; the privacy invariant above still holds) ----

// Saved Routes: a named, reusable routing policy an account calls as `model: "@route/<slug>"`.
// `config` holds { models: string[] (ordered fallbacks), provider?: {...OpenRouter provider prefs},
// params?: {...default request params}, max_price?: {...} }. No prompt text is stored.
export const savedRoutes = pgTable(
  "saved_routes",
  {
    id: text("id").primaryKey(), // rt_...
    accountId: text("account_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    config: jsonb("config").notNull(),
    createdBy: text("created_by"), // key hash
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("saved_routes_account_slug_uq").on(t.accountId, t.slug)],
);

// Agent Sessions: a short-lived sub-key for one agent run, with its own budget and expiry.
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(), // as_...
    accountId: text("account_id").notNull(),
    parentKeyHash: text("parent_key_hash").notNull(),
    keyHash: text("key_hash").notNull(), // the session's own key (keys.key_hash)
    name: text("name").notNull().default(""),
    budget: money("budget"), // pico; null = the parent key's limits only
    expiresAt: ts("expires_at").notNull(),
    endedAt: ts("ended_at"),
    endReason: text("end_reason"), // ended | expired | budget
    metadata: jsonb("metadata"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_sessions_key_uq").on(t.keyHash), index("agent_sessions_account_idx").on(t.accountId)],
);

// Spend Watch: alert rules on spend, evaluated by the `spend-watch` worker job.
export const spendAlerts = pgTable(
  "spend_alerts",
  {
    id: text("id").primaryKey(), // sa_...
    accountId: text("account_id").notNull(),
    keyHash: text("key_hash"), // null = whole account
    kind: text("kind").notNull(), // threshold | budget_pct | anomaly
    window: text("window").notNull().default("day"), // day | week | month
    thresholdUsd: money("threshold"), // pico, for kind=threshold
    pct: integer("pct"), // for kind=budget_pct
    webhookUrlEnc: text("webhook_url_enc"), // encrypted with APP_SECRET; optional
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: ts("last_fired_at"),
    lastPeriod: text("last_period"), // dedupe: fire at most once per rule per period
    state: jsonb("state"),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("spend_alerts_account_idx").on(t.accountId)],
);
