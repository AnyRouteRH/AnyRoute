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
