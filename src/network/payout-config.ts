import { z } from "zod";
const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false);
export const networkPayoutEnv = {
  NETWORK_PAYOUTS_ENABLED: flag,
  NETWORK_FEE_BURN_ENABLED: flag,
  NETWORK_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(500),
  NETWORK_FEE_BURN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
};
type Input = z.infer<z.ZodObject<typeof networkPayoutEnv>> & { SANCTIONS_SCREENING_ENABLED: boolean; HOST_ANCHOR_ENABLED: boolean; SETTLEMENT_PRIVATE_KEY?: string; KEEPER_PRIVATE_KEY?: string; BUYBACK_ORACLE_ADDRESS?: string; ANYR_STAKING_ADDRESS?: string; RUNTIME_ROLE: string; WORKER_JOBS: string; PAYMENTS_MODE: string };
export function networkPayoutSettings(e: Input, production: boolean) {
  const jobs = e.WORKER_JOBS.split(",").map(s => s.trim());
  if (e.NETWORK_PAYOUTS_ENABLED && (!e.SANCTIONS_SCREENING_ENABLED || !e.HOST_ANCHOR_ENABLED)) throw new Error("NETWORK_PAYOUTS_ENABLED requires SANCTIONS_SCREENING_ENABLED and HOST_ANCHOR_ENABLED.");
  if (e.NETWORK_FEE_BURN_ENABLED && (!e.BUYBACK_ORACLE_ADDRESS || /^0x0{40}$/i.test(e.BUYBACK_ORACLE_ADDRESS) || !e.ANYR_STAKING_ADDRESS || !e.NETWORK_FEE_BURN_ADDRESS || /^0x0{40}$/i.test(e.NETWORK_FEE_BURN_ADDRESS))) throw new Error("NETWORK_FEE_BURN_ENABLED requires BUYBACK_ORACLE_ADDRESS, ANYR_STAKING_ADDRESS and NETWORK_FEE_BURN_ADDRESS.");
  if ((e.NETWORK_PAYOUTS_ENABLED || e.NETWORK_FEE_BURN_ENABLED) && e.PAYMENTS_MODE === "escrow") throw new Error("Network payments require contract payments mode.");
  if (production && e.RUNTIME_ROLE === "worker") {
    if (e.NETWORK_PAYOUTS_ENABLED && jobs.includes("settlement") && !e.SETTLEMENT_PRIVATE_KEY) throw new Error("Network payouts require the settlement signer.");
    if (jobs.includes("network-fee-burn") && (!e.NETWORK_FEE_BURN_ENABLED || !e.KEEPER_PRIVATE_KEY)) throw new Error("network-fee-burn requires its flag and keeper signer.");
  }
  return { enabled: e.NETWORK_PAYOUTS_ENABLED, burnEnabled: e.NETWORK_FEE_BURN_ENABLED, feeBps: e.NETWORK_FEE_BPS, burnAddress: e.NETWORK_FEE_BURN_ADDRESS as `0x${string}` | undefined };
}
