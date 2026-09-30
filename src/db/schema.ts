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
    tracing: jsonb("tracing"), // customer trace export destination; its URL and credentials sealed with APP_SECRET
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
    kind: text("kind").notNull(), // deposit | credit | usage | refund | paywith | change | adjustment | withdrawal_lock | withdrawal | blind_purchase
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
  // Whether the provider's last verified attestation reported the in-enclave hard-block classifier as enabled.
  // Set only by the attestor; false when unknown, when the last attestation failed, or when it did not say.
  classifierEnabled: boolean("classifier_enabled").notNull().default(false),
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
    mode: text("mode").notNull(), // prepaid | per_call | paywith | byok | cache | blind
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
    // Receipt v2 (spec/0004 Section 4): the JSON view of the signed claims, the COSE_Sign1 bytes (base64), its
    // anchor leaf and that leaf's position in the same anchor tree as the v1 leaf. Null for v1-only receipts.
    receiptV2: jsonb("receipt_v2"),
    receiptCose: text("receipt_cose"),
    receiptLeafV2: text("receipt_leaf_v2"),
    leafIndexV2: integer("leaf_index_v2"),
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
    status: text("status").notNull().default("open"), // open | paid | used | expired | failed (x402 claims: nonce "x402:<payer>:<authorization nonce>")
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

