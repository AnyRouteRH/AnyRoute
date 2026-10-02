import { rushEnv, rushSettings } from "./rush/config.ts"; // ON3
import { structuredOutputEnv } from "./structured-output/options.ts"; // V83: opt-in JSON checking.
import { insightsEnv } from "./insights/config.ts"; // V88: off by default.
import { networkStatsEnv } from "./network/stats-config.ts";
import { sealedEnv, guardSealed } from "./agents/sealed/config.ts";
import { agreementEnv, agreementSettings } from "./agreements/config.ts";
import { networkPayoutEnv, networkPayoutSettings } from "./network/payout-config.ts";
import { hostBondEnv, hostBondSettings } from "./network/bond-config.ts";
import { networkHostsEnv, networkHostsSettings } from "./network/host-config.ts";
import { sanctionsEnv, sanctionsSettings } from "./network/config.ts";
import { e2eeSettings } from "./e2ee/config.ts";
import { networkWeightEnv, networkWeightSettings } from "./network/weight-config.ts";
import { createHash, createHmac, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { usdToPico } from "./lib/money.ts";
import { parseOnionAddress, parseOnionSecrets } from "./lib/onion.ts";
import { parseModelMap } from "./anthropic/models.ts";
import { parseSignerKey, parseVerifierKey, SIG_COSIGNATURE_V1, validKeyName, type NoteVerifier } from "./tlog/note.ts";

// Every setting comes from the environment. Missing optional services produce
// an explicit "unavailable" state at runtime; they never fake success.

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (d: number) => z.coerce.number().int().default(d);
const num = (d: number) => z.coerce.number().default(d);
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address")
  .optional()
  .or(z.literal("").transform(() => undefined));
const pk = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
  .optional()
  .or(z.literal("").transform(() => undefined));
const opt = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

/** The measurement public key, normalised to a PEM string; throws on anything that is not an ECDSA P-256 public key. */
function measurementPublicKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\\n/g, "\n").trim();
  if (/PRIVATE KEY/.test(text)) throw new Error("MEASUREMENT_PUBLIC_KEY must be the public key; a private key was given.");
  try {
    const key = text.includes("BEGIN") ? createPublicKey(text) : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("not P-256");
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new Error("MEASUREMENT_PUBLIC_KEY must be an ECDSA P-256 public key (PEM or base64 SPKI).");
  }
}

