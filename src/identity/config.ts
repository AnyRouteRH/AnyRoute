import { z } from "zod";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// v6 I: receipt-backed identity and reputation. Both flags default to false; with them off no identity, feedback,
// reputation or liveness route answers (404), no job is registered and agent cards keep their earlier shape.
//
// The canonical ERC-8004 identity and reputation registries were found on Robinhood Chain (4663) with read-only
// RPC calls on 2026-10-02 (eth_getCode, getVersion "2.0.0", name "AgentIdentity", the reputation registry's
// getIdentityRegistry). Anyroute does not own or operate them. No validation registry exists there; Anyroute's own
// implementation (contracts/src/identity/ValidationRegistry.sol) is used only once ERC8004_VALIDATION_REGISTRY names a
// deployment.

const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address").optional().or(z.literal("").transform(() => undefined));
const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key").optional().or(z.literal("").transform(() => undefined));

export const CANONICAL_ERC8004: Record<number, { identity: Hex; reputation: Hex }> = {
  4663: { identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" },
};

export const identityEnv = {
  AGENT_IDENTITY_ENABLED: flag.default(false),
  PAID_FEEDBACK_ENABLED: flag.default(false),
  // owner: the router prepares register() calldata and the owner's wallet sends it; registrar: an isolated worker
  // (job agent-identity) sends it with AGENT_IDENTITY_REGISTRAR_KEY and holds the identity token.
  AGENT_IDENTITY_MODE: z.enum(["owner", "registrar"]).default("owner"),
  AGENT_IDENTITY_REGISTRAR_KEY: key,
  ERC8004_IDENTITY_REGISTRY: address, // default: the canonical registry on chains that have one
  ERC8004_REPUTATION_REGISTRY: address,
  ERC8004_VALIDATION_REGISTRY: address, // none by default
  ERC8004_VALIDATOR_ADDRESS: address, // the address that answers validation requests; default the registrar's
  PAID_FEEDBACK_HALF_LIFE_DAYS: z.coerce.number().min(1).max(3650).default(90),
  AGENT_LIVENESS_INTERVAL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  AGENT_LIVENESS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
};

type Env = z.infer<z.ZodObject<typeof identityEnv>> & {
  CHAIN_ID: number; ANYROUTE_ENV: string; RUNTIME_ROLE: string; WORKER_JOBS: string; AGENT_PROFILES_ENABLED: boolean;
  ROUTER_PRIVATE_KEY?: string; SETTLEMENT_PRIVATE_KEY?: string; ANCHORER_PRIVATE_KEY?: string; SLASHER_PRIVATE_KEY?: string;
  KEEPER_PRIVATE_KEY?: string; IPX_KEEPER_PRIVATE_KEY?: string; PAYMASTER_SIGNER_KEY?: string; IPX_ORACLE_PRIVATE_KEY?: string;
};

export function identitySettings(e: Env) {
  const production = e.ANYROUTE_ENV === "production";
  const jobs = e.WORKER_JOBS.split(",").map(v => v.trim()).filter(Boolean);
  if ((e.AGENT_IDENTITY_ENABLED || e.PAID_FEEDBACK_ENABLED) && !e.AGENT_PROFILES_ENABLED) throw new Error("AGENT_IDENTITY_ENABLED and PAID_FEEDBACK_ENABLED require AGENT_PROFILES_ENABLED.");
  if (jobs.includes("agent-liveness") && !e.AGENT_IDENTITY_ENABLED) throw new Error("The agent-liveness job needs AGENT_IDENTITY_ENABLED.");
  if (jobs.includes("agent-identity") && !(e.AGENT_IDENTITY_ENABLED && e.AGENT_IDENTITY_MODE === "registrar" && e.AGENT_IDENTITY_REGISTRAR_KEY)) throw new Error("The agent-identity job needs AGENT_IDENTITY_ENABLED, AGENT_IDENTITY_MODE=registrar and AGENT_IDENTITY_REGISTRAR_KEY.");
  if (e.AGENT_IDENTITY_REGISTRAR_KEY && e.AGENT_IDENTITY_MODE !== "registrar") throw new Error("AGENT_IDENTITY_REGISTRAR_KEY is only used with AGENT_IDENTITY_MODE=registrar.");
  if (production && e.AGENT_IDENTITY_REGISTRAR_KEY) {
    // A funded chain signer, like the agreement signer: one worker, one job, no other signing role.
    if (e.RUNTIME_ROLE !== "worker" || jobs.join(",") !== "agent-identity") throw new Error("AGENT_IDENTITY_REGISTRAR_KEY requires an isolated agent-identity worker.");
    if ([e.ROUTER_PRIVATE_KEY, e.SETTLEMENT_PRIVATE_KEY, e.ANCHORER_PRIVATE_KEY, e.SLASHER_PRIVATE_KEY, e.KEEPER_PRIVATE_KEY, e.IPX_KEEPER_PRIVATE_KEY, e.PAYMASTER_SIGNER_KEY, e.IPX_ORACLE_PRIVATE_KEY].some(Boolean)) throw new Error("AGENT_IDENTITY_REGISTRAR_KEY must be isolated from other signing roles.");
  }
  const canonical = CANONICAL_ERC8004[e.CHAIN_ID];
  const lower = (a?: string) => a?.toLowerCase() as Hex | undefined;
  const identity = lower(e.ERC8004_IDENTITY_REGISTRY) ?? lower(canonical?.identity);
  const reputation = lower(e.ERC8004_REPUTATION_REGISTRY) ?? lower(canonical?.reputation);
  const registrar = e.AGENT_IDENTITY_REGISTRAR_KEY ? (privateKeyToAccount(e.AGENT_IDENTITY_REGISTRAR_KEY as Hex).address.toLowerCase() as Hex) : undefined;
  return {
    enabled: e.AGENT_IDENTITY_ENABLED,
    paidFeedback: e.PAID_FEEDBACK_ENABLED,
    mode: e.AGENT_IDENTITY_MODE,
    registrarKey: e.AGENT_IDENTITY_REGISTRAR_KEY as Hex | undefined,
    registrar,
    registries: {
      identity,
      reputation,
      validation: lower(e.ERC8004_VALIDATION_REGISTRY),
      canonical: !!canonical && identity === lower(canonical.identity) && reputation === lower(canonical.reputation),
    },
    validator: lower(e.ERC8004_VALIDATOR_ADDRESS) ?? registrar,
    halfLifeDays: e.PAID_FEEDBACK_HALF_LIFE_DAYS,
    livenessIntervalMs: e.AGENT_LIVENESS_INTERVAL_MS,
    livenessTimeoutMs: e.AGENT_LIVENESS_TIMEOUT_MS,
  };
}
