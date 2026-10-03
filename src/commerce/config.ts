import { z } from "zod";

// Honest commerce ledger (GET /api/v1/commerce/stats, /commerce). Off by default. The USDG transfer index that feeds the
// funding-source filter runs only when COMMERCE_FUNDING_FROM_BLOCK is set as well; without it that filter is reported as
// unavailable and the other filters still apply.

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const addresses = z
  .string()
  .default("")
  .transform((v) => v.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean))
  .refine((list) => list.every((a) => /^0x[0-9a-f]{40}$/.test(a)), "must be a comma-separated list of 0x addresses");

export const commerceEnv = {
  COMMERCE_STATS_ENABLED: bool.default(false),
  /** First block of the USDG transfer index (the Dune query's `from_block`). Unset: no funding-source filter. */
  COMMERCE_FUNDING_FROM_BLOCK: z.coerce.bigint().nonnegative().optional(),
  /** Payer and payee count as linked when a funding path between them is at most this many transfers long. */
  COMMERCE_FUNDING_HOPS: z.coerce.number().int().min(1).max(3).default(2),
  /** Transfers below this many USDG base units do not count as funding (1 USDG: dust cannot link two wallets). */
  COMMERCE_FUNDING_MIN_UNITS: z.coerce.bigint().positive().default(1_000_000n),
  /** A wallet that funded more than this many distinct wallets is a hub (an exchange, a bridge) and links nobody. */
  COMMERCE_HUB_FANOUT: z.coerce.number().int().min(1).default(25),
  /** Extra hubs, for example a bridge or an exchange wallet that has not yet reached the fan-out. */
  COMMERCE_HUB_ADDRESSES: addresses,
  /** Extra wallets the operator controls (a treasury), added to the router's own configured addresses. */
  COMMERCE_OPERATOR_ADDRESSES: addresses,
  /** Wallets that relay settlements besides the router's own key (a facilitator relay key). Their relays are never funding. */
  COMMERCE_RELAYER_ADDRESSES: addresses,
};

type Env = z.infer<z.ZodObject<typeof commerceEnv>> & { RUNTIME_ROLE: string; WORKER_JOBS: string };

export type CommerceSettings = {
  enabled: boolean;
  funding: { fromBlock: bigint | null; hops: number; minUnits: bigint; hubFanout: number; hubs: string[] };
  operators: string[];
  relayers: string[];
};

export function commerceSettings(e: Env): CommerceSettings {
  const jobs = e.WORKER_JOBS.split(",").map((v) => v.trim());
  if (e.RUNTIME_ROLE === "worker" && jobs.includes("commerce-transfers") && !(e.COMMERCE_STATS_ENABLED && e.COMMERCE_FUNDING_FROM_BLOCK != null))
    throw new Error("The commerce-transfers job needs COMMERCE_STATS_ENABLED and COMMERCE_FUNDING_FROM_BLOCK.");
  return {
    enabled: e.COMMERCE_STATS_ENABLED,
    funding: { fromBlock: e.COMMERCE_FUNDING_FROM_BLOCK ?? null, hops: e.COMMERCE_FUNDING_HOPS, minUnits: e.COMMERCE_FUNDING_MIN_UNITS, hubFanout: e.COMMERCE_HUB_FANOUT, hubs: e.COMMERCE_HUB_ADDRESSES },
    operators: e.COMMERCE_OPERATOR_ADDRESSES,
    relayers: e.COMMERCE_RELAYER_ADDRESSES,
  };
}