const schema = z.object({
  ...rushEnv, // ON3
  DEVELOPER_FIRST_CALL_ENABLED: bool.default(false), // ON2: guidance for GETs to model endpoints.
  ...structuredOutputEnv, // V83
  ...insightsEnv, // V88: spend insights.
  ...sealedEnv,
  ...hostBondEnv,
  ...networkWeightEnv,
  ...agreementEnv,
  ...sanctionsEnv,
  ...networkHostsEnv,
  ...networkStatsEnv,
  INFERENCE_KEYS_ENABLED: bool.default(false), // ZK6: minting restricted keys; stored scopes are always enforced.
  WEBHOOK_SIGNING_ENABLED: bool.default(false), // V86: signed account webhooks.
  ...networkPayoutEnv,
  RUNTIME_ROLE: z.enum(["all", "api", "worker"]).default("all"),
  WORKER_JOBS: z.string().default(""),
  AUTO_MIGRATE: bool.default(true),
  ANYROUTE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787),
  PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:8787"),
  // Passkeys for organisation members (WebAuthn). Default: the host and origin of PUBLIC_BASE_URL, where the dashboard is served.
  WEBAUTHN_RP_ID: opt,
  WEBAUTHN_ORIGINS: opt, // comma-separated origins allowed in clientDataJSON
  DATABASE_URL: z.string().default("pglite://.data/pglite"),
  REDIS_URL: opt,
  APP_SECRET: opt,
  ADMIN_TOKEN: opt,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: bool.default(false), // true behind exactly one trusted reverse proxy that appends X-Forwarded-For

  ROUTE_EXPLAIN_ENABLED: bool.default(false), // V84: route explanations.
  STATEMENTS_ENABLED: bool.default(false), // V87: read-only signed monthly statements.
  // Receipts
  RECEIPT_SIGNING_KEY: opt,
  RECEIPT_KEY_ROTATION_DAYS: num(7),
  ANCHOR_INTERVAL_MS: int(3_600_000),
  // Per-host anchoring of enclave receipts. Off by default: no job, no route. The `host-anchor` worker job collects each
  // attested sidecar's receipt leaves (GET /anchor/leaves with that host's anchor token), keeps those signed by the
  // receipt key its router-verified attestation binds, and roots them per host and interval; with a configured chain and
  // anchorer key it posts each root with ReceiptAnchor.anchorAttested, otherwise keeps it off chain (status "local").
  HOST_ANCHOR_ENABLED: bool.default(false),
  HOST_DASHBOARD_ENABLED: bool.default(false),
  HOST_ANCHOR_INTERVAL_MS: int(3_600_000),
  HOST_ANCHOR_TOKENS: opt, // JSON {"<provider id>": "<that sidecar's SIDECAR_ANCHOR_TOKEN>"}

  // Chain (Robinhood Chain mainnet by default)
  CHAIN_ID: int(4663),
  RHC_RPC_URL: z.string().default("https://rpc.mainnet.chain.robinhood.com"),
  PUBLIC_RPC_URL: z.string().default("https://rpc.mainnet.chain.robinhood.com"), // shown to wallets (never the private node URL)
  EXPLORER_URL: z.string().default("https://robinhoodchain.blockscout.com"),
  WEB_DIR: opt, // built website (web/out) served at /; default ./web/out when present
  CHAIN_CONFIRMATIONS: int(2),
  CHAIN_START_BLOCK: z.coerce.bigint().optional(),
  USDG_ADDRESS: addr.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  USDG_EIP712_NAME: z.string().default("Global Dollar"),
  USDG_EIP712_VERSION: z.string().default("1"),
  CREDITS_ADDRESS: addr,
  CALLPAY_ADDRESS: addr,
  PAYWITHSTOCK_ADDRESS: addr,
  PROVIDER_BOND_ADDRESS: addr,
  RECEIPT_ANCHOR_ADDRESS: addr,
  ROYALTY_ADDRESS: addr,
  ANYR_STAKING_ADDRESS: addr,
  PAYMASTER_ADDRESS: addr,
  CALLPAY_TREASURY: addr,
  ROUTER_PRIVATE_KEY: pk,
  SETTLEMENT_PRIVATE_KEY: pk,
  ANCHORER_PRIVATE_KEY: pk,
  PAYMASTER_SIGNER_KEY: pk,
  SLASHER_PRIVATE_KEY: pk,
  KEEPER_PRIVATE_KEY: pk,
  // Local development only: POST /api/v1/dev/faucet mints mock USDG and deposits it to the caller's key,
  // so the site can be tried without a wallet. Refused in production and against a non-loopback RPC.
  DEV_FAUCET: bool.default(false),
  DEV_FAUCET_PRIVATE_KEY: pk,
  V4_POOL_MANAGER: addr.default("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  ANYR_POOL_LEGS: opt, // optional off-chain second opinion: JSON v4 legs [{key:{currency0,currency1,fee,tickSpacing,hooks}, sign}] pricing ANYR in USDG
  BUYBACK_TWAP_MINUTES: num(30),
  BUYBACK_MAX_DEVIATION: num(0.05),
  BUYBACK_SLIPPAGE_BPS: int(100),
  BUYBACK_MAX_PER_RUN_USD: num(1000),
  HF_BASE_URL: z.string().default("https://huggingface.co"),

  // Economics (basis points)
  PER_CALL_MARGIN_BPS: int(100),
  PROVIDER_FEE_BPS: int(200),
  BYOK_FEE_BPS: int(0),
  DEFAULT_ROYALTY_BPS: int(500),
  PER_CALL_QUOTE_TTL_S: int(300),
  PER_CALL_MAX_USD: num(25),
  // x402 (exact scheme): agents sign a USDG EIP-3009 transferWithAuthorization to X402_PAY_TO and send it as
  // X-PAYMENT; the router relays it (ROUTER_PRIVATE_KEY pays the gas). Enabled when X402_PAY_TO is set.
  X402_PAY_TO: addr,
  X402_NETWORK: z.string().min(1).default("robinhood-chain"),
  PAYMENT_WAIT_MS: int(8_000),

  // Pay with Stock Tokens
  PAYWITH_THRESHOLD_USD: num(1),
  PAYWITH_MAX_AGE_H: num(24),
  PAYWITH_MAX_DEBT_USD: num(5),
  PAYWITH_MAX_SLIP_BPS: int(100),
  PAYWITH_CAP_HAIRCUT_BPS: int(1000),
  PAYWITH_TOKENS: opt, // JSON: [{symbol,address,decimals,feed?}]

  // Stock escrow payments: a customer transfers an allowlisted Stock Token from their own wallet to
  // ESCROW_ADDRESS; once its block is final the sending wallet's account is credited at the Chainlink
  // price minus ESCROW_HAIRCUT_BPS. PAYMENTS_MODE=escrow runs without the Anyroute contracts.
  PAYMENTS_MODE: z.enum(["contracts", "escrow"]).default("contracts"),
  ESCROW_ADDRESS: addr,
  ESCROW_TOKENS: opt, // JSON: [{symbol,address,decimals,feed}]; default: PAYWITH_TOKENS entries that have a feed
  ESCROW_HAIRCUT_BPS: int(300),
  ESCROW_MAX_PRICE_AGE_S: int(302_400), // equity feeds pause outside market hours; 3.5 days covers long weekends
  ESCROW_START_BLOCK: z.coerce.bigint().optional(),
  // Credit only transfers in blocks the chain reports as final (CHAIN_CONFIRMATIONS stays an extra floor),
  // and keep re-verifying credits for ESCROW_REORG_HORIZON_BLOCKS below that point (~1 day on Robinhood Chain).
  ESCROW_FINALITY: z.enum(["finalized", "safe"]).default("finalized"),
  ESCROW_REORG_HORIZON_BLOCKS: int(864_000),

  // Pay with $ANYR in escrow (off unless ANYR_TOKEN_ADDRESS is set). ANYR sent to ESCROW_ADDRESS is credited
  // like a Stock Token, with the same finality and reorganization rules, but priced from its pools
  // (ANYR_POOL_LEGS: the lower of spot and the BUYBACK_TWAP_MINUTES average) instead of a Chainlink feed,
  // minus ANYR_ESCROW_HAIRCUT_BPS, and credited at most ANYR_ESCROW_MAX_USD_PER_DEPOSIT per deposit.
  ANYR_TOKEN_ADDRESS: addr,
  ANYR_TOKEN_SYMBOL: z.string().default("ANYR"),
  ANYR_TOKEN_DECIMALS: int(18), // checked against the token contract before anything is credited
  ANYR_ESCROW_HAIRCUT_BPS: int(0),
  ANYR_ESCROW_MAX_USD_PER_DEPOSIT: num(250),
  ANYR_ESCROW_MAX_DEVIATION: opt, // no price while spot is further than this from the average; default BUYBACK_MAX_DEVIATION

  // Routing / health
  OUTAGE_WINDOW_MS: int(30_000),
  HEALTH_PROBE_INTERVAL_MS: int(15_000),
  HEALTH_PROBES: bool.default(true),
  PROVIDER_TIMEOUT_MS: int(120_000),
  FIRST_TOKEN_TIMEOUT_MS: int(45_000),
  MAX_PROVIDER_ATTEMPTS: int(4),
  EMPTY200_SLASH_THRESHOLD: num(0.02),
  UPTIME_SLASH_THRESHOLD: num(0.95),
  // Selection weight multiplier for an endpoint served under the attested class (declared attested retention and a
  // fresh, verified attestation), per lane. On lanes attested and unlinkable every eligible endpoint is attested, so
  // their bonus only matters if set differently from 1. Must be at least 1: attestation never lowers a weight.
  ATTESTED_BONUS_PUBLIC: z.coerce.number().min(1).max(10).default(1.25),
  ATTESTED_BONUS_ATTESTED: z.coerce.number().min(1).max(10).default(1),
  ATTESTED_BONUS_UNLINKABLE: z.coerce.number().min(1).max(10).default(1),

  // Canaries
  CANARY_INTERVAL_MS: int(3_600_000),
  CANARIES: bool.default(true),
  SHADOW_DAYS: num(7),

  // Attestation
  ATTESTATION_INTERVAL_MS: int(600_000),
  // Days of attestor, canary and probe events kept for the public proof-time record (GET /api/v1/attestation/summary).
  // 0 records nothing and switches the two history endpoints off; rows already stored are left alone.
  ATTESTATION_HISTORY_DAYS: z.coerce.number().int().min(0).max(366).default(30),
  ALLOW_DEV_ATTESTATION: bool.default(false),
  // Public status page (GET /api/v1/status/slo): availability targets per lane, as fractions, and how many requests a window
  // needs before a dip below target is recorded as an incident suggestion for an operator to confirm.
  STATUS_SLO_PUBLIC: z.coerce.number().min(0.5).max(1).default(0.995),
  STATUS_SLO_ATTESTED: z.coerce.number().min(0.5).max(1).default(0.99),
  STATUS_SLO_UNLINKABLE: z.coerce.number().min(0.5).max(1).default(0.99),
  STATUS_SUGGEST_MIN_REQUESTS: z.coerce.number().int().min(1).default(20),
  NVIDIA_NRAS_URL: z.string().default("https://nras.attestation.nvidia.com/v3/attest/gpu"),
  TDX_VERIFIER_URL: opt,
  TDX_VERIFIER_KEY: opt,
  // Which services confirm a TEE quote: a comma list of dcap (TDX_VERIFIER_URL, the default), intel-ta, dstack,
  // phala (Phala Cloud's public quote verifier, PHALA_VERIFIER_URL).
  // Every listed verifier must accept the quote.
  ATTESTATION_VERIFIERS: z.string().default("dcap"),
  INTEL_TA_URL: z.string().default("https://api.trustauthority.intel.com/appraisal/v2/attest"),
  INTEL_TA_JWKS_URL: z.string().default("https://portal.trustauthority.intel.com/certs"),
  INTEL_TA_API_KEY: opt,
  DSTACK_VERIFIER_URL: opt,
  DSTACK_VERIFIER_KEY: opt,
  PHALA_VERIFIER_URL: z.string().default("https://cloud-api.phala.com/api/v1/attestations/verify"),

  // Measurements: record the image/compose/model digests bound into verified quotes, look them up in the
  // Rekor transparency log and prepare MeasurementRegistry.register() calldata. Off by default; nothing is submitted.
  MEASUREMENTS_ENABLED: bool.default(false),
  MEASUREMENTS_INTERVAL_MS: int(300_000),
  REKOR_URL: z.string().default("https://rekor.sigstore.dev"),
  REKOR_PUBLIC_KEY: opt, // PEM (ECDSA P-256) that signs Rekor checkpoints; without it checkpoints are not verified
  MEASUREMENT_REGISTRY_ADDRESS: addr,
  // PEM (or base64 SPKI) of the ECDSA P-256 key that signs measurement bundles. Setting it turns on bundle checking: the router
  // then accepts signed bundles (POST /trpc/measurements.submitBundle), verifies their transparency-log entries, and publishes
  // the key at GET /api/v1/measurements/key. Only the public key belongs here; the private key stays with whoever publishes.
  MEASUREMENT_PUBLIC_KEY: opt,

  // The Lane. Day-zero pipeline (off by default): watch Hugging Face for new fine-tunes of the listed permissive
  // base models, check their license, and create candidates for evaluation. Nothing is served without an
  // operator approval and an attested provider.
  DAYZERO_ENABLED: bool.default(false),
  DAYZERO_INTERVAL_MS: int(900_000),
  DAYZERO_BASE_MODELS: z.string().default(""), // comma list of Hugging Face repo ids (owner/name) whose derivatives are watched
  DAYZERO_LICENSES: z.string().default("mit,apache-2.0"), // license ids (model card metadata) a base model and a derivative may carry
  DAYZERO_KEYWORDS: z.string().default("abliterated,uncensored,decensored,unfiltered"), // a repository is a candidate only if its id or tags contain one
  DAYZERO_MAX_PER_RUN: int(25), // most repositories examined in one run
  DAYZERO_MAX_REFUSAL_RATE: num(0.25), // largest share of the benign probe set a candidate may refuse
  DAYZERO_MIN_CAPABILITY: num(0.8), // smallest share of the exact-check set a candidate must answer correctly
  DAYZERO_MIN_CANARY: num(0.75), // smallest share of the canary exact-match set
  // Creator claims: how long an issued challenge stays valid, and the file the uploader publishes it in.
  LANE_CLAIM_TTL_S: int(86_400),
  LANE_CLAIM_FILE: z.string().default("anyroute-claim.txt"),

  // Workers
  WORKERS: bool.default(true),
  SETTLEMENT_INTERVAL_MS: int(3_600_000),
  PROVIDER_REGISTRY_INTERVAL_MS: int(600_000),
  PROVIDERS_FILE: opt,
  E2EE_PASSTHROUGH_ENABLED: bool.default(false),
  E2EE_GATEWAY_BASE_URL: opt, // production pin for the Phala gateway when PROVIDERS_FILE is not used
  E2EE_GATEWAY_ATTESTATION_URL: opt,

  // Gateway features
  OTEL_EXPORTER_OTLP_ENDPOINT: opt,
  OTEL_SERVICE_NAME: z.string().default("anyroute"),
  CACHE_TTL_S: z.coerce.number().int().min(1).default(3600),
  SEMANTIC_CACHE_THRESHOLD: num(0.97),
  SEMANTIC_CACHE_EMBEDDING_MODEL: opt,

  // Anthropic Messages endpoint (POST /v1/messages): JSON object mapping the model names an Anthropic client sends to catalog model ids.
  ANTHROPIC_MODEL_MAP: opt,

  // Council mode (model "anyroute/council") and dual verification (verify: "dual"). Off unless enabled.
  ANYROUTE_FEATURE_COUNCIL: bool.default(false),
  ANYROUTE_COUNCIL_MODELS: opt, // comma list of 2-5 model ids used when a council request names none
  ANYROUTE_COUNCIL_JUDGE: opt, // model id of the judge used when a council request names none
  ANYROUTE_COUNCIL_MODE: z.enum(["judge", "fuse"]).default("judge"),

  // Private RAG (POST /api/v1/rag): what one request may carry. Document text is never stored; these bound the memory and the calls it costs.
  RAG_MAX_DOCUMENTS: int(200),
  RAG_MAX_BYTES: int(2_097_152), // total UTF-8 bytes of document text
  RAG_MAX_CHUNKS: int(2000),
  RAG_MAX_EMBEDDING_CALLS: int(64), // embeddings calls one request may make (a small-context embedding model needs more, smaller ones)

  // Batch API (POST /api/v1/batches): lines run on the worker, in spare capacity, at a discount. Requests and answers are kept
  // sealed in Redis (or memory), never in Postgres, until BATCH_RESULTS_TTL seconds after the batch finishes.
  BATCH_DISCOUNT_BPS: z.coerce.number().int().min(0).max(10_000).default(5000), // 5000 = batch lines cost half the normal price
  BATCH_MAX_LINES: int(1000), // lines in one batch
  BATCH_MAX_BYTES: int(8 * 1024 * 1024), // bytes of input in one batch
  BATCH_MAX_ACTIVE: int(2), // unfinished batches one key may have at a time
  BATCH_RESULTS_TTL: z.coerce.number().int().min(60).default(86_400), // seconds results are kept after a batch finishes
  BATCH_INTERVAL_MS: int(2_000), // how often the worker drains queued lines
  BATCH_LINES_PER_TICK: int(20), // most lines started per drain
  BATCH_CONCURRENCY: int(4), // lines run at once
  BATCH_LINE_MAX_ATTEMPTS: int(3), // tries for a line whose providers were all unavailable

  // Secured Skills Hub (/api/v1/skills): agent skills imported from a repository or an archive, scanned, hashed and served.
  SKILLS_MAX_BYTES: int(5 * 1024 * 1024), // unpacked bytes of one skill (and the most an uploaded archive may be)
  SKILLS_MAX_FILES: int(500), // files in one skill
  SKILLS_ALLOWED_HOSTS: opt, // comma-separated hosts added to the scanner's network allowlist (a host also covers its subdomains)
  SKILLS_DOWNLOAD_LEVELS: z.string().default("trusted,caution"), // scan levels that may be downloaded and installed
  SKILLS_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(1000), // network fee on a paid install; the author gets the rest
  SKILLS_GIT_TIMEOUT_MS: int(30_000),
  SKILLS_ALLOW_LOCAL_GIT: bool.default(false), // file:// and local paths as import sources (never in production)
  SKILLS_SOURCES: opt, // mirror job sources, JSON: [{ "kind": "git", "url", "ref"?, "paths"? } | { "kind": "index", "url" }]
  SKILLS_MIRROR_INTERVAL_MS: int(6 * 3_600_000),

  // Default per-key limits (0 = unlimited)
  DEFAULT_RPM: int(600),
  DEFAULT_TPM: int(0),
  UNAUTH_RPM: int(60),
  NEW_KEYS_PER_HOUR: int(10),

  // Release identity and contract-path launch guards (see contractPathGuards below)
  RELEASE_COMMIT: opt, // git commit of the running build, shown at GET /api/v1/status
  DEPLOYMENT_MANIFEST: opt, // the anyroute.deployments/v1 manifest of the configured contracts: a file path or inline JSON
  DEPLOYMENT_VERIFICATION: opt, // the passing scripts/verify-deployment.ts report for that manifest: a file path or inline JSON
  BUYBACK_ORACLE_ADDRESS: addr, // the reviewed buyback-floor oracle AnyrStaking uses; production refuses buybacks without it
  PAYWITH_DELEGATION_ACCEPTED: bool.default(false),
  PAYWITH_MAX_DAILY_CAP_USD: opt, // largest daily cap (USD at the fair price) the API will build a PayWithStock session for

  // Operations: optional alert webhook (a secret URL) and off-host backup freshness.
  ALERT_WEBHOOK_URL: opt,
  ALERT_WEBHOOK_FORMAT: z.enum(["ntfy", "slack", "discord", "json"]).optional().or(z.literal("").transform(() => undefined)),
  BACKUP_REQUIRED: bool.default(false),
  BACKUP_MAX_AGE_HOURS: num(26),

  // Optional Telegram bot (BotFather token, a secret). Without it the bot never starts.
  TELEGRAM_BOT_TOKEN: opt,
  TELEGRAM_LINKING_ENABLED: bool.default(false),

  // ---- $ANYR holder perks: free inference credits (scripts/holder-credits.ts) and live holder tiers.
  // The token is ANYR_TOKEN_ADDRESS / ANYR_TOKEN_SYMBOL above (the $ANYR escrow settings).
  ANYR_TOKEN_DEPLOY_BLOCK: z.coerce.bigint().optional(), // first block the holder snapshot scans for Transfer logs
  HOLDER_CREDITS_EXCLUDE: opt, // comma list of addresses never credited (pool, treasury, escrow, burn...)
  HOLDER_TIERS: opt, // JSON [{name,min,rpm_multiplier,discount_bps}]; tiers are off unless ANYR_TOKEN_ADDRESS is set too

  // ---- IPX, the inference price index: volume-weighted USDG price per 1M tokens per model class,
  // computed from real generations (GET /api/v1/ipx/:class). Off unless IPX_ENABLED.
  IPX_ENABLED: bool.default(false),
  IPX_CLASSES: opt, // JSON {"IPX-OPEN-70B":["author/model-id", ...]}; default: IPX-OPEN-70B = meta-llama/llama-3.3-70b-instruct
  IPX_THIN_USDG: z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a USDG amount like \"50000\"").default("50000"), // trailing-24h volume below which a class is THIN
  IPX_MAX_ACCOUNT_SHARE_BPS: int(10_000), // cap on one account's share of a window's volume; 10000 = no cap
  IPX_ATTESTED_ONLY: bool.default(true), // count only fills served by providers with a stored attestation
  // ---- IPX oracle publisher (src/services/ipx-oracle.ts): signed index price updates from the latest IPX samples,
  // served at GET /api/v1/ipx/:class/oracle and optionally handed to publishers. Off unless IPX_ORACLE_ENABLED (and IPX_ENABLED).
  IPX_ORACLE_ENABLED: bool.default(false),
  IPX_ORACLE_PRIVATE_KEY: pk, // dedicated oracle signing key (32 bytes, hex); signs messages only and holds no funds. Never shared with a chain role.
  IPX_ORACLE_PUBLIC_KEY: opt, // public half for replicas that do not hold the private key (ed25519: 0x + 32 bytes; secp256k1: address)
  IPX_ORACLE_ALGORITHM: z.enum(["ed25519", "secp256k1-eip191"]).default("ed25519"),
  IPX_ORACLE_CLASSES: opt, // comma list of IPX class ids to publish; default: every IPX class
  IPX_ORACLE_INTERVAL_S: int(300), // publishing cadence
  IPX_ORACLE_STALE_AFTER_S: int(1800), // an update is valid for this long; a consumer must halt past it
  IPX_ORACLE_MAX_MOVE_BPS: int(1000), // largest move of the published price from the previous update, in basis points
  IPX_ORACLE_HALTED: bool.default(false), // kill switch in config: freeze publishing (PUT /api/v1/ipx/oracle/halt sets it at runtime)
  IPX_ORACLE_PUBLISHERS: opt, // comma list of sinks: "onchain" (IPXFeed calldata) and/or "https" (generic push); default none
  IPX_ORACLE_FEEDS: opt, // JSON {"IPX-OPEN-70B":"0x<IPXFeed address>"} for the onchain sink
  IPX_ORACLE_ONCHAIN_SUBMIT: bool.default(false), // onchain sink: submit the transaction with IPX_KEEPER_PRIVATE_KEY (default: build calldata only)
  IPX_ORACLE_PUSH_CONFIG: opt, // https sink: path to a JSON file (or inline JSON) describing the request; see deploy/ipx-perp/
  IPX_KEEPER_PRIVATE_KEY: pk, // the IPXFeed keeper; only used by the onchain sink with IPX_ORACLE_ONCHAIN_SUBMIT. Run it on a worker with no other signing key.

  // ---- Blind tokens: unlinkable paid access with Privacy Pass tokens (RFC 9578 type 0x0002). Off by default;
  // when off no route is registered and a PrivateToken Authorization header is not looked at.
  ANYROUTE_FEATURE_BLIND: bool.default(false),
  BLIND_UNIT_PRICE_USD: z.string().default("0.000002"), // value of one token-unit; a token is 1000, 10000 or 100000 units
  BLIND_EPOCH_SECONDS: int(604_800), // issuer keys rotate every epoch (one week)
  BLIND_REDEEM_GRACE_SECONDS: int(604_800), // tokens stay redeemable this long after their epoch stops issuing
  BLIND_MULTI_TOKEN_ENABLED: bool.default(false), // allow token sets; existing single-token calls are unchanged
  BLIND_MAX_TOKENS_PER_REQUEST: z.coerce.number().int().min(1).max(64).default(16), // bound signature work and header size
  BLIND_MAX_BATCH: int(32), // most tokens one purchase request may ask for
  BLIND_PURCHASE_RPM: int(10), // purchase requests per key per minute
  BLIND_REDEEM_RPM: int(600), // calls per minute per client address that present a token (tokens bring their own quota)
  BLIND_MAX_USD_PER_DAY: num(100), // most one account may convert into tokens per rolling day

  // ---- Oblivious HTTP (RFC 9458) gateway and the "unlinkable" lane. Off by default: no route is registered and
  // lane "unlinkable" keeps answering 501. Needs ANYROUTE_FEATURE_BLIND (the lane is paid with blind tokens).
  OHTTP_ENABLED: bool.default(false),
  OHTTP_KEY_EPOCH_SECONDS: int(86_400), // gateway HPKE keys rotate every epoch (one day)
  OHTTP_KEY_GRACE_SECONDS: int(86_400), // an epoch's key still opens requests this long after the epoch ends
  OHTTP_MAX_REQUEST_BYTES: int(8_388_608), // largest encapsulated request the gateway accepts
  OHTTP_MAX_RESPONSE_BYTES: int(8_388_608), // largest response the gateway will encapsulate (larger becomes a 502)
  OHTTP_RELAY_RPM: int(6000), // gateway requests per minute per authenticated relay
  OHTTP_DIRECT_RPM: int(60), // gateway requests per minute per client address that did not come through a relay
  OHTTP_PAD_BYTES: int(256), // responses are zero-padded to a multiple of this many bytes (0 = no padding)
  OHTTP_GATEWAY_OPERATOR: z.string().default("AnyRoute"), // the name this router's own operator goes by in RELAY_OPERATORS
  OHTTP_MIN_RELAY_OPERATORS: int(2), // production refuses to start with fewer relay operators than this that are not the gateway operator
  OHTTP_CHUNKED_ENABLED: bool.default(false), // also accept chunked Oblivious HTTP (message/ohttp-chunked-req), so streamed responses arrive as they are produced; only with OHTTP_ENABLED
  RELAY_OPERATORS: opt, // JSON [{operator,url,key_id,secret_sha256}]: the relays clients may use; published at GET /api/v1/relays

  // ---- Tor. Optional. ONION_ADDRESS is the v3 onion hostname of deploy/onion, published at GET /api/v1/status. Requests
  // that the onion proxy forwards carry ONION_PROXY_SECRET in X-Anyroute-Onion; they have no client address, so their
  // per-address rate limits are shared pools ONION_POOL_MULTIPLIER times a single address's limit.
  ONION_ADDRESS: opt,
  ONION_PROXY_SECRET: opt,
  ONION_POOL_MULTIPLIER: int(10),
  // Serve lane "unlinkable" over Tor as well: to requests the onion proxy forwarded that are paid with a blind token and
  // nothing that names the payer, from attested providers only. Off by default; needs ONION_ADDRESS, ONION_PROXY_SECRET
  // and ANYROUTE_FEATURE_BLIND. It is an alternative to OHTTP_ENABLED, not a change to it (src/onion/lane.ts).
  UNLINKABLE_VIA_ONION: bool.default(false),

  // ---- Transparency log of keys and configurations (C2SP tlog-tiles with signed-note checkpoints and tlog-cosignature
  // witnesses; src/tlog). Off by default: no route is registered and nothing is appended.
  AGENT_PROFILES_ENABLED: bool.default(false),
  AGENT_POLICY_ENABLED: bool.default(false),
  AGENT_APPROVAL_TTL_S: z.coerce.number().int().min(1).max(86400).default(900),
  NETWORK_POLICY_ENABLED: bool.default(false),
  TLOG_ENABLED: bool.default(false),
  TLOG_ORIGIN: opt, // checkpoint origin and the log's key name; default "<host of PUBLIC_BASE_URL>/tlog"
  TLOG_SIGNING_KEY: opt, // the log's Ed25519 key: base64 PKCS#8, or PRIVATE+KEY+<origin>+<id>+<key>; required in production
  TLOG_WITNESSES: opt, // witness verifier keys "<name>+<id>+<base64 0x04 key>", comma or newline separated
  TLOG_WITNESS_QUORUM: int(2), // cosignatures a checkpoint needs to count as witnessed
  TLOG_INTERVAL_MS: int(60_000), // how often the log job picks up new keys and signs a checkpoint
  TLOG_COSIGN_RPM: int(60), // cosignature submissions per minute per client address
  // Append the SHA-256 of the data inventory this build publishes at /keep/inventory.json (src/privacy) to the log, as a
  // data_inventory entry, when a new inventory is first deployed. Off by default; needs TLOG_ENABLED.
  TLOG_DATA_INVENTORY: bool.default(false),
  // Public-log anchoring (src/tlog/rekor.ts), off by default: each new checkpoint, at most once per
  // TLOG_REKOR_MIN_INTERVAL_MS, is recorded in the Rekor log at REKOR_URL as a hashedrekord entry over the signed checkpoint
  // note, signed with TLOG_REKOR_SIGNING_KEY. REKOR_PUBLIC_KEY, when set, is used to check Rekor's checkpoint and signed
  // entry timestamp. In production this is accepted in place of TLOG_WITNESS_QUORUM witnesses.
  TLOG_REKOR_ENABLED: bool.default(false),
  TLOG_REKOR_SIGNING_KEY: opt, // a dedicated ECDSA P-256 private key (PKCS#8 or SEC1 PEM, or base64 PKCS#8); never the measurement key
  TLOG_REKOR_MIN_INTERVAL_MS: int(600_000), // at most one Rekor submission per this many milliseconds (at least 60000)
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, unknown> = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  guardSealed(e);
  if (e.NETWORK_POLICY_ENABLED && !e.TLOG_ENABLED) throw new Error("NETWORK_POLICY_ENABLED needs TLOG_ENABLED.");
  const production = e.ANYROUTE_ENV === "production";
  const escrowMode = e.PAYMENTS_MODE === "escrow";
  const contractAddresses = {
    CREDITS_ADDRESS: e.CREDITS_ADDRESS,
    CALLPAY_ADDRESS: e.CALLPAY_ADDRESS,
    PAYWITHSTOCK_ADDRESS: e.PAYWITHSTOCK_ADDRESS,
    PROVIDER_BOND_ADDRESS: e.PROVIDER_BOND_ADDRESS,
    RECEIPT_ANCHOR_ADDRESS: e.RECEIPT_ANCHOR_ADDRESS,
    ROYALTY_ADDRESS: e.ROYALTY_ADDRESS,
    ANYR_STAKING_ADDRESS: e.ANYR_STAKING_ADDRESS,
    PAYMASTER_ADDRESS: e.PAYMASTER_ADDRESS,
  };
  if (escrowMode) {
    if (!e.ESCROW_ADDRESS || /^0x0{40}$/.test(e.ESCROW_ADDRESS)) throw new Error("PAYMENTS_MODE=escrow requires ESCROW_ADDRESS.");
    // Escrow mode skips the contract custody checks, so it must not run beside live contracts.
    const set = Object.entries(contractAddresses).filter(([, v]) => v).map(([k]) => k);
    if (set.length) throw new Error(`PAYMENTS_MODE=escrow must not configure contracts (${set.join(", ")}).`);
  }
  if (e.ESCROW_HAIRCUT_BPS < 0 || e.ESCROW_HAIRCUT_BPS >= 10_000) throw new Error("ESCROW_HAIRCUT_BPS must be between 0 and 9999.");
  if (e.ESCROW_MAX_PRICE_AGE_S <= 0) throw new Error("ESCROW_MAX_PRICE_AGE_S must be positive.");
  if (e.ESCROW_REORG_HORIZON_BLOCKS <= 0) throw new Error("ESCROW_REORG_HORIZON_BLOCKS must be positive.");
  if (production) {
    if (escrowMode && e.ESCROW_START_BLOCK == null && e.CHAIN_START_BLOCK == null) throw new Error("PAYMENTS_MODE=escrow requires ESCROW_START_BLOCK in production, so no transfer before the watcher starts is missed.");
    if (!e.APP_SECRET || e.APP_SECRET.length < 32) throw new Error("APP_SECRET (>= 32 chars) is required in production.");
    if (!e.ADMIN_TOKEN || e.ADMIN_TOKEN.length < 24) throw new Error("ADMIN_TOKEN (>= 24 chars) is required in production.");
    if (e.ALLOW_DEV_ATTESTATION) throw new Error("ALLOW_DEV_ATTESTATION must be false in production.");
    if (!e.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be https in production.");
    if (!/^postgres(?:ql)?:/.test(e.DATABASE_URL)) throw new Error("PostgreSQL is required in production.");
    const database = new URL(e.DATABASE_URL);
    if (!database.password || ["anyroute", "postgres", "password"].includes(decodeURIComponent(database.password))) throw new Error("Nondefault database credential is required in production.");
    if (!e.REDIS_URL || !/^rediss?:/.test(e.REDIS_URL) || !new URL(e.REDIS_URL).password) throw new Error("Production requires authenticated Redis.");
    if (e.RUNTIME_ROLE === "all") throw new Error("Production requires separate api and worker roles.");
    if (e.AUTO_MIGRATE) throw new Error("Production requires AUTO_MIGRATE=false and a completed migration job.");
    if (e.HOST === "127.0.0.1" || e.HOST === "localhost" || e.HOST === "::1") throw new Error("Production HOST must be externally reachable.");
    if (!escrowMode)
      for (const [name, value] of Object.entries({ CREDITS_ADDRESS: e.CREDITS_ADDRESS, CALLPAY_ADDRESS: e.CALLPAY_ADDRESS, RECEIPT_ANCHOR_ADDRESS: e.RECEIPT_ANCHOR_ADDRESS, PROVIDER_BOND_ADDRESS: e.PROVIDER_BOND_ADDRESS }))
        if (!value || /^0x0{40}$/.test(value)) throw new Error(`${name} is required in production.`);
    if (e.RUNTIME_ROLE === "api" && !escrowMode && !e.ROUTER_PRIVATE_KEY) throw new Error("Public API requires the restricted router signing role for enabled per-call payments.");
    if (e.PAYMASTER_ADDRESS && e.RUNTIME_ROLE === "api" && !e.PAYMASTER_SIGNER_KEY) throw new Error("Configured paymaster requires its signing role.");
    const roleKeys = { settlement: e.SETTLEMENT_PRIVATE_KEY, anchoring: e.ANCHORER_PRIVATE_KEY, slashing: e.SLASHER_PRIVATE_KEY, buyback: e.KEEPER_PRIVATE_KEY };
    if (e.RUNTIME_ROLE === "api" && Object.values(roleKeys).some(Boolean)) throw new Error("Public API must not receive settlement, anchoring, slashing or keeper signing keys.");
    // Escrow mode has no contracts, so no job signs anything: receipts stay signed locally ("local"
    // anchors) and settlement, slashing and buybacks are inert. No signing key belongs anywhere.
    if (escrowMode && Object.values(roleKeys).some(Boolean)) throw new Error("PAYMENTS_MODE=escrow must not receive settlement, anchoring, slashing or keeper signing keys.");
    // IPX: the oracle key signs messages and the IPX keeper key posts to the feed; neither belongs on the public API,
    // and the keeper key (a funded chain signer) stays apart from every other signing role.
    if (e.RUNTIME_ROLE === "api" && (e.IPX_ORACLE_PRIVATE_KEY || e.IPX_KEEPER_PRIVATE_KEY)) throw new Error("Public API must not receive the IPX oracle or IPX keeper key; set IPX_ORACLE_PUBLIC_KEY instead.");
    if (e.IPX_KEEPER_PRIVATE_KEY && (escrowMode || Object.values(roleKeys).some(Boolean))) throw new Error("IPX_KEEPER_PRIVATE_KEY must be isolated from every other signing role.");
    if (e.RUNTIME_ROLE === "worker") {
      const names = e.WORKER_JOBS.split(",").map((v) => v.trim()).filter(Boolean);
      const allowed = ["health-flush", "holds-expire", "catalog-refresh", "provider-registry", "health-probes", "canaries", "attestor", "receipts-anchor", "receipt-key-rotation", "settlement", "slasher", "buyback", "chain-indexer", "paywith-aggregator", "escrow-indexer", "spend-watch", "alert-notifier", "telegram-bot", "measurements", "blind-key-rotation", "ipx-oracle", "dayzero", "ohttp-key-rotation", "host-anchor", "tlog", "batches", "skills-mirror", "sanctions-refresh"];
      allowed.push("webhooks"); // V86: bounded event delivery.
      allowed.push("agreement-indexer", "agreement-jury", "agreement-retention");
      allowed.push("upstream-monitor"); // ON3
      allowed.push("agent-alerts", "agent-policy-retention", "agent-ledger-retention", "network-fee-burn", "host-bond-indexer", "host-slasher");
      if (!names.length || names.some((n) => !allowed.includes(n))) throw new Error("Worker requires an explicit valid WORKER_JOBS list.");
      const keyJobs = { settlement: "settlement", anchoring: "receipts-anchor", slashing: "slasher", buyback: "buyback" };
      if (Object.values(roleKeys).filter(Boolean).length > 1) throw new Error("Privileged worker signing roles must be isolated.");
      if (names.includes("ipx-oracle") && !(e.IPX_ORACLE_ENABLED && e.IPX_ORACLE_PRIVATE_KEY)) throw new Error("The ipx-oracle job needs IPX_ORACLE_ENABLED and IPX_ORACLE_PRIVATE_KEY.");
      if (names.includes("host-anchor") && !e.HOST_ANCHOR_ENABLED) throw new Error("The host-anchor job needs HOST_ANCHOR_ENABLED.");
      if (!escrowMode)
        for (const [role, key] of Object.entries(roleKeys)) {
          const enabled = names.includes(keyJobs[role as keyof typeof keyJobs]) || (role === "buyback" && names.includes("network-fee-burn")) || (role === "slashing" && names.includes("host-slasher") && e.NETWORK_SLASHING_ENABLED);
          if (enabled !== !!key) throw new Error(`Worker ${role} job and signing-key configuration must match.`);
        }
    }
  }
  const verifierNames = e.ATTESTATION_VERIFIERS.split(",").map((v) => v.trim()).filter(Boolean);
  if (!verifierNames.length || verifierNames.some((v) => !["dcap", "intel-ta", "dstack", "phala"].includes(v))) throw new Error("ATTESTATION_VERIFIERS must list dcap, intel-ta, dstack and/or phala.");
  if (new Set(verifierNames).size !== verifierNames.length) throw new Error("ATTESTATION_VERIFIERS lists a verifier twice.");
  if (verifierNames.includes("intel-ta") && !e.INTEL_TA_API_KEY) throw new Error("ATTESTATION_VERIFIERS includes intel-ta, which needs INTEL_TA_API_KEY.");
  if (verifierNames.includes("dstack") && !e.DSTACK_VERIFIER_URL) throw new Error("ATTESTATION_VERIFIERS includes dstack, which needs DSTACK_VERIFIER_URL.");
  if (production) {
    if (verifierNames.includes("intel-ta") && !(e.INTEL_TA_URL.startsWith("https://") && e.INTEL_TA_JWKS_URL.startsWith("https://"))) throw new Error("INTEL_TA_URL and INTEL_TA_JWKS_URL must be https in production.");
    if (e.MEASUREMENTS_ENABLED && !e.REKOR_URL.startsWith("https://")) throw new Error("REKOR_URL must be https in production.");
    if (verifierNames.includes("phala") && !e.PHALA_VERIFIER_URL.startsWith("https://")) throw new Error("PHALA_VERIFIER_URL must be https in production.");
  }
  // Contract-path guards: verified deployment (H-02), buyback oracle (M-05), PayWithStock delegation (M-06).
  const contractPath = contractPathGuards(e, production, escrowMode);
  if (e.DEV_FAUCET) {
    if (production) throw new Error("DEV_FAUCET must be false in production.");
    let host = "";
    try {
      host = new URL(e.RHC_RPC_URL).hostname;
    } catch {
      /* reported below */
    }
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error("DEV_FAUCET only works against a local chain (RHC_RPC_URL on 127.0.0.1/localhost).");
    if (!e.DEV_FAUCET_PRIVATE_KEY) throw new Error("DEV_FAUCET needs DEV_FAUCET_PRIVATE_KEY (a funded local development account).");
  }
  // The bot token is optional and secret (it is part of every Telegram API URL): never echo it.
  // The API only issues and checks link codes; every Telegram message is sent by the process that runs the bot and
  // alert jobs, so only roles that run jobs need the bot token.
  if (e.TELEGRAM_LINKING_ENABLED && !e.AGENT_POLICY_ENABLED) throw new Error("TELEGRAM_LINKING_ENABLED requires AGENT_POLICY_ENABLED.");
  if (e.TELEGRAM_LINKING_ENABLED && e.RUNTIME_ROLE !== "api" && !e.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_LINKING_ENABLED requires TELEGRAM_BOT_TOKEN on the worker (or a combined role).");
  if (e.TELEGRAM_BOT_TOKEN && !/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(e.TELEGRAM_BOT_TOKEN)) throw new Error("TELEGRAM_BOT_TOKEN must be the token BotFather issued (<id>:<secret>).");
  // The webhook is optional: without it the alert-notifier job only records state. Never echo the URL.
  if (e.ALERT_WEBHOOK_URL) {
    let protocol = "";
    try { protocol = new URL(e.ALERT_WEBHOOK_URL).protocol; } catch { /* reported below */ }
    if (protocol !== "https:" && (production || protocol !== "http:")) throw new Error("ALERT_WEBHOOK_URL must be an https URL.");
  }
  if (!(e.BACKUP_MAX_AGE_HOURS > 0)) throw new Error("BACKUP_MAX_AGE_HOURS must be positive.");
  if (e.PER_CALL_MARGIN_BPS > 100) throw new Error("PER_CALL_MARGIN_BPS must be <= 100 (1%).");
  if (e.X402_PAY_TO && /^0x0{40}$/.test(e.X402_PAY_TO)) throw new Error("X402_PAY_TO must not be the zero address.");
  if (production && e.X402_PAY_TO && e.RUNTIME_ROLE === "api" && !e.ROUTER_PRIVATE_KEY) throw new Error("X402_PAY_TO requires the router signing role (ROUTER_PRIVATE_KEY) to relay x402 settlements.");
  const tokenList = z.array(
    z.object({
      symbol: z.string().min(1).max(16),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      decimals: z.number().int().min(0).max(36),
      feed: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      name: z.string().optional(),
    }),
  );
  let paywithTokens: PaywithToken[] = [];
  if (e.PAYWITH_TOKENS) {
    try {
      paywithTokens = tokenList.parse(JSON.parse(e.PAYWITH_TOKENS));
    } catch (err) {
      throw new Error(`PAYWITH_TOKENS must be a JSON array of {symbol,address,decimals,feed?}: ${(err as Error).message}`);
    }
  }
  let escrowTokens: EscrowToken[] = [];
  try {
    const listed = e.ESCROW_TOKENS ? tokenList.parse(JSON.parse(e.ESCROW_TOKENS)) : paywithTokens;
    if (e.ESCROW_TOKENS && listed.some((t) => !t.feed)) throw new Error("every token needs a feed");
    escrowTokens = listed.filter((t): t is EscrowToken => !!t.feed);
  } catch (err) {
    throw new Error(`ESCROW_TOKENS must be a JSON array of {symbol,address,decimals,feed}: ${(err as Error).message}`);
  }
  const lower = escrowTokens.map((t) => t.address.toLowerCase());
  if (new Set(lower).size !== lower.length) throw new Error("ESCROW_TOKENS lists a token address twice.");
  if (escrowMode && !escrowTokens.length) throw new Error("PAYMENTS_MODE=escrow requires ESCROW_TOKENS (or PAYWITH_TOKENS) with price feeds.");
  const councilModels = (e.ANYROUTE_COUNCIL_MODELS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (councilModels.length && (councilModels.length < 2 || councilModels.length > 5 || new Set(councilModels).size !== councilModels.length))
    throw new Error("ANYROUTE_COUNCIL_MODELS must list 2 to 5 distinct model ids.");
  const anyrEscrow = anyrEscrowConfig(e, lower);
  const holders = holderSettings(e, anyrEscrow);
  return {
    env: e.ANYROUTE_ENV,
    production,
    developerFirstCallEnabled: e.DEVELOPER_FIRST_CALL_ENABLED, // ON2
    routeExplain: e.ROUTE_EXPLAIN_ENABLED, // V84
    hostDashboard: { enabled: e.HOST_DASHBOARD_ENABLED },
    agreements: agreementSettings(e, production),
    sanctions: sanctionsSettings(e, production),
    e2ee: e2eeSettings(e.E2EE_PASSTHROUGH_ENABLED, e.PROVIDERS_FILE, production, { baseUrl: e.E2EE_GATEWAY_BASE_URL, attestationUrl: e.E2EE_GATEWAY_ATTESTATION_URL }),
    networkHosts: networkHostsSettings(e, production),
    inferenceKeysEnabled: e.INFERENCE_KEYS_ENABLED, // ZK6
    statementsEnabled: e.STATEMENTS_ENABLED, // V87
    networkStatsEnabled: e.NETWORK_STATS_ENABLED,
    rush: rushSettings(e), // ON3
    spendInsightsEnabled: e.SPEND_INSIGHTS_ENABLED, // V88: read-only spend insights.
    webhookSigningEnabled: e.WEBHOOK_SIGNING_ENABLED, // V86: off preserves existing delivery.
    networkPayouts: networkPayoutSettings(e, production),
    networkWeights: { ...networkWeightSettings(e), ...(e.NETWORK_BONDS_ENABLED ? { bonds: { ...hostBondSettings(e), scope: `${e.CHAIN_ID}:${e.HOST_BOND_ADDRESS?.toLowerCase()}` } } : {}) },
    hostBonds: hostBondSettings(e),
    runtimeRole: e.RUNTIME_ROLE,
    autoMigrate: e.AUTO_MIGRATE,
    workerJobs: e.WORKER_JOBS.split(",").map((n) => n.trim()).filter(Boolean),
    test: e.ANYROUTE_ENV === "test",
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    webauthn: {
      rpId: e.WEBAUTHN_RP_ID ?? new URL(e.PUBLIC_BASE_URL).hostname,
      origins: e.WEBAUTHN_ORIGINS ? e.WEBAUTHN_ORIGINS.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean) : [new URL(e.PUBLIC_BASE_URL).origin],
    },
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appSecret: e.APP_SECRET ?? "dev-insecure-secret-change-me-dev-insecure",
    adminToken: e.ADMIN_TOKEN,
    agentProfilesEnabled: e.AGENT_PROFILES_ENABLED,
    agentPolicyEnabled: e.AGENT_POLICY_ENABLED,
    agentSealedEnabled: e.AGENT_SEALED_ENABLED,
    agentApprovalTtlS: e.AGENT_APPROVAL_TTL_S,
    networkPolicyEnabled: e.NETWORK_POLICY_ENABLED,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    release: { commit: contractPath.releaseCommit, deployment: contractPath.deployment },
    receipts: {
      signingKey: e.RECEIPT_SIGNING_KEY,
      rotationDays: e.RECEIPT_KEY_ROTATION_DAYS,
      anchorIntervalMs: e.ANCHOR_INTERVAL_MS,
    },
    chain: {
      id: e.CHAIN_ID,
      rpcUrl: e.RHC_RPC_URL,
      publicRpcUrl: e.PUBLIC_RPC_URL,
      explorerUrl: e.EXPLORER_URL,
      confirmations: e.CHAIN_CONFIRMATIONS,
      startBlock: e.CHAIN_START_BLOCK,
      usdg: e.USDG_ADDRESS as `0x${string}`,
      usdgDomain: { name: e.USDG_EIP712_NAME, version: e.USDG_EIP712_VERSION },
      credits: e.CREDITS_ADDRESS as `0x${string}` | undefined,
      callPay: e.CALLPAY_ADDRESS as `0x${string}` | undefined,
      payWithStock: e.PAYWITHSTOCK_ADDRESS as `0x${string}` | undefined,
      providerBond: e.PROVIDER_BOND_ADDRESS as `0x${string}` | undefined,
      receiptAnchor: e.RECEIPT_ANCHOR_ADDRESS as `0x${string}` | undefined,
      royalty: e.ROYALTY_ADDRESS as `0x${string}` | undefined,
      staking: e.ANYR_STAKING_ADDRESS as `0x${string}` | undefined,
      paymaster: e.PAYMASTER_ADDRESS as `0x${string}` | undefined,
      callPayTreasury: e.CALLPAY_TREASURY as `0x${string}` | undefined,
      routerKey: e.ROUTER_PRIVATE_KEY as `0x${string}` | undefined,
      settlementKey: e.SETTLEMENT_PRIVATE_KEY as `0x${string}` | undefined,
      anchorerKey: e.ANCHORER_PRIVATE_KEY as `0x${string}` | undefined,
      paymasterSignerKey: e.PAYMASTER_SIGNER_KEY as `0x${string}` | undefined,
      slasherKey: e.SLASHER_PRIVATE_KEY as `0x${string}` | undefined,
      keeperKey: e.KEEPER_PRIVATE_KEY as `0x${string}` | undefined,
      ipxKeeperKey: e.IPX_KEEPER_PRIVATE_KEY as `0x${string}` | undefined,
      faucetKey: (e.DEV_FAUCET ? e.DEV_FAUCET_PRIVATE_KEY : undefined) as `0x${string}` | undefined,
      poolManager: e.V4_POOL_MANAGER as `0x${string}`,
    },
    fees: {
      perCallMarginBps: e.PER_CALL_MARGIN_BPS,
      providerFeeBps: e.PROVIDER_FEE_BPS,
      byokFeeBps: e.BYOK_FEE_BPS,
      defaultRoyaltyBps: e.DEFAULT_ROYALTY_BPS,
      quoteTtlS: e.PER_CALL_QUOTE_TTL_S,
      perCallMaxUsd: e.PER_CALL_MAX_USD,
      paymentWaitMs: e.PAYMENT_WAIT_MS,
    },
    x402: { payTo: e.X402_PAY_TO?.toLowerCase() as `0x${string}` | undefined, network: e.X402_NETWORK },
    paywith: {
      thresholdUsd: e.PAYWITH_THRESHOLD_USD,
      maxAgeH: e.PAYWITH_MAX_AGE_H,
      maxDebtUsd: e.PAYWITH_MAX_DEBT_USD,
      maxSlipBps: e.PAYWITH_MAX_SLIP_BPS,
      capHaircutBps: e.PAYWITH_CAP_HAIRCUT_BPS,
      maxDailyCapUsd: contractPath.maxDailyCapUsd,
      tokens: paywithTokens,
    },
    escrow: {
      mode: e.PAYMENTS_MODE,
      address: e.ESCROW_ADDRESS?.toLowerCase() as `0x${string}` | undefined,
      tokens: escrowTokens,
      haircutBps: e.ESCROW_HAIRCUT_BPS,
      maxPriceAgeS: e.ESCROW_MAX_PRICE_AGE_S,
      startBlock: e.ESCROW_START_BLOCK ?? e.CHAIN_START_BLOCK,
      finality: e.ESCROW_FINALITY,
      reorgHorizonBlocks: e.ESCROW_REORG_HORIZON_BLOCKS,
    },
    anyrEscrow, // null unless ANYR_TOKEN_ADDRESS is set
    routing: {
      outageWindowMs: e.OUTAGE_WINDOW_MS,
      probeIntervalMs: e.HEALTH_PROBE_INTERVAL_MS,
      probes: e.HEALTH_PROBES,
      providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
      firstTokenTimeoutMs: e.FIRST_TOKEN_TIMEOUT_MS,
      maxAttempts: e.MAX_PROVIDER_ATTEMPTS,
      empty200SlashThreshold: e.EMPTY200_SLASH_THRESHOLD,
      uptimeSlashThreshold: e.UPTIME_SLASH_THRESHOLD,
      attestedBonus: { public: e.ATTESTED_BONUS_PUBLIC, attested: e.ATTESTED_BONUS_ATTESTED, unlinkable: e.ATTESTED_BONUS_UNLINKABLE },
    },
    canaries: { intervalMs: e.CANARY_INTERVAL_MS, enabled: e.CANARIES, shadowDays: e.SHADOW_DAYS },
    buyback: {
      legs: e.ANYR_POOL_LEGS ? (JSON.parse(e.ANYR_POOL_LEGS) as import("./chain/twap.ts").Leg[]) : null,
      oracle: e.BUYBACK_ORACLE_ADDRESS && !/^0x0{40}$/.test(e.BUYBACK_ORACLE_ADDRESS) ? (e.BUYBACK_ORACLE_ADDRESS.toLowerCase() as `0x${string}`) : null,
      twapMinutes: e.BUYBACK_TWAP_MINUTES,
      maxDeviation: e.BUYBACK_MAX_DEVIATION,
      slippageBps: e.BUYBACK_SLIPPAGE_BPS,
      maxPerRunUsd: e.BUYBACK_MAX_PER_RUN_USD,
    },
    hfBaseUrl: e.HF_BASE_URL.replace(/\/$/, ""),
    webDir: e.WEB_DIR,
    status: {
      targets: { public: e.STATUS_SLO_PUBLIC, attested: e.STATUS_SLO_ATTESTED, unlinkable: e.STATUS_SLO_UNLINKABLE },
      suggestMinRequests: e.STATUS_SUGGEST_MIN_REQUESTS,
    },
    attestation: {
      intervalMs: e.ATTESTATION_INTERVAL_MS,
      historyDays: e.ATTESTATION_HISTORY_DAYS,
      allowDev: e.ALLOW_DEV_ATTESTATION && !production,
      nrasUrl: e.NVIDIA_NRAS_URL,
      tdxVerifierUrl: e.TDX_VERIFIER_URL,
      tdxVerifierKey: e.TDX_VERIFIER_KEY,
      verifiers: verifierNames as ("dcap" | "intel-ta" | "dstack" | "phala")[],
      intelTa: { url: e.INTEL_TA_URL, jwksUrl: e.INTEL_TA_JWKS_URL, apiKey: e.INTEL_TA_API_KEY },
      dstackVerifierUrl: e.DSTACK_VERIFIER_URL,
      dstackVerifierKey: e.DSTACK_VERIFIER_KEY,
      phalaVerifierUrl: e.PHALA_VERIFIER_URL,
    },
    measurements: {
      enabled: e.MEASUREMENTS_ENABLED,
      intervalMs: e.MEASUREMENTS_INTERVAL_MS,
      rekorUrl: e.REKOR_URL.replace(/\/$/, ""),
      rekorPublicKey: e.REKOR_PUBLIC_KEY?.replace(/\\n/g, "\n").trim(),
      publicKey: measurementPublicKey(e.MEASUREMENT_PUBLIC_KEY),
      registry: e.MEASUREMENT_REGISTRY_ADDRESS && !/^0x0{40}$/.test(e.MEASUREMENT_REGISTRY_ADDRESS) ? (e.MEASUREMENT_REGISTRY_ADDRESS.toLowerCase() as `0x${string}`) : null,
    },
    lane: laneSettings(e),
    workers: {
      enabled: e.WORKERS && e.RUNTIME_ROLE !== "api",
      settlementIntervalMs: e.SETTLEMENT_INTERVAL_MS,
      registryIntervalMs: e.PROVIDER_REGISTRY_INTERVAL_MS,
      providersFile: e.PROVIDERS_FILE,
    },
    gateway: {
      otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      otelServiceName: e.OTEL_SERVICE_NAME,
      cacheTtlS: e.CACHE_TTL_S,
      semanticThreshold: e.SEMANTIC_CACHE_THRESHOLD,
      semanticEmbeddingModel: e.SEMANTIC_CACHE_EMBEDDING_MODEL,
    },
    anthropic: { modelMap: parseModelMap(e.ANTHROPIC_MODEL_MAP) },
    // Off unless enabled. Council members and the judge are billed and receipted like any other call.
    structuredOutputCheckEnabled: e.STRUCTURED_OUTPUT_CHECK_ENABLED, // V83
    features: { council: e.ANYROUTE_FEATURE_COUNCIL },
    council: { models: councilModels, judge: e.ANYROUTE_COUNCIL_JUDGE ?? null, mode: e.ANYROUTE_COUNCIL_MODE },
    rag: { maxDocuments: e.RAG_MAX_DOCUMENTS, maxBytes: e.RAG_MAX_BYTES, maxChunks: e.RAG_MAX_CHUNKS, maxEmbeddingCalls: e.RAG_MAX_EMBEDDING_CALLS },
    batch: {
      discountBps: e.BATCH_DISCOUNT_BPS,
      maxLines: e.BATCH_MAX_LINES,
      maxBytes: e.BATCH_MAX_BYTES,
      maxActive: e.BATCH_MAX_ACTIVE,
      resultsTtlS: e.BATCH_RESULTS_TTL,
      intervalMs: e.BATCH_INTERVAL_MS,
      linesPerTick: e.BATCH_LINES_PER_TICK,
      concurrency: Math.max(1, e.BATCH_CONCURRENCY),
      maxAttempts: Math.max(1, e.BATCH_LINE_MAX_ATTEMPTS),
    },
    skills: skillsSettings(e, production),
    limits: { defaultRpm: e.DEFAULT_RPM, defaultTpm: e.DEFAULT_TPM, unauthRpm: e.UNAUTH_RPM, newKeysPerHour: e.NEW_KEYS_PER_HOUR },
    alerts: { webhookUrl: e.ALERT_WEBHOOK_URL, webhookFormat: e.ALERT_WEBHOOK_FORMAT },
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, linkingEnabled: e.TELEGRAM_LINKING_ENABLED },
    backup: { required: e.BACKUP_REQUIRED, maxAgeHours: e.BACKUP_MAX_AGE_HOURS },
    holders,
    ipx: ipxSettings(e),
    blind: blindSettings(e),
    ohttp: ohttpSettings(e, production),
    onion: onionSettings(e),
    unlinkable: unlinkableSettings(e),
    hostAnchor: hostAnchorSettings(e),
    tlog: tlogSettings(e, production),
  };
}

function onionSettings(e: Env) {
  const secrets = parseOnionSecrets(e.ONION_PROXY_SECRET);
  const address = e.ONION_ADDRESS ? parseOnionAddress(e.ONION_ADDRESS) : null;
  if (address && !secrets.length) throw new Error("ONION_ADDRESS requires ONION_PROXY_SECRET, the secret the onion proxy sends, so requests that arrive over Tor are not limited as one client.");
  if (!Number.isInteger(e.ONION_POOL_MULTIPLIER) || e.ONION_POOL_MULTIPLIER < 1 || e.ONION_POOL_MULTIPLIER > 1000) throw new Error("ONION_POOL_MULTIPLIER must be an integer from 1 to 1000.");
  return { address, secrets, poolMultiplier: e.ONION_POOL_MULTIPLIER };
}

/**
 * UNLINKABLE_VIA_ONION: the second way this router serves lane "unlinkable". The network-privacy part comes from Tor
 * instead of an independent Oblivious HTTP relay, so the switch needs the onion service this router trusts to mark its
 * requests (ONION_ADDRESS, and the ONION_PROXY_SECRET that address already requires) and blind tokens, the lane's only
 * payment. It changes nothing about OHTTP_ENABLED or its relay-operator guard; either one makes the lane available.
 */
function unlinkableSettings(e: Env) {
  if (!e.UNLINKABLE_VIA_ONION) return { viaOnion: false as boolean };
  if (!e.ONION_ADDRESS || !parseOnionSecrets(e.ONION_PROXY_SECRET).length)
    throw new Error("UNLINKABLE_VIA_ONION requires ONION_ADDRESS and ONION_PROXY_SECRET: lane unlinkable is served over Tor only to requests this router's own onion service (deploy/onion) forwarded and marked with the secret.");
  if (!e.ANYROUTE_FEATURE_BLIND) throw new Error("UNLINKABLE_VIA_ONION requires ANYROUTE_FEATURE_BLIND=true: the unlinkable lane is paid with blind tokens.");
  return { viaOnion: true as boolean };
}

// ---- Per-host anchoring of enclave receipts (services/host-anchor.ts) ---------------------------------------
function hostAnchorSettings(e: Env) {
  if (!Number.isInteger(e.HOST_ANCHOR_INTERVAL_MS) || e.HOST_ANCHOR_INTERVAL_MS < 60_000) throw new Error("HOST_ANCHOR_INTERVAL_MS must be at least 60000.");
  let tokens: Record<string, string> = {};
  if (e.HOST_ANCHOR_TOKENS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.HOST_ANCHOR_TOKENS);
    } catch {
      throw new Error("HOST_ANCHOR_TOKENS must be a JSON object of provider id to anchor token.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("HOST_ANCHOR_TOKENS must be a JSON object of provider id to anchor token.");
    for (const [id, token] of Object.entries(parsed)) if (!id || typeof token !== "string" || !token.trim() || /\s/.test(token)) throw new Error(`HOST_ANCHOR_TOKENS has no usable token for "${id}".`);
    tokens = parsed as Record<string, string>;
  }
  return { enabled: e.HOST_ANCHOR_ENABLED, intervalMs: e.HOST_ANCHOR_INTERVAL_MS, tokens };
}

// ---- Transparency log --------------------------------------------------------------------------------------------
export type SkillSource = { kind: "git"; url: string; ref?: string; paths?: string[] } | { kind: "index"; url: string };
const skillSourceSchema = z.array(
  z.union([
    z.object({ kind: z.literal("git"), url: z.string().min(1).max(512), ref: z.string().max(128).optional(), paths: z.array(z.string().max(255)).max(200).optional() }).strict(),
    z.object({ kind: z.literal("index"), url: z.string().url().max(512) }).strict(),
  ]),
).max(50);

function skillsSettings(e: Env, production: boolean) {
  let sources: SkillSource[] = [];
  if (e.SKILLS_SOURCES?.trim()) {
    try {
      sources = skillSourceSchema.parse(JSON.parse(e.SKILLS_SOURCES)) as SkillSource[];
    } catch {
      throw new Error("SKILLS_SOURCES must be a JSON array of { kind: git, url, ref?, paths? } or { kind: index, url } sources.");
    }
  }
  const levels = e.SKILLS_DOWNLOAD_LEVELS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!levels.length || levels.some((l) => !["trusted", "caution", "dangerous"].includes(l))) throw new Error("SKILLS_DOWNLOAD_LEVELS lists trusted, caution and/or dangerous.");
  return {
    maxBytes: e.SKILLS_MAX_BYTES,
    maxFiles: e.SKILLS_MAX_FILES,
    extraHosts: (e.SKILLS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    downloadLevels: levels as ("trusted" | "caution" | "dangerous")[],
    feeBps: e.SKILLS_FEE_BPS,
    gitTimeoutMs: e.SKILLS_GIT_TIMEOUT_MS,
    allowLocalGit: e.SKILLS_ALLOW_LOCAL_GIT && !production,
    sources,
    mirrorIntervalMs: Math.max(60_000, e.SKILLS_MIRROR_INTERVAL_MS),
  };
}

function tlogSettings(e: Env, production: boolean) {
  if (e.TLOG_REKOR_ENABLED && !e.TLOG_ENABLED) throw new Error("TLOG_REKOR_ENABLED needs TLOG_ENABLED: it records the transparency log's checkpoints in Rekor.");
  if (e.TLOG_DATA_INVENTORY && !e.TLOG_ENABLED) throw new Error("TLOG_DATA_INVENTORY needs TLOG_ENABLED: it appends the data inventory's hash to the transparency log.");
  if (!e.TLOG_ENABLED) return { enabled: false as boolean, dataInventory: false as boolean, origin: "", signingKey: Buffer.alloc(0), witnesses: [] as NoteVerifier[], quorum: e.TLOG_WITNESS_QUORUM, intervalMs: e.TLOG_INTERVAL_MS, cosignRpm: e.TLOG_COSIGN_RPM, rekor: tlogRekorSettings(e, production) };
  let origin = e.TLOG_ORIGIN?.trim() ?? "";
  let seed: Buffer | null = null;
  let pkcs8: Buffer | null = null;
  if (e.TLOG_SIGNING_KEY) {
    const raw = e.TLOG_SIGNING_KEY.trim();
    if (raw.startsWith("PRIVATE+KEY+")) {
      let parsed: { name: string; seed: Buffer };
      try {
        parsed = parseSignerKey(raw);
      } catch (err) {
        throw new Error(`TLOG_SIGNING_KEY: ${(err as Error).message}.`);
      }
      if (origin && parsed.name !== origin) throw new Error("TLOG_SIGNING_KEY names a different log than TLOG_ORIGIN.");
      origin = parsed.name;
      seed = parsed.seed;
    } else {
      pkcs8 = Buffer.from(raw, "base64");
      try {
        if (createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }).asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
      } catch {
        throw new Error("TLOG_SIGNING_KEY must be an Ed25519 key: base64 PKCS#8 or PRIVATE+KEY+<origin>+<id>+<key>.");
      }
    }
  }
  if (!origin) {
    let host = "localhost";
    try {
      host = new URL(e.PUBLIC_BASE_URL).host || host;
    } catch {
      /* the default stands outside production */
    }
    origin = `${host}/tlog`;
  }
  if (!validKeyName(origin)) throw new Error("TLOG_ORIGIN must be non-empty and contain no spaces or '+'.");
  const witnesses: NoteVerifier[] = [];
  for (const v of (e.TLOG_WITNESSES ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
    let w: NoteVerifier;
    try {
      w = parseVerifierKey(v);
    } catch (err) {
      throw new Error(`TLOG_WITNESSES: ${(err as Error).message}.`);
    }
    if (w.type !== SIG_COSIGNATURE_V1) throw new Error(`TLOG_WITNESSES: the key of ${w.name} must be a cosignature/v1 (0x04) key.`);
    if (witnesses.some((x) => x.name === w.name || x.publicKey.equals(w.publicKey))) throw new Error("TLOG_WITNESSES lists a witness twice.");
    if (w.name === origin) throw new Error("TLOG_WITNESSES must not list the log itself.");
    witnesses.push(w);
  }
  if (witnesses.length > 32) throw new Error("TLOG_WITNESSES lists more than 32 witnesses.");
  if (e.TLOG_WITNESS_QUORUM < 1 || e.TLOG_WITNESS_QUORUM > 32) throw new Error("TLOG_WITNESS_QUORUM must be between 1 and 32.");
  if (e.TLOG_INTERVAL_MS < 1_000) throw new Error("TLOG_INTERVAL_MS must be at least 1000.");
  if (e.TLOG_COSIGN_RPM < 1) throw new Error("TLOG_COSIGN_RPM must be at least 1.");
  const rekor = tlogRekorSettings(e, production);
  if (production) {
    if (!e.TLOG_SIGNING_KEY) throw new Error("TLOG_ENABLED requires TLOG_SIGNING_KEY in production: the log's key is its identity and must not change.");
    // Someone other than the log must be able to see every checkpoint it signs: cosigning witnesses, or Rekor anchoring.
    if (witnesses.length < e.TLOG_WITNESS_QUORUM && !rekor.enabled)
      throw new Error("TLOG_ENABLED in production needs an independent check of its checkpoints: at least TLOG_WITNESS_QUORUM witnesses in TLOG_WITNESSES, or public-log anchoring with TLOG_REKOR_ENABLED and TLOG_REKOR_SIGNING_KEY.");
  }
  // Outside production a log with no configured key signs with one derived from APP_SECRET, so it keeps its identity
  // across restarts. Production refuses to start without TLOG_SIGNING_KEY (above).
  if (!seed && !pkcs8) seed = createHmac("sha256", e.APP_SECRET ?? "dev-insecure-secret-change-me-dev-insecure").update("anyroute-tlog-signing-key/v1").digest();
  return {
    enabled: true as boolean,
    dataInventory: e.TLOG_DATA_INVENTORY as boolean,
    origin,
    /** A 32-byte Ed25519 seed or a PKCS#8 key. */
    signingKey: (seed ?? pkcs8)!,
    witnesses,
    quorum: e.TLOG_WITNESS_QUORUM,
    intervalMs: e.TLOG_INTERVAL_MS,
    cosignRpm: e.TLOG_COSIGN_RPM,
    rekor,
  };
}

/** Rekor anchoring of the log's checkpoints (src/tlog/rekor.ts). Checked only when TLOG_REKOR_ENABLED is on. */
function tlogRekorSettings(e: Env, production: boolean) {
  const url = e.REKOR_URL.replace(/\/+$/, "");
  const rekorPublicKey = e.REKOR_PUBLIC_KEY?.replace(/\\n/g, "\n").trim() || null;
  const off = { enabled: false as boolean, url, rekorPublicKey, minIntervalMs: e.TLOG_REKOR_MIN_INTERVAL_MS, signingKey: null as KeyObject | null };
  if (!e.TLOG_REKOR_ENABLED) return off;
  if (!e.TLOG_REKOR_SIGNING_KEY) throw new Error("TLOG_REKOR_ENABLED requires TLOG_REKOR_SIGNING_KEY: a dedicated ECDSA P-256 private key that signs the Rekor entries.");
  const p256 = (k: KeyObject) => k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1";
  let signingKey: KeyObject;
  try {
    const src = e.TLOG_REKOR_SIGNING_KEY.replace(/\\n/g, "\n").trim();
    signingKey = src.includes("BEGIN") ? createPrivateKey(src) : createPrivateKey({ key: Buffer.from(src, "base64"), format: "der", type: "pkcs8" });
    if (!p256(signingKey)) throw new Error("not P-256");
  } catch {
    throw new Error("TLOG_REKOR_SIGNING_KEY must be an ECDSA P-256 private key: a PKCS#8 or SEC1 PEM, or base64 PKCS#8.");
  }
  const publicPem = createPublicKey(signingKey).export({ type: "spki", format: "pem" }).toString();
  if (e.MEASUREMENT_PUBLIC_KEY && measurementPublicKey(e.MEASUREMENT_PUBLIC_KEY) === publicPem) throw new Error("TLOG_REKOR_SIGNING_KEY must be its own key, not the measurement key.");
  if (!Number.isInteger(e.TLOG_REKOR_MIN_INTERVAL_MS) || e.TLOG_REKOR_MIN_INTERVAL_MS < 60_000) throw new Error("TLOG_REKOR_MIN_INTERVAL_MS must be at least 60000.");
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error("REKOR_URL must be an http(s) URL.");
  if (production && !url.startsWith("https://")) throw new Error("REKOR_URL must be https in production.");
  if (rekorPublicKey) {
    let ok = false;
    try {
      ok = p256(createPublicKey(rekorPublicKey));
    } catch {
      /* refused below */
    }
    if (!ok) throw new Error("REKOR_PUBLIC_KEY must be the Rekor log's ECDSA P-256 public key (PEM).");
  }
  return { ...off, enabled: true as boolean, signingKey };
}

// ---- The Lane -------------------------------------------------------------------------------------------
const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

function laneSettings(e: Env) {
  const baseModels = [...new Set(csv(e.DAYZERO_BASE_MODELS))];
  const bad = baseModels.find((b) => !REPO_ID.test(b));
  if (bad) throw new Error("DAYZERO_BASE_MODELS must be a comma list of Hugging Face repository ids (owner/name).");
  if (e.DAYZERO_ENABLED && !baseModels.length) throw new Error("DAYZERO_ENABLED needs DAYZERO_BASE_MODELS: the base models whose derivatives are watched.");
  const licenses = [...new Set(csv(e.DAYZERO_LICENSES).map((l) => l.toLowerCase()))];
  if (!licenses.length) throw new Error("DAYZERO_LICENSES must list at least one license.");
  const keywords = [...new Set(csv(e.DAYZERO_KEYWORDS).map((k) => k.toLowerCase()))];
  if (!keywords.length) throw new Error("DAYZERO_KEYWORDS must list at least one keyword.");
  for (const [name, v] of Object.entries({ DAYZERO_MAX_REFUSAL_RATE: e.DAYZERO_MAX_REFUSAL_RATE, DAYZERO_MIN_CAPABILITY: e.DAYZERO_MIN_CAPABILITY, DAYZERO_MIN_CANARY: e.DAYZERO_MIN_CANARY }))
    if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be between 0 and 1.`);
  if (e.DAYZERO_INTERVAL_MS < 60_000) throw new Error("DAYZERO_INTERVAL_MS must be at least 60000.");
  if (e.DAYZERO_MAX_PER_RUN < 1 || e.DAYZERO_MAX_PER_RUN > 200) throw new Error("DAYZERO_MAX_PER_RUN must be between 1 and 200.");
  if (e.LANE_CLAIM_TTL_S < 60) throw new Error("LANE_CLAIM_TTL_S must be at least 60.");
  if (!/^[\w.-][\w.-]{0,127}$/.test(e.LANE_CLAIM_FILE)) throw new Error("LANE_CLAIM_FILE must be a plain file name.");
  return {
    dayzero: {
      enabled: e.DAYZERO_ENABLED,
      intervalMs: e.DAYZERO_INTERVAL_MS,
      baseModels,
      licenses,
      keywords,
      maxPerRun: e.DAYZERO_MAX_PER_RUN,
      maxRefusalRate: e.DAYZERO_MAX_REFUSAL_RATE,
      minCapability: e.DAYZERO_MIN_CAPABILITY,
      minCanary: e.DAYZERO_MIN_CANARY,
    },
    claim: { ttlS: e.LANE_CLAIM_TTL_S, file: e.LANE_CLAIM_FILE },
  };
}

// ---- IPX ---------------------------------------------------------------------------------------
export type IpxClass = { id: string; models: string[] };
const IPX_CLASS_ID = /^IPX-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const IPX_DEFAULT_CLASSES: Record<string, string[]> = { "IPX-OPEN-70B": ["meta-llama/llama-3.3-70b-instruct"] };

function ipxSettings(e: Env) {
  let raw: unknown = IPX_DEFAULT_CLASSES;
  if (e.IPX_CLASSES) {
    try {
      raw = JSON.parse(e.IPX_CLASSES);
    } catch {
      throw new Error("IPX_CLASSES must be a JSON object of class id to model ids.");
    }
  }
  const parsed = z.record(z.string(), z.array(z.string().trim().min(1).max(200)).min(1).max(500)).refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 20, "1 to 20 classes").safeParse(raw);
  if (!parsed.success) throw new Error(`IPX_CLASSES must be a JSON object of class id to model ids: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const classes: IpxClass[] = Object.entries(parsed.data).map(([id, models]) => ({ id: id.toUpperCase(), models: [...new Set(models.map((m) => m.toLowerCase()))] }));
  const bad = classes.find((c) => !IPX_CLASS_ID.test(c.id) || c.id.length > 32);
  if (bad) throw new Error(`IPX_CLASSES: "${bad.id}" is not a valid class id (IPX-<UPPERCASE-OR-DIGITS>, at most 32 characters).`);
  if (new Set(classes.map((c) => c.id)).size !== classes.length) throw new Error("IPX_CLASSES: class ids must be unique.");
  const seen = new Map<string, string>();
  for (const c of classes)
    for (const m of c.models) {
      if (seen.has(m)) throw new Error(`IPX_CLASSES: model ${m} is in both ${seen.get(m)} and ${c.id}.`);
      seen.set(m, c.id);
    }
  if (e.IPX_MAX_ACCOUNT_SHARE_BPS < 1 || e.IPX_MAX_ACCOUNT_SHARE_BPS > 10_000) throw new Error("IPX_MAX_ACCOUNT_SHARE_BPS must be between 1 and 10000.");
  const [whole, frac = ""] = e.IPX_THIN_USDG.split(".");
  return {
    enabled: e.IPX_ENABLED,
    classes,
    /** Trailing-24h volume (USDG base units, 6 decimals) below which a class is THIN. */
    thinUsdg: BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0")),
    maxAccountShareBps: e.IPX_MAX_ACCOUNT_SHARE_BPS,
    attestedOnly: e.IPX_ATTESTED_ONLY,
    oracle: ipxOracleSettings(e, classes),
  };
}

export type IpxOraclePublisherName = "onchain" | "https";
const IPX_ORACLE_PUBLISHERS: IpxOraclePublisherName[] = ["onchain", "https"];

function ipxOracleSettings(e: Env, classes: IpxClass[]) {
  const ids = new Set(classes.map((c) => c.id));
  const publishers = (e.IPX_ORACLE_PUBLISHERS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const bad = publishers.find((p) => !IPX_ORACLE_PUBLISHERS.includes(p as IpxOraclePublisherName));
  if (bad) throw new Error(`IPX_ORACLE_PUBLISHERS: "${bad.slice(0, 20)}" is not a publisher (use ${IPX_ORACLE_PUBLISHERS.join(", ")}).`);
  if (new Set(publishers).size !== publishers.length) throw new Error("IPX_ORACLE_PUBLISHERS lists a publisher twice.");
  const listed = (e.IPX_ORACLE_CLASSES ?? "").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
  const unknown = listed.find((c) => !ids.has(c));
  if (unknown) throw new Error(`IPX_ORACLE_CLASSES: ${unknown.slice(0, 40)} is not one of IPX_CLASSES.`);
  const oracleClasses = listed.length ? [...new Set(listed)] : classes.map((c) => c.id);
  let feeds: Record<string, `0x${string}`> = {};
  if (e.IPX_ORACLE_FEEDS) {
    let raw: unknown;
    try {
      raw = JSON.parse(e.IPX_ORACLE_FEEDS);
    } catch {
      throw new Error("IPX_ORACLE_FEEDS must be a JSON object of class id to feed address.");
    }
    const parsed = z.record(z.string(), z.string().regex(/^0x[0-9a-fA-F]{40}$/)).safeParse(raw);
    if (!parsed.success) throw new Error("IPX_ORACLE_FEEDS must be a JSON object of class id to feed address.");
    feeds = Object.fromEntries(Object.entries(parsed.data).map(([k, v]) => [k.toUpperCase(), v as `0x${string}`]));
    const stray = Object.keys(feeds).find((k) => !oracleClasses.includes(k));
    if (stray) throw new Error(`IPX_ORACLE_FEEDS: ${stray.slice(0, 40)} is not an oracle class.`);
  }
  if (e.IPX_ORACLE_INTERVAL_S < 10 || e.IPX_ORACLE_INTERVAL_S > 3_600) throw new Error("IPX_ORACLE_INTERVAL_S must be between 10 and 3600.");
  if (e.IPX_ORACLE_STALE_AFTER_S < 2 * e.IPX_ORACLE_INTERVAL_S || e.IPX_ORACLE_STALE_AFTER_S > 86_400) throw new Error("IPX_ORACLE_STALE_AFTER_S must be at least twice IPX_ORACLE_INTERVAL_S and at most 86400.");
  if (e.IPX_ORACLE_MAX_MOVE_BPS < 1 || e.IPX_ORACLE_MAX_MOVE_BPS > 10_000) throw new Error("IPX_ORACLE_MAX_MOVE_BPS must be between 1 and 10000.");
  const keyShape = e.IPX_ORACLE_ALGORITHM === "ed25519" ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]{40}$/;
  if (e.IPX_ORACLE_PUBLIC_KEY && !keyShape.test(e.IPX_ORACLE_PUBLIC_KEY)) throw new Error(`IPX_ORACLE_PUBLIC_KEY must be ${e.IPX_ORACLE_ALGORITHM === "ed25519" ? "0x followed by the 32-byte ed25519 public key" : "the secp256k1 signer address"}.`);
  if (e.IPX_ORACLE_ENABLED) {
    if (!e.IPX_ENABLED) throw new Error("IPX_ORACLE_ENABLED requires IPX_ENABLED.");
    if (e.RUNTIME_ROLE !== "api" && !e.IPX_ORACLE_PRIVATE_KEY) throw new Error("IPX_ORACLE_ENABLED requires IPX_ORACLE_PRIVATE_KEY (the public API may hold IPX_ORACLE_PUBLIC_KEY alone).");
    if (publishers.includes("onchain") && !Object.keys(feeds).length) throw new Error("The onchain publisher needs IPX_ORACLE_FEEDS.");
    if (publishers.includes("https") && !e.IPX_ORACLE_PUSH_CONFIG) throw new Error("The https publisher needs IPX_ORACLE_PUSH_CONFIG.");
    if (e.IPX_ORACLE_ONCHAIN_SUBMIT && !(publishers.includes("onchain") && e.IPX_KEEPER_PRIVATE_KEY)) throw new Error("IPX_ORACLE_ONCHAIN_SUBMIT needs the onchain publisher and IPX_KEEPER_PRIVATE_KEY.");
  }
  return {
    enabled: e.IPX_ORACLE_ENABLED,
    algorithm: e.IPX_ORACLE_ALGORITHM,
    privateKey: e.IPX_ORACLE_PRIVATE_KEY as `0x${string}` | undefined,
    publicKey: e.IPX_ORACLE_PUBLIC_KEY?.toLowerCase(),
    classes: oracleClasses,
    intervalS: e.IPX_ORACLE_INTERVAL_S,
    staleAfterS: e.IPX_ORACLE_STALE_AFTER_S,
    maxMoveBps: e.IPX_ORACLE_MAX_MOVE_BPS,
    halted: e.IPX_ORACLE_HALTED,
    publishers: publishers as IpxOraclePublisherName[],
    feeds,
    onchainSubmit: e.IPX_ORACLE_ONCHAIN_SUBMIT,
    pushConfig: e.IPX_ORACLE_PUSH_CONFIG,
  };
}

// ---- Blind tokens --------------------------------------------------------------------------------
export const BLIND_DENOMINATIONS = [1_000, 10_000, 100_000] as const;

function blindSettings(e: Env) {
  let unitPricePico: bigint;
  try {
    unitPricePico = usdToPico(e.BLIND_UNIT_PRICE_USD);
  } catch {
    throw new Error("BLIND_UNIT_PRICE_USD must be a decimal USD amount.");
  }
  if (unitPricePico <= 0n) throw new Error("BLIND_UNIT_PRICE_USD must be positive.");
  if (e.BLIND_EPOCH_SECONDS < 60) throw new Error("BLIND_EPOCH_SECONDS must be at least 60.");
  if (e.BLIND_REDEEM_GRACE_SECONDS < 0) throw new Error("BLIND_REDEEM_GRACE_SECONDS must not be negative.");
  if (e.BLIND_MAX_BATCH < 1 || e.BLIND_MAX_BATCH > 256) throw new Error("BLIND_MAX_BATCH must be between 1 and 256.");
  if (e.BLIND_PURCHASE_RPM < 1) throw new Error("BLIND_PURCHASE_RPM must be at least 1.");
  if (e.BLIND_REDEEM_RPM < 1) throw new Error("BLIND_REDEEM_RPM must be at least 1.");
  if (!(e.BLIND_MAX_USD_PER_DAY > 0)) throw new Error("BLIND_MAX_USD_PER_DAY must be positive.");
  let issuerName = "localhost";
  try {
    issuerName = new URL(e.PUBLIC_BASE_URL).hostname || issuerName;
  } catch {
    /* PUBLIC_BASE_URL is only advisory outside production; the default host name stands */
  }
  return {
    enabled: e.ANYROUTE_FEATURE_BLIND,
    unitPricePico,
    denominations: BLIND_DENOMINATIONS,
    epochSeconds: e.BLIND_EPOCH_SECONDS,
    redeemGraceSeconds: e.BLIND_REDEEM_GRACE_SECONDS,
    multiTokenEnabled: e.BLIND_MULTI_TOKEN_ENABLED, maxTokensPerRequest: e.BLIND_MAX_TOKENS_PER_REQUEST,
    maxBatch: e.BLIND_MAX_BATCH,
    purchaseRpm: e.BLIND_PURCHASE_RPM,
    redeemRpm: e.BLIND_REDEEM_RPM,
    maxUsdPerDay: e.BLIND_MAX_USD_PER_DAY,
    issuerName,
  };
}

// ---- Oblivious HTTP ------------------------------------------------------------------------------
export type RelayOperator = { operator: string; url: string; keyId: string; secretSha256: string };

const noControls = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);
const relayEntry = z
  .object({
    operator: z.string().trim().min(1).max(80).refine(noControls, "must not contain control characters"),
    url: z.string().trim().min(8).max(300),
    key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "must be 1 to 64 letters, digits, dots, dashes or underscores"),
    secret_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be the hex SHA-256 of the secret the relay presents"),
  })
  .strict();

