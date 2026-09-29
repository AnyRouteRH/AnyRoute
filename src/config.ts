import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

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

const schema = z.object({
  RUNTIME_ROLE: z.enum(["all", "api", "worker"]).default("all"),
  WORKER_JOBS: z.string().default(""),
  AUTO_MIGRATE: bool.default(true),
  ANYROUTE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787),
  PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:8787"),
  DATABASE_URL: z.string().default("pglite://.data/pglite"),
  REDIS_URL: opt,
  APP_SECRET: opt,
  ADMIN_TOKEN: opt,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: bool.default(false), // true behind exactly one trusted reverse proxy that appends X-Forwarded-For

  // Receipts
  RECEIPT_SIGNING_KEY: opt,
  RECEIPT_KEY_ROTATION_DAYS: num(7),
  ANCHOR_INTERVAL_MS: int(3_600_000),

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

  // Routing / health
  OUTAGE_WINDOW_MS: int(30_000),
  HEALTH_PROBE_INTERVAL_MS: int(15_000),
  HEALTH_PROBES: bool.default(true),
  PROVIDER_TIMEOUT_MS: int(120_000),
  FIRST_TOKEN_TIMEOUT_MS: int(45_000),
  MAX_PROVIDER_ATTEMPTS: int(4),
  EMPTY200_SLASH_THRESHOLD: num(0.02),
  UPTIME_SLASH_THRESHOLD: num(0.95),

  // Canaries
  CANARY_INTERVAL_MS: int(3_600_000),
  CANARIES: bool.default(true),
  SHADOW_DAYS: num(7),

  // Attestation
  ATTESTATION_INTERVAL_MS: int(600_000),
  ALLOW_DEV_ATTESTATION: bool.default(false),
  NVIDIA_NRAS_URL: z.string().default("https://nras.attestation.nvidia.com/v3/attest/gpu"),
  TDX_VERIFIER_URL: opt,
  TDX_VERIFIER_KEY: opt,

  // Workers
  WORKERS: bool.default(true),
  SETTLEMENT_INTERVAL_MS: int(3_600_000),
  PROVIDER_REGISTRY_INTERVAL_MS: int(600_000),
  PROVIDERS_FILE: opt,

  // Gateway features
  OTEL_EXPORTER_OTLP_ENDPOINT: opt,
  OTEL_SERVICE_NAME: z.string().default("anyroute"),
  CACHE_TTL_S: z.coerce.number().int().min(1).default(3600),
  SEMANTIC_CACHE_THRESHOLD: num(0.97),
  SEMANTIC_CACHE_EMBEDDING_MODEL: opt,

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
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, unknown> = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
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
    if (e.RUNTIME_ROLE === "worker") {
      const names = e.WORKER_JOBS.split(",").map((v) => v.trim()).filter(Boolean);
      const allowed = ["health-flush", "holds-expire", "catalog-refresh", "provider-registry", "health-probes", "canaries", "attestor", "receipts-anchor", "receipt-key-rotation", "settlement", "slasher", "buyback", "chain-indexer", "paywith-aggregator", "escrow-indexer", "spend-watch", "alert-notifier"];
      if (!names.length || names.some((n) => !allowed.includes(n))) throw new Error("Worker requires an explicit valid WORKER_JOBS list.");
      const keyJobs = { settlement: "settlement", anchoring: "receipts-anchor", slashing: "slasher", buyback: "buyback" };
      if (Object.values(roleKeys).filter(Boolean).length > 1) throw new Error("Privileged worker signing roles must be isolated.");
      if (!escrowMode)
        for (const [role, key] of Object.entries(roleKeys)) {
          const enabled = names.includes(keyJobs[role as keyof typeof keyJobs]);
          if (enabled !== !!key) throw new Error(`Worker ${role} job and signing-key configuration must match.`);
        }
    }
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
  // The webhook is optional: without it the alert-notifier job only records state. Never echo the URL.
  if (e.ALERT_WEBHOOK_URL) {
    let protocol = "";
    try { protocol = new URL(e.ALERT_WEBHOOK_URL).protocol; } catch { /* reported below */ }
    if (protocol !== "https:" && (production || protocol !== "http:")) throw new Error("ALERT_WEBHOOK_URL must be an https URL.");
  }
  if (!(e.BACKUP_MAX_AGE_HOURS > 0)) throw new Error("BACKUP_MAX_AGE_HOURS must be positive.");
  if (e.PER_CALL_MARGIN_BPS > 100) throw new Error("PER_CALL_MARGIN_BPS must be <= 100 (1%).");
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
  return {
    env: e.ANYROUTE_ENV,
    production,
    runtimeRole: e.RUNTIME_ROLE,
    autoMigrate: e.AUTO_MIGRATE,
    workerJobs: e.WORKER_JOBS.split(",").map((n) => n.trim()).filter(Boolean),
    test: e.ANYROUTE_ENV === "test",
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appSecret: e.APP_SECRET ?? "dev-insecure-secret-change-me-dev-insecure",
    adminToken: e.ADMIN_TOKEN,
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
    routing: {
      outageWindowMs: e.OUTAGE_WINDOW_MS,
      probeIntervalMs: e.HEALTH_PROBE_INTERVAL_MS,
      probes: e.HEALTH_PROBES,
      providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
      firstTokenTimeoutMs: e.FIRST_TOKEN_TIMEOUT_MS,
      maxAttempts: e.MAX_PROVIDER_ATTEMPTS,
      empty200SlashThreshold: e.EMPTY200_SLASH_THRESHOLD,
      uptimeSlashThreshold: e.UPTIME_SLASH_THRESHOLD,
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
    attestation: {
      intervalMs: e.ATTESTATION_INTERVAL_MS,
      allowDev: e.ALLOW_DEV_ATTESTATION && !production,
      nrasUrl: e.NVIDIA_NRAS_URL,
      tdxVerifierUrl: e.TDX_VERIFIER_URL,
      tdxVerifierKey: e.TDX_VERIFIER_KEY,
    },
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
    limits: { defaultRpm: e.DEFAULT_RPM, defaultTpm: e.DEFAULT_TPM, unauthRpm: e.UNAUTH_RPM, newKeysPerHour: e.NEW_KEYS_PER_HOUR },
    alerts: { webhookUrl: e.ALERT_WEBHOOK_URL, webhookFormat: e.ALERT_WEBHOOK_FORMAT },
    backup: { required: e.BACKUP_REQUIRED, maxAgeHours: e.BACKUP_MAX_AGE_HOURS },
  };
}

export type PaywithToken = { symbol: string; address: string; decimals: number; feed?: string; name?: string };
export type EscrowToken = PaywithToken & { feed: string };

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