// The public proof-time record (services/attestation-history.ts): one row per attestor run, canary run, or change of
// the health probe's outcome. Nothing here is raw provider output: `reason` is a code from a fixed list, `measurements`
// holds only digests, and rows older than ATTESTATION_HISTORY_DAYS are pruned by the attestor job.
export const attestationEvents = pgTable(
  "attestation_events",
  {
    id: serial("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    kind: text("kind").notNull(), // attestation | canary | probe
    ts: ts("ts").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    reason: text("reason"), // failure code, null when ok
    simulated: boolean("simulated").notNull().default(false), // development evidence: never counts as a fresh attestation
    teeKind: text("tee_kind"),
    attestationHash: text("attestation_hash"), // attestations.report_hash of an ok run
    tlsSpkiSha256: text("tls_spki_sha256"), // SPKI hash of the certificate the connection was pinned to, when pinned
    measurements: jsonb("measurements"), // image / compose / model digests and TDX registers of an ok run
    measurementChanged: boolean("measurement_changed").notNull().default(false), // differs from the previous ok run's
    verifiers: jsonb("verifiers"), // names of the verifiers that accepted the quote
    detail: jsonb("detail"),
  },
  (t) => [index("attestation_events_provider_ts_idx").on(t.providerId, t.ts, t.id), index("attestation_events_ts_idx").on(t.ts)],
);

// The image, compose and model digests a provider's confidential endpoint has been seen running, each bound
// into a hardware quote a configured verifier accepted. One row per (provider, image digest, compose hash); rows are
// created only from a verified, non-simulated attestation. A provider has at most one current row: the one its latest
// verified quote committed to. Every other row of the provider carries superseded_at (and superseded_by, the row that
// replaced it, when one was recorded) and is kept as history with its transparency-log entry. Status: observed
// (attested, not yet found in Rekor), ready (attested and found in Rekor with a verified inclusion proof; register()
// calldata may be built), registered (an operator recorded the transaction that registered it), revoked.
export const measurements = pgTable(
  "measurements",
  {
    id: serial("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    imageDigest: text("image_digest").notNull(), // 0x + 32 bytes
    composeHash: text("compose_hash").notNull(),
    modelDigest: text("model_digest").notNull(),
    status: text("status").notNull().default("observed"),
    verifier: text("verifier").notNull(), // verifiers that accepted the quote, comma separated
    teeKind: text("tee_kind"),
    quote: text("quote").notNull(), // hex of the verified quote: the proof whose hash the registry stores
    quoteProofHash: text("quote_proof_hash").notNull(), // keccak256 of the quote bytes
    reportHash: text("report_hash"), // attestations.report_hash of the attestation that produced the row
    attestedAt: ts("attested_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    rekorUuid: text("rekor_uuid"),
    rekorEntry: text("rekor_entry"), // 0x + the 32-byte entry hash inside the uuid
    rekorLogIndex: bigint("rekor_log_index", { mode: "number" }),
    rekorKind: text("rekor_kind"),
    rekorIntegratedAt: ts("rekor_integrated_at"),
    rekorInclusionVerified: boolean("rekor_inclusion_verified").notNull().default(false),
    rekorCheckpointVerified: boolean("rekor_checkpoint_verified").notNull().default(false),
    rekorCheckedAt: ts("rekor_checked_at"),
    rekorError: text("rekor_error"),
    calldata: text("calldata"),
    calldataTarget: text("calldata_target"),
    calldataBuiltAt: ts("calldata_built_at"),
    txHash: text("tx_hash"),
    registeredAt: ts("registered_at"),
    revokedAt: ts("revoked_at"),
    supersededAt: ts("superseded_at"), // set once a later verified quote committed to other digests; null while current
    supersededBy: integer("superseded_by"), // measurements.id of the row that replaced this one, when one was recorded
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("measurements_provider_image_compose_uq").on(t.providerId, t.imageDigest, t.composeHash),
    index("measurements_status_idx").on(t.status, t.updatedAt),
  ],
);

// Signed measurement bundles (services/measurement-bundle.ts): what a provider's measurement is made of, signed with
// the measurement key and recorded in a public transparency log. Handed over by an operator, verified by the router
// (signature, log entry, inclusion proof), and only then applied to the matching measurement rows.
export const measurementBundles = pgTable(
  "measurement_bundles",
  {
    id: serial("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    composeHash: text("compose_hash").notNull(), // 0x + 32 bytes: the quote-measured compose hash this bundle describes
    bundleDigest: text("bundle_digest").notNull(), // 0x + sha256 of the canonical bundle bytes: the artifact hash in the log entry
    bundle: jsonb("bundle").notNull(),
    signature: text("signature").notNull(), // base64 ECDSA P-256 (DER) over the canonical bundle bytes
    signerKeyId: text("signer_key_id").notNull(), // sha256 of the signer's SubjectPublicKeyInfo, hex
    status: text("status").notNull().default("pending"), // pending -> verified | rejected
    rekorUuid: text("rekor_uuid"),
    rekorEntry: text("rekor_entry"), // 0x + the 32-byte entry (leaf) hash inside the uuid
    rekorLogIndex: bigint("rekor_log_index", { mode: "number" }),
    rekorIntegratedAt: ts("rekor_integrated_at"),
    rekorEntryJson: jsonb("rekor_entry_json"), // the entry as the log returned it: body, proof and signed entry timestamp
    rekorInclusionVerified: boolean("rekor_inclusion_verified").notNull().default(false),
    rekorCheckpointVerified: boolean("rekor_checkpoint_verified").notNull().default(false),
    rekorSetVerified: boolean("rekor_set_verified").notNull().default(false),
    checkedAt: ts("checked_at"),
    verifiedAt: ts("verified_at"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("measurement_bundles_provider_digest_uq").on(t.providerId, t.bundleDigest),
    index("measurement_bundles_compose_idx").on(t.providerId, t.composeHash),
    index("measurement_bundles_status_idx").on(t.status, t.checkedAt),
  ],
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

// Presets: versioned saved routes an account calls as `model: "@preset/<name>[@<version>]"`. Append-only: every change
// (and every rollback) is a new row; the latest version is the preset. Deleting the preset deletes its rows.
export const presetVersions = pgTable(
  "preset_versions",
  {
    id: text("id").primaryKey(), // pv_...
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(), // 1, 2, 3, ... per (account, name)
    hash: text("hash").notNull(), // sha256 hex of the normalized document's canonical JSON
    config: jsonb("config").notNull(), // the preset document (src/routing/presets.ts presetDocSchema)
    source: text("source").notNull().default("put"), // put | rollback
    restoredFrom: integer("restored_from"), // the version a rollback copied
    createdBy: text("created_by"), // key hash
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("preset_versions_account_name_version_uq").on(t.accountId, t.name, t.version)],
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

// ---- Disclosure profiles (what a provider says, and can prove, about how it handles a prompt) ----

// One operator-curated row per provider. A provider with no row is treated as the most conservative
// profile (retention "logs", jurisdiction "unknown"). `claims` holds { <claim>: { source, as_of } }
// for retention, jurisdiction, legal_hold and training_use, so every stated value points at a
// document and a date. legal_hold is null until declared. Nothing here is derived from traffic.
export const providerDisclosure = pgTable("provider_disclosure", {
  providerId: text("provider_id").primaryKey(),
  retention: text("retention").notNull().default("logs"), // attested | policy | logs
  jurisdiction: text("jurisdiction").notNull().default("unknown"),
  legalHold: boolean("legal_hold"), // null = not declared
  legalHoldNote: text("legal_hold_note"),
  trainingUse: text("training_use").notNull().default("unknown"), // none | opt_in | yes | unknown
  claims: jsonb("claims").notNull().default({}),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---- Blind tokens (Privacy Pass type 0x0002; ANYROUTE_FEATURE_BLIND) ----------------------------------
// Nothing here links a buyer to a token: purchases store per-key counts only, and the nullifier table holds
// only a hash of a token, which the issuer cannot connect to the blinded request it signed.

// Issuer keys, one per (epoch, denomination). The private half is AES-GCM encrypted with APP_SECRET and is
// wiped when the epoch stops issuing; the public half stays so old tokens remain verifiable.
export const blindKeys = pgTable(
  "blind_keys",
  {
    keyId: text("key_id").primaryKey(), // token_key_id: hex SHA-256 of the RFC 9578 SPKI
    epoch: integer("epoch").notNull(),
    denomination: integer("denomination").notNull(), // token-units the key's tokens are worth: 1000 | 10000 | 100000
    unitPrice: money("unit_price").notNull(), // pico-USD per token-unit, fixed when the key is created: a token's value never changes
    spki: text("spki").notNull(), // base64url RFC 9578 SubjectPublicKeyInfo
    privateEnc: text("private_enc"), // PKCS#8, encrypted; null once the key no longer issues
    validFrom: ts("valid_from").notNull(),
    issueUntil: ts("issue_until").notNull(),
    redeemUntil: ts("redeem_until").notNull(),
    revokedAt: ts("revoked_at"),
    issued: bigint("issued", { mode: "number" }).notNull().default(0), // tokens signed: a count, nothing else
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("blind_keys_epoch_denomination_uq").on(t.epoch, t.denomination)],
);

// Spent tokens. The primary key is the unique constraint that stops a double spend: a token is reserved by
// inserting its nullifier (SHA-256 of the token) before the request runs, and confirmed after it is served.
// A request that fails before anything is served deletes its reservation so the token can be used again.
export const blindNullifiers = pgTable(
  "blind_nullifiers",
  {
    nullifier: text("nullifier").primaryKey(),
    keyId: text("key_id").notNull(),
    status: text("status").notNull().default("reserved"), // reserved | spent
    reservedAt: ts("reserved_at").notNull().defaultNow(),
    spentAt: ts("spent_at"),
    generationId: text("generation_id"),
  },
  (t) => [index("blind_nullifiers_key_idx").on(t.keyId)],
);

// ---- The Lane: catalog variants, day-zero candidates, creator claims -----------------------------------

// Per-model metadata for open-weights variants. A model with no row is "mainstream" (unless its id says
// otherwise, see router/lane.ts). Rows may be written before any provider lists the model, so that a model
// is classified before it can be served. variant abliterated and native_low_refusal are served only on the
// attested lane, by providers whose verified attestation reports the hard-block classifier as enabled.
// status "candidate" means the model is not approved for serving: it is routed to no provider at all.
export const modelsLane = pgTable("models_lane", {
  modelId: text("model_id").primaryKey(), // same id as models.id
  variant: text("variant").notNull().default("mainstream"), // mainstream | native_low_refusal | abliterated
  status: text("status").notNull().default("servable"), // servable | candidate
  baseModel: text("base_model"), // the model this one derives from (Hugging Face repo id)
  license: text("license"), // SPDX-style identifier taken from the weights' model card
  weightsSource: text("weights_source"), // e.g. huggingface:owner/repo
  weightsRevision: text("weights_revision"), // commit the weights were taken from
  weightsDigest: text("weights_digest"), // sha256:<hex> of the weights manifest, when the operator has one
  creatorHandle: text("creator_handle"), // Hugging Face handle of the uploader
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// New Hugging Face uploads that derive from an allow-listed permissive base model. Status: discovered
// (license accepted), rejected (reason says why), evaluated (scores stored and passed), failed (scores
// stored, did not pass), approved (an operator approved it), servable (approved, and an attested provider
// with the classifier serves it). One row per repository; the revision seen at discovery is the one evaluated.
export const laneCandidates = pgTable(
  "lane_candidates",
  {
    id: serial("id").primaryKey(),
    hfRepo: text("hf_repo").notNull(),
    baseModel: text("base_model").notNull(),
    revision: text("revision"),
    license: text("license"),
    variant: text("variant").notNull().default("abliterated"),
    creatorHandle: text("creator_handle").notNull(),
    status: text("status").notNull().default("discovered"),
    reason: text("reason"),
    modelId: text("model_id"), // catalog model id the candidate is served under
    endpointProvider: text("endpoint_provider"), // provider whose offer for modelId is evaluated
    sourceCreatedAt: ts("source_created_at"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    approvalNote: text("approval_note"),
    servableAt: ts("servable_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lane_candidates_repo_uq").on(t.hfRepo), index("lane_candidates_status_idx").on(t.status)],
);

// One row per evaluation run of a candidate endpoint.
export const laneEvals = pgTable(
  "lane_evals",
  {
    id: serial("id").primaryKey(),
    candidateId: integer("candidate_id").notNull(),
    ts: ts("ts").notNull().defaultNow(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    refusalRate: real("refusal_rate"), // share of the benign probe prompts that were refused
    capabilityScore: real("capability_score"), // share of the exact-check prompts answered correctly
    canaryAccuracy: real("canary_accuracy"), // the canary exact-match set (services/canaries.ts)
    canaryQuantMatch: boolean("canary_quant_match"),
    passed: boolean("passed").notNull(),
    detail: jsonb("detail"),
  },
  (t) => [index("lane_evals_candidate_idx").on(t.candidateId, t.ts)],
);

// Creator royalty claims: the router issues a challenge, the uploader publishes it in a file of their
// Hugging Face repository, and the router checks the file through the Hugging Face API.
export const laneClaims = pgTable(
  "lane_claims",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    hfRepo: text("hf_repo").notNull(),
    handle: text("handle").notNull(),
    address: text("address").notNull(),
    challenge: text("challenge").notNull(),
    status: text("status").notNull().default("pending"), // pending | verified
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    verifiedAt: ts("verified_at"),
    onchainTx: text("onchain_tx"),
  },
  (t) => [index("lane_claims_model_idx").on(t.modelId, t.createdAt)],
);

// ---- Oblivious HTTP gateway keys (OHTTP_ENABLED) --------------------------------------------------------
// One HPKE key per epoch. The public half (and its RFC 9458 key configuration) stays forever, so the published
// key history never loses an entry; the private half is AES-GCM encrypted with APP_SECRET and destroyed when
// the epoch's acceptance window ends, after which recorded traffic for that epoch can no longer be opened.
export const ohttpKeys = pgTable(
  "ohttp_keys",
  {
    epoch: integer("epoch").primaryKey(),
    keyId: integer("key_id").notNull(), // the 8-bit key identifier of the key configuration: epoch mod 256
    kemId: integer("kem_id").notNull(),
    publicKey: text("public_key").notNull(), // base64url, raw 32 bytes
    config: text("config").notNull(), // base64url, the encoded key configuration (RFC 9458 section 3.1)
    configSha256: text("config_sha256").notNull(),
    privateEnc: text("private_enc"), // raw private key, encrypted; null once destroyed
    validFrom: ts("valid_from").notNull(),
    acceptUntil: ts("accept_until").notNull(), // requests to this key are opened until here
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ohttp_keys_key_id_idx").on(t.keyId)],
);

// ---- Per-host anchoring of enclave receipts (HOST_ANCHOR_ENABLED) ----------------------------------------
// services/host-anchor.ts collects each attested host's sidecar receipt leaves from its leaf feed, keeps only those
// whose signature verifies under the receipt key the host's router-verified attestation binds, and roots them: one
// root per host, attestation reference and interval. A leaf row holds the leaf hash and the receipt id and time,
// never the receipt's hashes or usage.
export const hostAnchors = pgTable(
  "host_anchors",
  {
    id: serial("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    attestationRef: text("attestation_ref").notNull(), // 64 hex: sha256 of the boot quote the router verified
    receiptKeyId: text("receipt_key_id").notNull(),
    receiptPublicKey: text("receipt_public_key").notNull(), // raw Ed25519 key (hex) the quote's bindings commit to
    root: text("root").notNull(),
    fromTs: ts("from_ts").notNull(), // collected in [from_ts, to_ts)
    toTs: ts("to_ts").notNull(),
    count: integer("count").notNull(),
    status: text("status").notNull().default("pending"), // pending | confirmed | local
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "number" }),
    chainIndex: integer("chain_index"), // index in ReceiptAnchor's attested anchors, once posted
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("host_anchors_provider_idx").on(t.providerId, t.toTs), index("host_anchors_status_idx").on(t.status)],
);

export const hostAnchorLeaves = pgTable(
  "host_anchor_leaves",
  {
    providerId: text("provider_id").notNull(),
    leaf: text("leaf").notNull(),
    anchorId: integer("anchor_id").notNull(),
    leafIndex: integer("leaf_index").notNull(),
    receiptId: text("receipt_id").notNull(),
    receiptTs: ts("receipt_ts").notNull(), // the time the receipt itself states
    collectedAt: ts("collected_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.leaf] }), index("host_anchor_leaves_leaf_idx").on(t.leaf), uniqueIndex("host_anchor_leaves_position_idx").on(t.anchorId, t.leafIndex)],
);

// ---- Transparency log of keys and configurations (TLOG_ENABLED; src/tlog) ------------------------------------------
// An append-only RFC 6962 tree in the C2SP tlog-tiles layout. Entries are never updated or deleted: `idx` is the leaf
// index, `entry` the exact bytes that were hashed. A checkpoint is written once per tree size; witnesses add
// cosignatures to it.
export const tlogEntries = pgTable(
  "tlog_entries",
  {
    idx: bigint("idx", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(), // receipt_key | ohttp_key_config | blind_issuer_key | measurement_bundle | attestation_binding
    sha256: text("sha256").notNull(), // hex digest of the key or configuration the entry names
    subject: text("subject").notNull(), // the key id, epoch or provider the entry is about
    entry: text("entry").notNull(), // canonical JSON; the leaf is SHA-256(0x00 || these UTF-8 bytes)
    leafHash: text("leaf_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tlog_entries_kind_sha256_uq").on(t.kind, t.sha256), index("tlog_entries_subject_idx").on(t.kind, t.subject)],
);

export const tlogCheckpoints = pgTable("tlog_checkpoints", {
  size: bigint("size", { mode: "number" }).primaryKey(),
  rootHash: text("root_hash").notNull(), // hex
  checkpoint: text("checkpoint").notNull(), // the checkpoint text: origin, size, base64 root hash
  signature: text("signature").notNull(), // the log's signature line over the body
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tlogCosignatures = pgTable(
  "tlog_cosignatures",
  {
    size: bigint("size", { mode: "number" }).notNull(),
    witness: text("witness").notNull(), // the witness's key name
    keyId: text("key_id").notNull(), // hex of the 4-byte signed-note key id
    timestamp: bigint("timestamp", { mode: "number" }).notNull(), // cosignature/v1 time, seconds
    line: text("line").notNull(), // the signature line as the witness sent it
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.size, t.witness, t.keyId] })],
);

// Public-log anchoring of checkpoints (TLOG_REKOR_ENABLED; src/tlog/rekor.ts). One row per Rekor entry that commits to a
// checkpoint: a hashedrekord over the signed checkpoint note, signed with TLOG_REKOR_SIGNING_KEY. A row is `pending` until
// the entry's inclusion proof is in hand and verifies, then `verified`; only verified rows are served.
export const tlogRekorAnchors = pgTable(
  "tlog_rekor_anchors",
  {
    id: serial("id").primaryKey(),
    size: bigint("size", { mode: "number" }).notNull(), // the checkpoint's tree size
    rootHash: text("root_hash").notNull(), // hex
    note: text("note").notNull(), // the artifact: checkpoint text, blank line, the log's own signature line
    artifactSha256: text("artifact_sha256").notNull(), // hex; the hash the Rekor entry holds
    keyId: text("key_id").notNull(), // sha256 of the anchoring key's SubjectPublicKeyInfo, hex
    rekorUrl: text("rekor_url").notNull(),
    uuid: text("uuid").notNull(),
    status: text("status").notNull(), // pending | verified
    logIndex: bigint("log_index", { mode: "number" }),
    integratedTime: bigint("integrated_time", { mode: "number" }), // seconds
    logId: text("log_id"),
    entryBase64: text("entry_base64"), // the entry body as Rekor returned it (base64)
    inclusionProof: jsonb("inclusion_proof").$type<{ logIndex: number; treeSize: number; rootHash: string; hashes: string[]; checkpoint: string | null }>(),
    signedEntryTimestamp: text("signed_entry_timestamp"),
    checkpointVerified: boolean("checkpoint_verified").notNull().default(false), // Rekor's checkpoint signature, against REKOR_PUBLIC_KEY
    setVerified: boolean("set_verified").notNull().default(false), // the signed entry timestamp, against REKOR_PUBLIC_KEY
    createdAt: ts("created_at").notNull().defaultNow(),
    verifiedAt: ts("verified_at"),
  },
  (t) => [uniqueIndex("tlog_rekor_anchors_uuid_uq").on(t.rekorUrl, t.uuid), index("tlog_rekor_anchors_status_size_idx").on(t.status, t.size)],
);

// Batch API (src/services/batches.ts): one row per batch and one per line, with statuses, counts, costs and generation ids
// only. The lines' requests and answers are never written to Postgres: they are kept sealed in Redis (or the router's
// memory) until the batch's results expire (BATCH_RESULTS_TTL), and the line rows are deleted at the same time.
export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey(), // batch_<hex>
    accountId: text("account_id").notNull(),
    keyHash: text("key_hash").notNull(), // the key that submitted it; only that key can read or cancel it
    api: text("api").notNull(), // chat | embeddings | mixed
    status: text("status").notNull().default("validating"), // validating | in_progress | cancelling | completed | failed | expired | cancelled
    total: integer("total").notNull(),
    completed: integer("completed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    cost: money("cost").notNull().default(sql`0`), // charged, after the batch discount
    listCost: money("list_cost").notNull().default(sql`0`), // what the same calls cost without the discount
    discountBps: integer("discount_bps").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    cancellingAt: ts("cancelling_at"),
    finishedAt: ts("finished_at"),
    expiresAt: ts("expires_at").notNull(), // end of the completion window: lines not run by then expire unbilled
    resultsExpireAt: ts("results_expire_at"), // finished_at + BATCH_RESULTS_TTL
    purgedAt: ts("purged_at"), // when the sealed results and the line rows were deleted
  },
  (t) => [index("batches_key_created_idx").on(t.keyHash, t.createdAt), index("batches_status_idx").on(t.status, t.createdAt)],
);

export const batchLines = pgTable(
  "batch_lines",
  {
    batchId: text("batch_id").notNull(),
    idx: integer("idx").notNull(), // 0-based line number
    api: text("api").notNull(), // chat | embeddings
    status: text("status").notNull().default("queued"), // queued | running | succeeded | failed | cancelled | expired
    attempts: integer("attempts").notNull().default(0),
    statusCode: integer("status_code"),
    generationId: text("generation_id"),
    cost: money("cost").notNull().default(sql`0`),
    listCost: money("list_cost").notNull().default(sql`0`),
    failureCode: text("failure_code"), // the error type, such as insufficient_credits
    notBefore: ts("not_before").notNull().defaultNow(), // a rate-limited or retried line waits until then
    finishedAt: ts("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.idx] }), index("batch_lines_queue_idx").on(t.status, t.notBefore)],
);