function ohttpSettings(e: Env, production: boolean) {
  const off = {
    enabled: false as boolean,
    keyEpochSeconds: e.OHTTP_KEY_EPOCH_SECONDS,
    keyGraceSeconds: e.OHTTP_KEY_GRACE_SECONDS,
    maxRequestBytes: e.OHTTP_MAX_REQUEST_BYTES,
    maxResponseBytes: e.OHTTP_MAX_RESPONSE_BYTES,
    relayRpm: e.OHTTP_RELAY_RPM,
    directRpm: e.OHTTP_DIRECT_RPM,
    padBytes: e.OHTTP_PAD_BYTES,
    gatewayOperator: e.OHTTP_GATEWAY_OPERATOR.trim() || "AnyRoute",
    minRelayOperators: e.OHTTP_MIN_RELAY_OPERATORS,
    chunked: false as boolean,
    relays: [] as RelayOperator[],
  };
  if (!e.OHTTP_ENABLED) return off;
  if (!e.ANYROUTE_FEATURE_BLIND) throw new Error("OHTTP_ENABLED requires ANYROUTE_FEATURE_BLIND=true: the unlinkable lane is paid with blind tokens.");
  if (e.OHTTP_KEY_EPOCH_SECONDS < 60) throw new Error("OHTTP_KEY_EPOCH_SECONDS must be at least 60.");
  if (e.OHTTP_KEY_GRACE_SECONDS < 0 || e.OHTTP_KEY_GRACE_SECONDS > 100 * e.OHTTP_KEY_EPOCH_SECONDS) throw new Error("OHTTP_KEY_GRACE_SECONDS must be between 0 and 100 epochs (key identifiers are 8 bits and repeat every 256 epochs).");
  if (e.OHTTP_MAX_REQUEST_BYTES < 1024 || e.OHTTP_MAX_REQUEST_BYTES > 64 * 1024 * 1024) throw new Error("OHTTP_MAX_REQUEST_BYTES must be between 1 KiB and 64 MiB.");
  if (e.OHTTP_MAX_RESPONSE_BYTES < 1024 || e.OHTTP_MAX_RESPONSE_BYTES > 64 * 1024 * 1024) throw new Error("OHTTP_MAX_RESPONSE_BYTES must be between 1 KiB and 64 MiB.");
  if (e.OHTTP_RELAY_RPM < 1 || e.OHTTP_DIRECT_RPM < 1) throw new Error("OHTTP_RELAY_RPM and OHTTP_DIRECT_RPM must be at least 1.");
  if (e.OHTTP_PAD_BYTES < 0 || e.OHTTP_PAD_BYTES > 65_536) throw new Error("OHTTP_PAD_BYTES must be between 0 and 65536.");
  if (e.OHTTP_MIN_RELAY_OPERATORS < 0) throw new Error("OHTTP_MIN_RELAY_OPERATORS must not be negative.");
  let raw: unknown = [];
  if (e.RELAY_OPERATORS) {
    try {
      raw = JSON.parse(e.RELAY_OPERATORS);
    } catch {
      throw new Error("RELAY_OPERATORS must be a JSON array of {operator,url,key_id,secret_sha256}.");
    }
  }
  const parsed = z.array(relayEntry).max(20).safeParse(raw);
  if (!parsed.success) throw new Error(`RELAY_OPERATORS must be a JSON array of {operator,url,key_id,secret_sha256}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "list"}: ${i.message}`).join("; ")}`);
  const relays: RelayOperator[] = parsed.data.map((r) => {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      throw new Error(`RELAY_OPERATORS: "${r.key_id}" has an invalid url.`);
    }
    if (u.protocol !== "https:" && (production || u.protocol !== "http:")) throw new Error(`RELAY_OPERATORS: the url of "${r.key_id}" must be https.`);
    if (u.username || u.password || u.hash) throw new Error(`RELAY_OPERATORS: the url of "${r.key_id}" must not carry credentials or a fragment.`);
    return { operator: r.operator, url: u.toString(), keyId: r.key_id, secretSha256: r.secret_sha256.toLowerCase() };
  });
  if (new Set(relays.map((r) => r.keyId)).size !== relays.length) throw new Error("RELAY_OPERATORS: key_id values must be unique.");
  if (new Set(relays.map((r) => r.secretSha256)).size !== relays.length) throw new Error("RELAY_OPERATORS: every relay needs its own secret.");
  const gatewayOperator = off.gatewayOperator;
  const others = new Set(relays.filter((r) => r.operator.toLowerCase() !== gatewayOperator.toLowerCase()).map((r) => r.operator.toLowerCase()));
  if (production && others.size < e.OHTTP_MIN_RELAY_OPERATORS)
    throw new Error(`OHTTP_ENABLED in production needs relays from at least ${e.OHTTP_MIN_RELAY_OPERATORS} operators other than "${gatewayOperator}" in RELAY_OPERATORS (found ${others.size}).`);
  return { ...off, enabled: true, chunked: e.OHTTP_CHUNKED_ENABLED, relays };
}

// ---- $ANYR holder perks ------------------------------------------------------------------------
// Tiers are read live from the wallet's token balance; `min` is in whole tokens (a decimal string).
export type HolderTier = { name: string; min: string; rpmMultiplier: number; discountBps: number };
const DECIMAL_TOKENS = /^\d+(\.\d{1,18})?$/;
/** A whole-token decimal string as an integer with 18 fractional digits, for ordering tiers. */
const tokens18 = (v: string) => {
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
};

function holderSettings(e: Env, anyr: AnyrEscrow | null) {
  // The token is the one ANYR_TOKEN_ADDRESS configures for $ANYR escrow payments (null when unset).
  const token = anyr ? { address: anyr.address, symbol: anyr.symbol } : null;
  const exclude = (e.HOLDER_CREDITS_EXCLUDE ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const badExclude = exclude.find((a) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (badExclude) throw new Error("HOLDER_CREDITS_EXCLUDE must be a comma list of 0x addresses.");
  let tiers: HolderTier[] = [];
  if (e.HOLDER_TIERS) {
    const tierList = z
      .array(
        z.object({
          name: z.string().trim().min(1).max(32),
          min: z.union([z.string().regex(DECIMAL_TOKENS, "min must be a token amount like \"100000\""), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).transform(String),
          rpm_multiplier: z.number().min(1).max(100).default(1),
          discount_bps: z.number().int().min(0).max(10_000).default(0),
        }),
      )
      .min(1)
      .max(10);
    try {
      tiers = tierList
        .parse(JSON.parse(e.HOLDER_TIERS))
        .map((t) => ({ name: t.name, min: t.min, rpmMultiplier: t.rpm_multiplier, discountBps: t.discount_bps }))
        .sort((a, b) => (tokens18(a.min) < tokens18(b.min) ? -1 : 1));
    } catch (err) {
      throw new Error(`HOLDER_TIERS must be a JSON array of {name,min,rpm_multiplier,discount_bps}: ${(err as Error).message}`);
    }
    if (tiers.some((t) => tokens18(t.min) === 0n)) throw new Error("HOLDER_TIERS: every tier needs a min above 0.");
    if (new Set(tiers.map((t) => tokens18(t.min))).size !== tiers.length) throw new Error("HOLDER_TIERS: two tiers share the same min.");
    if (new Set(tiers.map((t) => t.name.toLowerCase())).size !== tiers.length) throw new Error("HOLDER_TIERS: tier names must be unique.");
  }
  return {
    token,
    deployBlock: e.ANYR_TOKEN_DEPLOY_BLOCK,
    exclude: exclude.map((a) => a.toLowerCase() as `0x${string}`),
    tiers,
    /** Live tiers (rate limits and fee discounts) run only with both the token and HOLDER_TIERS set. */
    enabled: !!token && tiers.length > 0,
  };
}

export type PaywithToken = { symbol: string; address: string; decimals: number; feed?: string; name?: string };
export type EscrowToken = PaywithToken & { feed: string };

// ---- Pay with $ANYR in escrow ------------------------------------------------------------------
// ANYR has no Chainlink feed, so escrow prices it with the off-chain v4 TWAP the buyback keeper already
// uses (ANYR_POOL_LEGS). The legs must chain from the ANYR token to USDG, or ANYR deposits could be
// priced in the wrong unit; a leg may set `minLiquidity` (raw v4 liquidity) so a thin pool gives no price.
export type AnyrEscrow = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  haircutBps: number;
  maxUsdPerDeposit: number;
  maxDeviation: number;
  legs: import("./chain/twap.ts").Leg[];
};

function anyrEscrowConfig(e: Env, stockAddresses: string[]): AnyrEscrow | null {
  if (!e.ANYR_TOKEN_ADDRESS || /^0x0{40}$/.test(e.ANYR_TOKEN_ADDRESS)) return null;
  const address = e.ANYR_TOKEN_ADDRESS.toLowerCase() as `0x${string}`;
  if (!/^[A-Za-z0-9.$_-]{1,16}$/.test(e.ANYR_TOKEN_SYMBOL)) throw new Error("ANYR_TOKEN_SYMBOL must be 1-16 letters or digits.");
  if (e.ANYR_TOKEN_DECIMALS < 0 || e.ANYR_TOKEN_DECIMALS > 36) throw new Error("ANYR_TOKEN_DECIMALS must be between 0 and 36.");
  if (e.ANYR_ESCROW_HAIRCUT_BPS < 0 || e.ANYR_ESCROW_HAIRCUT_BPS >= 10_000) throw new Error("ANYR_ESCROW_HAIRCUT_BPS must be between 0 and 9999.");
  if (!(e.ANYR_ESCROW_MAX_USD_PER_DEPOSIT > 0) || !Number.isFinite(e.ANYR_ESCROW_MAX_USD_PER_DEPOSIT)) throw new Error("ANYR_ESCROW_MAX_USD_PER_DEPOSIT must be a positive USD amount.");
  const maxDeviation = e.ANYR_ESCROW_MAX_DEVIATION === undefined ? e.BUYBACK_MAX_DEVIATION : Number(e.ANYR_ESCROW_MAX_DEVIATION);
  if (!(maxDeviation > 0 && maxDeviation <= 1)) throw new Error("ANYR_ESCROW_MAX_DEVIATION must be above 0 and at most 1 (100%).");
  if (stockAddresses.includes(address)) throw new Error("ANYR_TOKEN_ADDRESS is also listed in ESCROW_TOKENS.");
  if (!e.ANYR_POOL_LEGS) throw new Error("ANYR_TOKEN_ADDRESS needs ANYR_POOL_LEGS: ANYR deposits are priced from its pools.");
  const hex = /^0x[0-9a-fA-F]{40}$/;
  const leg = z.object({
    key: z.object({ currency0: z.string().regex(hex), currency1: z.string().regex(hex), fee: z.number().int().min(0), tickSpacing: z.number().int(), hooks: z.string().regex(hex) }),
    sign: z.union([z.literal(1), z.literal(-1)]),
    minLiquidity: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).optional(),
  });
  let legs: AnyrEscrow["legs"];
  try {
    legs = z.array(leg).min(1).parse(JSON.parse(e.ANYR_POOL_LEGS)) as AnyrEscrow["legs"];
  } catch (err) {
    throw new Error(`ANYR_POOL_LEGS must be a JSON array of {key:{currency0,currency1,fee,tickSpacing,hooks},sign,minLiquidity?}: ${(err as Error).message.slice(0, 200)}`);
  }
  // Each leg prices its base in its quote (sign 1: currency0 in currency1); the first base must be ANYR
  // and every quote the next leg's base, ending in USDG.
  let at = address as string;
  for (const l of legs) {
    const [base, quote] = l.sign === 1 ? [l.key.currency0, l.key.currency1] : [l.key.currency1, l.key.currency0];
    if (base.toLowerCase() !== at) throw new Error("ANYR_POOL_LEGS must price ANYR_TOKEN_ADDRESS: each leg's base must be ANYR or the previous leg's quote.");
    at = quote.toLowerCase();
  }
  if (at !== e.USDG_ADDRESS?.toLowerCase()) throw new Error("ANYR_POOL_LEGS must end in USDG (USDG_ADDRESS).");
  return { address, symbol: e.ANYR_TOKEN_SYMBOL, decimals: e.ANYR_TOKEN_DECIMALS, haircutBps: e.ANYR_ESCROW_HAIRCUT_BPS, maxUsdPerDeposit: e.ANYR_ESCROW_MAX_USD_PER_DEPOSIT, maxDeviation, legs };
}

// ---- Contract-path launch guards ---------------------------------------------------------------
// H-02: production contract mode moves customer funds through the Anyroute contracts, so it starts
//   only against a deployment that was independently verified: DEPLOYMENT_MANIFEST (written by
//   contracts/script/Deploy.s.sol) must list exactly the configured addresses, and
//   DEPLOYMENT_VERIFICATION must be the passing report of `bun scripts/verify-deployment.ts
//   <manifest> --rpc-url <rpc>` for that manifest (same block, same chain, bytecode found at every
//   manifest address). The report is a point-in-time snapshot: re-run the verifier for every release
//   and whenever ownership or roles change. A disposable fixture whose public origin is on a reserved
//   TLD (.example, .invalid, .test, .localhost; RFC 2606/6761) cannot serve real users or wallet
//   sign-in; it may run without a manifest and reports deployment status "fixture".
// M-05: buybacks stay off until BUYBACK_ORACLE_ADDRESS names the reviewed buyback-floor oracle, and
//   (with a verified deployment) that oracle is the one AnyrStaking reads on-chain.
// M-06: every PayWithStock charge needs the session wallet's EIP-712 signature, either for that charge
//   or as a bounded allowance (<= 7 days, <= $5 per charge, tied to a usage commitment). Within an
//   allowance the router still chooses when to charge, so production requires an explicit
//   PAYWITH_DELEGATION_ACCEPTED and keeps the exposure small: PAYWITH_MAX_DEBT_USD <= $5 and
//   PAYWITH_MAX_DAILY_CAP_USD <= $25.

