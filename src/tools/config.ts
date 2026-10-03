import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, TypedDataDefinition } from "viem";

// v6 T: the paid tool market. One Anyroute balance pays any x402 tool: the router signs the seller's USDG
// authorization from its own buyer wallet and debits the caller's key at the price plus the take.
// Everything is off until TOOLS_MARKET_ENABLED is set; a paid call is refused until TOOLS_BUYER_PRIVATE_KEY is set.

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const pk = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key").optional().or(z.literal("").transform(() => undefined));
const opt = z.string().optional().transform((v) => (v ? v : undefined));

export const toolsEnv = {
  TOOLS_MARKET_ENABLED: bool.default(false),
  /** The router's take on top of the seller's price, in basis points (300 = 3%). */
  TOOLS_TAKE_BPS: z.coerce.number().int().default(300),
  /** The buyer wallet: holds USDG and signs EIP-3009 authorizations to sellers. Never logged, never returned. */
  TOOLS_BUYER_PRIVATE_KEY: pk,
  /** The most one call may cost a key (price plus take), whatever max_price the caller sends. */
  TOOLS_MAX_PRICE_USD: z.coerce.number().default(5),
  /** The most the buyer wallet may authorize across every key in a rolling 24 hours. */
  TOOLS_DAILY_LIMIT_USD: z.coerce.number().default(100),
  TOOLS_MAX_RESPONSE_BYTES: z.coerce.number().int().default(2 * 1024 * 1024),
  /** A public x402 catalog to search alongside local listings (Bazaar discovery shape). Unset: local listings only. */
  TOOLS_PUBLIC_CATALOG_URL: opt,
  TOOLS_PUBLIC_CATALOG_TTL_S: z.coerce.number().int().default(900),
  TOOLS_CANARY_INTERVAL_MS: z.coerce.number().int().default(86_400_000),
  /** A listing priced above this is not probed (its state shows unchecked) so canaries never spend much. */
  TOOLS_CANARY_MAX_PRICE_USD: z.coerce.number().default(0.05),
};

const toolsShape = z.object(toolsEnv);
type ToolsEnv = z.infer<typeof toolsShape>;
const OTHER_KEYS = ["ROUTER_PRIVATE_KEY", "SETTLEMENT_PRIVATE_KEY", "ANCHORER_PRIVATE_KEY", "PAYMASTER_SIGNER_KEY", "SLASHER_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "IPX_ORACLE_PRIVATE_KEY", "IPX_KEEPER_PRIVATE_KEY"] as const;

export type ToolsBuyer = { address: Hex; signTypedData: (td: TypedDataDefinition) => Promise<Hex> };

/** Plain media types a tool may answer with; anything else (binary, HTML, scripts) is refused before it is forwarded. */
export const TOOL_CONTENT_TYPES = ["application/json", "text/plain", "text/csv", "text/markdown"] as const;

export function toolsSettings(e: ToolsEnv & Partial<Record<(typeof OTHER_KEYS)[number], string | undefined>>, production: boolean) {
  if (e.TOOLS_TAKE_BPS < 0 || e.TOOLS_TAKE_BPS > 5_000) throw new Error("TOOLS_TAKE_BPS must be between 0 and 5000.");
  if (!(e.TOOLS_MAX_PRICE_USD > 0) || e.TOOLS_MAX_PRICE_USD > 1_000) throw new Error("TOOLS_MAX_PRICE_USD must be above 0 and at most 1000.");
  if (!(e.TOOLS_DAILY_LIMIT_USD > 0)) throw new Error("TOOLS_DAILY_LIMIT_USD must be positive.");
  if (e.TOOLS_MAX_RESPONSE_BYTES < 1_024 || e.TOOLS_MAX_RESPONSE_BYTES > 16 * 1024 * 1024) throw new Error("TOOLS_MAX_RESPONSE_BYTES must be between 1 KiB and 16 MiB.");
  if (e.TOOLS_CANARY_INTERVAL_MS < 60_000) throw new Error("TOOLS_CANARY_INTERVAL_MS must be at least 60000.");
  if (e.TOOLS_CANARY_MAX_PRICE_USD < 0) throw new Error("TOOLS_CANARY_MAX_PRICE_USD must not be negative.");
  if (e.TOOLS_PUBLIC_CATALOG_URL) {
    let url: URL;
    try {
      url = new URL(e.TOOLS_PUBLIC_CATALOG_URL);
    } catch {
      throw new Error("TOOLS_PUBLIC_CATALOG_URL must be a URL.");
    }
    if ((url.protocol !== "https:" && (production || url.protocol !== "http:")) || url.username || url.password || url.hash) throw new Error("TOOLS_PUBLIC_CATALOG_URL must be an https URL without credentials or a fragment.");
  }
  let buyer: ToolsBuyer | undefined;
  if (e.TOOLS_BUYER_PRIVATE_KEY) {
    const key = e.TOOLS_BUYER_PRIVATE_KEY.toLowerCase();
    // The buyer wallet holds spendable USDG on a request path: it never doubles as a role key.
    if (OTHER_KEYS.some((name) => e[name]?.toLowerCase() === key)) throw new Error("TOOLS_BUYER_PRIVATE_KEY must be a dedicated key, distinct from every other signing role.");
    const account = privateKeyToAccount(e.TOOLS_BUYER_PRIVATE_KEY as Hex);
    // The key stays inside this closure: the settings object carries only the address and a signer.
    buyer = { address: account.address, signTypedData: (td) => account.signTypedData(td as never) };
  }
  return {
    enabled: e.TOOLS_MARKET_ENABLED,
    takeBps: e.TOOLS_TAKE_BPS,
    buyer,
    maxPriceUsd: e.TOOLS_MAX_PRICE_USD,
    dailyLimitUsd: e.TOOLS_DAILY_LIMIT_USD,
    maxResponseBytes: e.TOOLS_MAX_RESPONSE_BYTES,
    publicCatalogUrl: e.TOOLS_PUBLIC_CATALOG_URL,
    publicCatalogTtlMs: Math.max(60, e.TOOLS_PUBLIC_CATALOG_TTL_S) * 1000,
    canaryIntervalMs: e.TOOLS_CANARY_INTERVAL_MS,
    canaryMaxPriceUsd: e.TOOLS_CANARY_MAX_PRICE_USD,
  };
}
export type ToolsSettings = ReturnType<typeof toolsSettings>;
