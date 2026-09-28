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
  ANYR_POOL_LEGS: opt, // JSON [{key:{currency0,currency1,fee,tickSpacing,hooks}, sign}] pricing ANYR in USDG
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
  CACHE_TTL_S: int(3600),
  SEMANTIC_CACHE_THRESHOLD: num(0.97),
  SEMANTIC_CACHE_EMBEDDING_MODEL: opt,

  // Default per-key limits (0 = unlimited)
  DEFAULT_RPM: int(600),
  DEFAULT_TPM: int(0),
  UNAUTH_RPM: int(60),
  NEW_KEYS_PER_HOUR: int(10),
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
  if (production) {
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
    for (const [name, value] of Object.entries({ CREDITS_ADDRESS: e.CREDITS_ADDRESS, CALLPAY_ADDRESS: e.CALLPAY_ADDRESS, RECEIPT_ANCHOR_ADDRESS: e.RECEIPT_ANCHOR_ADDRESS }))
      if (!value || /^0x0{40}$/.test(value)) throw new Error(`${name} is required in production.`);
    if (e.RUNTIME_ROLE === "api" && !e.ROUTER_PRIVATE_KEY) throw new Error("Public API requires the restricted router signing role for enabled per-call payments.");
    if (e.PAYMASTER_ADDRESS && e.RUNTIME_ROLE === "api" && !e.PAYMASTER_SIGNER_KEY) throw new Error("Configured paymaster requires its signing role.");
    const roleKeys = { settlement: e.SETTLEMENT_PRIVATE_KEY, anchoring: e.ANCHORER_PRIVATE_KEY, slashing: e.SLASHER_PRIVATE_KEY, buyback: e.KEEPER_PRIVATE_KEY };
    if (e.RUNTIME_ROLE === "api" && Object.values(roleKeys).some(Boolean)) throw new Error("Public API must not receive settlement, anchoring, slashing or keeper signing keys.");
    if (e.RUNTIME_ROLE === "worker") {
      const names = e.WORKER_JOBS.split(",").map((v) => v.trim()).filter(Boolean);
      const allowed = ["health-flush", "holds-expire", "catalog-refresh", "provider-registry", "health-probes", "canaries", "attestor", "receipts-anchor", "receipt-key-rotation", "settlement", "slasher", "buyback", "chain-indexer", "paywith-aggregator"];
      if (!names.length || names.some((n) => !allowed.includes(n))) throw new Error("Worker requires an explicit valid WORKER_JOBS list.");
      const keyJobs = { settlement: "settlement", anchoring: "receipts-anchor", slashing: "slasher", buyback: "buyback" };
      if (Object.values(roleKeys).filter(Boolean).length > 1) throw new Error("Privileged worker signing roles must be isolated.");
      for (const [role, key] of Object.entries(roleKeys)) {
        const enabled = names.includes(keyJobs[role as keyof typeof keyJobs]);
        if (enabled !== !!key) throw new Error(`Worker ${role} job and signing-key configuration must match.`);
      }
    }
  }
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
  if (e.PER_CALL_MARGIN_BPS > 100) throw new Error("PER_CALL_MARGIN_BPS must be <= 100 (1%).");
  let paywithTokens: PaywithToken[] = [];
  if (e.PAYWITH_TOKENS) {
    try {
      paywithTokens = z
        .array(
          z.object({
            symbol: z.string().min(1).max(16),
            address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            decimals: z.number().int().min(0).max(36),
            feed: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
            name: z.string().optional(),
          }),
        )
        .parse(JSON.parse(e.PAYWITH_TOKENS));
    } catch (err) {
      throw new Error(`PAYWITH_TOKENS must be a JSON array of {symbol,address,decimals,feed?}: ${(err as Error).message}`);
    }
  }
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
      tokens: paywithTokens,
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
  };
}

export type PaywithToken = { symbol: string; address: string; decimals: number; feed?: string; name?: string };