type Env = z.infer<typeof schema>;
export type DeploymentStatus = {
  status: "none" | "unverified" | "fixture" | "verified";
  manifestSha256: string | null;
  manifestBlock: number | null;
  verifiedAtBlock: string | null;
  verifierRevision: string | null;
};
export const DEPLOYMENT_SCHEMA = "anyroute.deployments/v1";
export const PAYWITH_MAX_DEBT_CEILING_USD = 5;
export const PAYWITH_DAILY_CAP_CEILING_USD = 25;
const RESERVED_TLDS = new Set(["example", "invalid", "test", "localhost"]);
const MANIFEST_CONTRACTS = {
  CREDITS_ADDRESS: "credits",
  CALLPAY_ADDRESS: "callPay",
  PAYWITHSTOCK_ADDRESS: "payWithStock",
  PROVIDER_BOND_ADDRESS: "providerBond",
  RECEIPT_ANCHOR_ADDRESS: "receiptAnchor",
  ROYALTY_ADDRESS: "royalty",
  ANYR_STAKING_ADDRESS: "anyrStaking",
  PAYMASTER_ADDRESS: "paymaster",
} as const;
const sameAddress = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/** A file path or inline JSON; errors never echo the value. */
function readJsonSetting(name: string, value: string): { json: Record<string, any>; sha256: string } {
  let text: string;
  try {
    text = value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8");
  } catch {
    throw new Error(`${name} could not be read.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${name} must be a JSON object.`);
  return { json: json as Record<string, any>, sha256: createHash("sha256").update(text).digest("hex") };
}

function contractPathGuards(e: Env, production: boolean, escrowMode: boolean) {
  if (e.RELEASE_COMMIT && !/^[0-9a-f]{7,40}$/i.test(e.RELEASE_COMMIT)) throw new Error("RELEASE_COMMIT must be a git commit id.");
  const releaseCommit = e.RELEASE_COMMIT?.toLowerCase() ?? null;
  const maxDailyCapUsd = e.PAYWITH_MAX_DAILY_CAP_USD === undefined ? null : Number(e.PAYWITH_MAX_DAILY_CAP_USD);
  if (maxDailyCapUsd !== null && !(maxDailyCapUsd > 0)) throw new Error("PAYWITH_MAX_DAILY_CAP_USD must be a positive USD amount.");
  const configured = (Object.keys(MANIFEST_CONTRACTS) as (keyof typeof MANIFEST_CONTRACTS)[]).filter((name) => e[name]);
  const deployment: DeploymentStatus = { status: escrowMode || !configured.length ? "none" : "unverified", manifestSha256: null, manifestBlock: null, verifiedAtBlock: null, verifierRevision: null };
  const result = { releaseCommit, maxDailyCapUsd, deployment };
  if (!production) return result;

  // M-05: no buyback job or keeper key without an explicit, reviewed buyback-floor oracle.
  const jobs = e.RUNTIME_ROLE === "worker" ? e.WORKER_JOBS.split(",").map((n) => n.trim()) : [];
  const buybacks = jobs.includes("buyback") || !!e.KEEPER_PRIVATE_KEY;
  if (buybacks) {
    if (escrowMode) throw new Error("Buybacks need the Anyroute contracts; PAYMENTS_MODE=escrow must not run the buyback job.");
    if (!e.BUYBACK_ORACLE_ADDRESS || /^0x0{40}$/.test(e.BUYBACK_ORACLE_ADDRESS))
      throw new Error("Buybacks stay disabled until BUYBACK_ORACLE_ADDRESS names the reviewed buyback-floor oracle; otherwise remove the buyback job and KEEPER_PRIVATE_KEY.");
    // The floor is that on-chain oracle's quote; ANYR_POOL_LEGS only adds an optional off-chain second opinion.
    if (!e.ANYR_STAKING_ADDRESS) throw new Error("Buybacks require ANYR_STAKING_ADDRESS.");
  }

  // M-06: PayWithStock delegates router spending up to each session's daily cap.
  if (e.PAYWITHSTOCK_ADDRESS) {
    if (!e.PAYWITH_DELEGATION_ACCEPTED)
      throw new Error("PayWithStock allowances let the router key charge a wallet within its signed allowance (<= 7 days, <= $5 per charge) and daily cap without signing each charge. Set PAYWITH_DELEGATION_ACCEPTED=true only after accepting that bounded exposure.");
    if (!(e.PAYWITH_MAX_DEBT_USD > 0 && e.PAYWITH_MAX_DEBT_USD <= PAYWITH_MAX_DEBT_CEILING_USD)) throw new Error(`PAYWITH_MAX_DEBT_USD must be above 0 and at most ${PAYWITH_MAX_DEBT_CEILING_USD} in production.`);
    if (maxDailyCapUsd === null || maxDailyCapUsd > PAYWITH_DAILY_CAP_CEILING_USD || maxDailyCapUsd < e.PAYWITH_MAX_DEBT_USD)
      throw new Error(`PayWithStock requires PAYWITH_MAX_DAILY_CAP_USD between PAYWITH_MAX_DEBT_USD and ${PAYWITH_DAILY_CAP_CEILING_USD} in production.`);
  }

  // H-02: contract mode runs only against a verified deployment.
  if (escrowMode || !configured.length) return result;
  let host = "";
  try {
    host = new URL(e.PUBLIC_BASE_URL).hostname;
  } catch {
    /* PUBLIC_BASE_URL is validated above */
  }
  if (!e.DEPLOYMENT_MANIFEST) {
    if (RESERVED_TLDS.has(host.split(".").at(-1) ?? "")) {
      deployment.status = "fixture";
      return result;
    }
    throw new Error("Production contract mode requires DEPLOYMENT_MANIFEST (the anyroute.deployments/v1 manifest) and DEPLOYMENT_VERIFICATION (its passing scripts/verify-deployment.ts report).");
  }
  if (!releaseCommit || releaseCommit.length !== 40) throw new Error("Production contract mode requires RELEASE_COMMIT, the full git commit of this build.");

  const { json: manifest, sha256 } = readJsonSetting("DEPLOYMENT_MANIFEST", e.DEPLOYMENT_MANIFEST);
  const refuseManifest = (why: string): never => {
    throw new Error(`DEPLOYMENT_MANIFEST ${why}`);
  };
  const contracts: Record<string, unknown> = manifest.contracts && typeof manifest.contracts === "object" ? manifest.contracts : {};
  if (manifest.schema !== DEPLOYMENT_SCHEMA) refuseManifest(`must use schema ${DEPLOYMENT_SCHEMA}.`);
  if (manifest.mode !== "production") refuseManifest("must describe a production deployment.");
  if (Number(manifest.chainId) !== e.CHAIN_ID) refuseManifest(`is not for chain ${e.CHAIN_ID}.`);
  if (!/^\d+$/.test(String(manifest.blockNumber))) refuseManifest("has no deployment block.");
  for (const [name, key] of [...Object.entries(MANIFEST_CONTRACTS), ["USDG_ADDRESS", "usdg"]] as [keyof Env, string][]) {
    if (e[name] && !sameAddress(e[name], contracts[key])) refuseManifest(`does not list ${name} as its ${key} contract.`);
  }
  if (e.CALLPAY_TREASURY && !sameAddress(e.CALLPAY_TREASURY, manifest.roles?.callPayTreasury)) refuseManifest("does not list CALLPAY_TREASURY as the CallPay treasury.");

  if (!e.DEPLOYMENT_VERIFICATION) throw new Error("Production contract mode requires DEPLOYMENT_VERIFICATION, the passing scripts/verify-deployment.ts report for DEPLOYMENT_MANIFEST.");
  const { json: report } = readJsonSetting("DEPLOYMENT_VERIFICATION", e.DEPLOYMENT_VERIFICATION);
  const refuseReport = (why: string): never => {
    throw new Error(`DEPLOYMENT_VERIFICATION ${why}`);
  };
  const checks: { id?: unknown; status?: unknown; evidence?: any }[] = Array.isArray(report.checks) ? report.checks : [];
  if (report.ok !== true || !checks.length || checks.some((c) => !c || c.status === "fail")) refuseReport("is not a passing verifier report.");
  if (!/^[0-9a-f]{40}$/.test(String(report.verifierRevision))) refuseReport("does not name the verifier's git revision.");
  const certified = report.manifest ?? {};
  if (certified.schema !== DEPLOYMENT_SCHEMA || certified.mode !== "production" || Number(certified.chainId) !== e.CHAIN_ID || Number(certified.blockNumber) !== Number(manifest.blockNumber))
    refuseReport("was produced for a different manifest.");
  const observedBlock = String(report.observed?.blockNumber);
  if (Number(report.observed?.chainId) !== e.CHAIN_ID || !/^\d+$/.test(observedBlock) || BigInt(observedBlock) < BigInt(String(manifest.blockNumber)))
    refuseReport("was not read from this chain after the deployment block.");
  // Bind the report to this manifest: the verifier found runtime bytecode at every manifest address.
  const bytecode = checks.find((c) => c.id === "contracts.bytecode_present");
  const found: Record<string, { address?: unknown; present?: unknown }> = bytecode?.status === "pass" && bytecode.evidence && typeof bytecode.evidence === "object" ? bytecode.evidence : {};
  for (const [key, address] of Object.entries(contracts)) {
    if (typeof address === "string" && /^0x0{40}$/.test(address)) continue;
    if (!sameAddress(found[key]?.address, address) || found[key]?.present !== true) refuseReport(`did not verify the manifest's ${key} contract.`);
  }
  if (buybacks) {
    const oracle = checks.find((c) => c.id === "buybacks.oracle");
    const oracleCode = checks.find((c) => c.id === "buybacks.oracle_code_present");
    if (!sameAddress(oracle?.evidence, e.BUYBACK_ORACLE_ADDRESS) || oracleCode?.status !== "pass")
      throw new Error("BUYBACK_ORACLE_ADDRESS must be the buyback-floor oracle AnyrStaking reads on-chain, as recorded by DEPLOYMENT_VERIFICATION.");
  }
  Object.assign(deployment, { status: "verified", manifestSha256: sha256, manifestBlock: Number(manifest.blockNumber), verifiedAtBlock: observedBlock, verifierRevision: String(report.verifierRevision) });
  return result;
}
