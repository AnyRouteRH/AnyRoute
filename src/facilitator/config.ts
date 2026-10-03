import { z } from "zod";
import type { Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

// The hosted x402 facilitator (v6 F): settings. Off by default. When on, it verifies and settles USDG EIP-3009
// authorizations for any seller on Robinhood Chain, straight from payer to the seller's payTo; its own relay key only pays
// gas, so it must hold no other role.

const flag = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().or(z.literal("").transform(() => undefined));
const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key").optional().or(z.literal("").transform(() => undefined));
const usdg = (d: string) => z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "must be a USDG amount with at most 6 decimals").default(d);

export const facilitatorEnv = {
  FACILITATOR_ENABLED: flag.default(false),
  // Optional fee as a second authorization to FACILITATOR_TREASURY; 0 during the launch waiver.
  FACILITATOR_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(0),
  // Smallest payment it settles (USDG), unless the seller prepaid a gas float.
  FACILITATOR_MIN_SETTLE: usdg("0.01"),
  FACILITATOR_RELAY_PRIVATE_KEY: key,
  FACILITATOR_TREASURY: address,
  // Native-gas balance below which the relay refuses (facilitator_unavailable) instead of queueing. Default 0.001 ETH.
  FACILITATOR_RELAY_FLOOR_WEI: z.coerce.bigint().nonnegative().default(1_000_000_000_000_000n),
  FACILITATOR_RPM: z.coerce.number().int().min(1).default(120), // per caller address, per minute
  FACILITATOR_PAYER_PER_MIN: z.coerce.number().int().min(1).default(20),
  FACILITATOR_SELLER_PER_MIN: z.coerce.number().int().min(1).default(600),
  FACILITATOR_LISTINGS_PER_HOUR: z.coerce.number().int().min(1).default(20), // per payTo
  // Gas floats: USDG per ETH used to price the measured gas of a settle, and the buffer on top. Unset: no gas floats.
  FACILITATOR_ETH_USDG: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).optional().or(z.literal("").transform(() => undefined)),
  FACILITATOR_GAS_BUFFER_BPS: z.coerce.number().int().min(10_000).max(50_000).default(15_000),
  FACILITATOR_SETTLE_GAS: z.coerce.number().int().min(21_000).max(2_000_000).default(120_000), // estimate for the float pre-check
};

type Env = z.infer<z.ZodObject<typeof facilitatorEnv>> & {
  SANCTIONS_SCREENING_ENABLED: boolean;
  ROUTER_PRIVATE_KEY?: string;
  SETTLEMENT_PRIVATE_KEY?: string;
  ANCHORER_PRIVATE_KEY?: string;
  SLASHER_PRIVATE_KEY?: string;
  KEEPER_PRIVATE_KEY?: string;
  IPX_KEEPER_PRIVATE_KEY?: string;
  IPX_ORACLE_PRIVATE_KEY?: string;
  PAYMASTER_SIGNER_KEY?: string;
  DEV_FAUCET_PRIVATE_KEY?: string;
};

/** A decimal USDG string as base units (6 decimals). */
export function usdgUnits(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

export function facilitatorSettings(e: Env, production: boolean) {
  const relayKey = e.FACILITATOR_RELAY_PRIVATE_KEY as Hex | undefined;
  if (e.FACILITATOR_ENABLED && !relayKey) throw new Error("FACILITATOR_ENABLED needs FACILITATOR_RELAY_PRIVATE_KEY, a key that only pays relay gas.");
  if (relayKey) {
    const others = [e.ROUTER_PRIVATE_KEY, e.SETTLEMENT_PRIVATE_KEY, e.ANCHORER_PRIVATE_KEY, e.SLASHER_PRIVATE_KEY, e.KEEPER_PRIVATE_KEY, e.IPX_KEEPER_PRIVATE_KEY, e.IPX_ORACLE_PRIVATE_KEY, e.PAYMASTER_SIGNER_KEY, e.DEV_FAUCET_PRIVATE_KEY];
    if (others.some((k) => k && k.toLowerCase() === relayKey.toLowerCase())) throw new Error("FACILITATOR_RELAY_PRIVATE_KEY must be its own key, with no other signing role.");
  }
  if (e.FACILITATOR_FEE_BPS > 0 && (!e.FACILITATOR_TREASURY || /^0x0{40}$/.test(e.FACILITATOR_TREASURY))) throw new Error("FACILITATOR_FEE_BPS above 0 needs FACILITATOR_TREASURY.");
  if (e.FACILITATOR_ETH_USDG && (!e.FACILITATOR_TREASURY || /^0x0{40}$/.test(e.FACILITATOR_TREASURY))) throw new Error("Gas floats (FACILITATOR_ETH_USDG) need FACILITATOR_TREASURY to receive them.");
  // Listings are screened against the sanctions list; a production facilitator must have that list.
  if (production && e.FACILITATOR_ENABLED && !e.SANCTIONS_SCREENING_ENABLED) throw new Error("FACILITATOR_ENABLED in production needs SANCTIONS_SCREENING_ENABLED (listings are screened).");
  const minSettle = usdgUnits(e.FACILITATOR_MIN_SETTLE);
  if (minSettle <= 0n) throw new Error("FACILITATOR_MIN_SETTLE must be above 0.");
  const ethUsdg = e.FACILITATOR_ETH_USDG ? usdgUnits(e.FACILITATOR_ETH_USDG) : null;
  if (ethUsdg !== null && ethUsdg <= 0n) throw new Error("FACILITATOR_ETH_USDG must be above 0.");
  return {
    enabled: e.FACILITATOR_ENABLED,
    relayKey,
    relayAddress: relayKey ? privateKeyToAddress(relayKey).toLowerCase() as Hex : undefined,
    feeBps: e.FACILITATOR_FEE_BPS,
    treasury: e.FACILITATOR_TREASURY?.toLowerCase() as Hex | undefined,
    minSettle,
    relayFloorWei: e.FACILITATOR_RELAY_FLOOR_WEI,
    rpm: e.FACILITATOR_RPM,
    payerPerMin: e.FACILITATOR_PAYER_PER_MIN,
    sellerPerMin: e.FACILITATOR_SELLER_PER_MIN,
    listingsPerHour: e.FACILITATOR_LISTINGS_PER_HOUR,
    gasFloat: ethUsdg === null ? null : { ethUsdg, bufferBps: e.FACILITATOR_GAS_BUFFER_BPS, settleGas: BigInt(e.FACILITATOR_SETTLE_GAS) },
  };
}
