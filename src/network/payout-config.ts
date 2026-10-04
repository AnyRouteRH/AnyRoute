import { z } from "zod";
const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false);
const optionalAddress = z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional());
export const networkPayoutEnv = {
  NETWORK_PAYOUTS_ENABLED: flag,
  NETWORK_FEE_BURN_ENABLED: flag,
  NETWORK_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(500),
  NETWORK_FEE_BURN_TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a"),
  NETWORK_FEE_BURN_ADAPTER_ADDRESS: optionalAddress,
  NETWORK_FEE_BURN_ORACLE_ADDRESS: optionalAddress,
  NETWORK_FEE_BURN_DAILY_CAP_USDG: z.string().regex(/^\d+$/).default("0"),
  NETWORK_FEE_BURN_ADDRESS: optionalAddress,
};
type Input = z.infer<z.ZodObject<typeof networkPayoutEnv>> & { SANCTIONS_SCREENING_ENABLED: boolean; HOST_ANCHOR_ENABLED: boolean; SETTLEMENT_PRIVATE_KEY?: string; KEEPER_PRIVATE_KEY?: string; RUNTIME_ROLE: string; WORKER_JOBS: string; PAYMENTS_MODE: string };
export function networkPayoutSettings(e: Input, production: boolean) {
  const jobs = e.WORKER_JOBS.split(",").map(s => s.trim());
  if (e.NETWORK_PAYOUTS_ENABLED && (!e.SANCTIONS_SCREENING_ENABLED || !e.HOST_ANCHOR_ENABLED)) throw new Error("NETWORK_PAYOUTS_ENABLED requires SANCTIONS_SCREENING_ENABLED and HOST_ANCHOR_ENABLED.");
  if (e.NETWORK_FEE_BURN_ENABLED && ([e.NETWORK_FEE_BURN_TOKEN_ADDRESS, e.NETWORK_FEE_BURN_ORACLE_ADDRESS, e.NETWORK_FEE_BURN_ADAPTER_ADDRESS, e.NETWORK_FEE_BURN_ADDRESS].some(v => !v || /^0x0{40}$/i.test(v)) || BigInt(e.NETWORK_FEE_BURN_DAILY_CAP_USDG) <= 0n)) throw new Error("NETWORK_FEE_BURN_ENABLED requires nonzero NETWORK_FEE_BURN_ORACLE_ADDRESS, NETWORK_FEE_BURN_ADAPTER_ADDRESS, NETWORK_FEE_BURN_ADDRESS and a positive NETWORK_FEE_BURN_DAILY_CAP_USDG (USDG base units).");
  if ((e.NETWORK_PAYOUTS_ENABLED || e.NETWORK_FEE_BURN_ENABLED) && e.PAYMENTS_MODE === "escrow") throw new Error("Network payments require contract payments mode.");
  if (production && e.RUNTIME_ROLE === "worker") {
    if (e.NETWORK_PAYOUTS_ENABLED && jobs.includes("settlement") && !e.SETTLEMENT_PRIVATE_KEY) throw new Error("Network payouts require the settlement signer.");
    if (jobs.includes("network-fee-burn") && (!e.NETWORK_FEE_BURN_ENABLED || !e.KEEPER_PRIVATE_KEY)) throw new Error("network-fee-burn requires its flag and keeper signer.");
  }
  return { enabled: e.NETWORK_PAYOUTS_ENABLED, burnEnabled: e.NETWORK_FEE_BURN_ENABLED, feeBps: e.NETWORK_FEE_BPS, burnToken: e.NETWORK_FEE_BURN_TOKEN_ADDRESS as `0x${string}`, burnDailyCap: BigInt(e.NETWORK_FEE_BURN_DAILY_CAP_USDG), burnOracle: e.NETWORK_FEE_BURN_ORACLE_ADDRESS as `0x${string}` | undefined, burnAdapter: e.NETWORK_FEE_BURN_ADAPTER_ADDRESS as `0x${string}` | undefined, burnAddress: e.NETWORK_FEE_BURN_ADDRESS as `0x${string}` | undefined };
}
