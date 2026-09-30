import { z } from "zod";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.ts";
import { hostBondAbi } from "./bond-abi.ts";
const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
export const hostBondEnv = {
  HOST_BOND_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().or(z.literal("").transform(() => undefined)),
  HOST_BOND_START_BLOCK: z.coerce.bigint().min(0n).default(76855987n),
  NETWORK_BONDS_ENABLED: flag.default(false),
  NETWORK_SLASHING_ENABLED: flag.default(false),
  NETWORK_BOND_FULL_USDG: z.coerce.number().positive().max(1_000_000_000).default(5_000),
  NETWORK_BOND_FINALITY: z.enum(["finalized", "safe"]).default("finalized"),
};
export function hostBondSettings(e: z.infer<z.ZodObject<typeof hostBondEnv>> & { SLASHER_PRIVATE_KEY?: string; WORKER_JOBS: string }) {
  if (e.NETWORK_BONDS_ENABLED && (!e.HOST_BOND_ADDRESS || /^0x0{40}$/i.test(e.HOST_BOND_ADDRESS))) throw new Error("NETWORK_BONDS_ENABLED requires HOST_BOND_ADDRESS.");
  if (e.NETWORK_SLASHING_ENABLED && (!e.NETWORK_BONDS_ENABLED || !e.SLASHER_PRIVATE_KEY)) throw new Error("NETWORK_SLASHING_ENABLED requires NETWORK_BONDS_ENABLED and SLASHER_PRIVATE_KEY.");
  const jobs = e.WORKER_JOBS.split(",").map(v => v.trim());
  if (jobs.includes("host-bond-indexer") && !e.NETWORK_BONDS_ENABLED) throw new Error("host-bond-indexer requires NETWORK_BONDS_ENABLED.");
  if (jobs.includes("host-slasher") && !e.NETWORK_BONDS_ENABLED) throw new Error("host-slasher requires NETWORK_BONDS_ENABLED.");
  if (e.NETWORK_SLASHING_ENABLED && jobs.includes("slasher")) throw new Error("host-slasher must be isolated from the provider slasher.");
  return { enabled: e.NETWORK_BONDS_ENABLED, slashing: e.NETWORK_SLASHING_ENABLED, address: e.HOST_BOND_ADDRESS?.toLowerCase() as Hex | undefined, startBlock: e.HOST_BOND_START_BLOCK, fullUsdg: e.NETWORK_BOND_FULL_USDG, finality: e.NETWORK_BOND_FINALITY };
}
/** Runs before opening the database; a changed role is also checked before each signing pass. */
export async function guardHostSlasher(cfg: Config, read?: () => Promise<string>) {
  if (!cfg.hostBonds.slashing) return;
  const key = cfg.chain.slasherKey;
  if (!key) throw new Error("Host slasher signing key is required.");
  const slasher = await (read ?? (() => createPublicClient({ transport: http(cfg.chain.rpcUrl) }).readContract({ address: cfg.hostBonds.address!, abi: hostBondAbi, functionName: "slasher" })))();
  if (privateKeyToAccount(key).address.toLowerCase() !== slasher.toLowerCase()) throw new Error("SLASHER_PRIVATE_KEY address does not equal HostBond.slasher().");
}
