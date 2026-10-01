import { z } from "zod";
import type { Hex } from "viem";
const flag = z.union([z.boolean(), z.string()]).transform(v => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().or(z.literal("").transform(() => undefined));
const optional = z.string().optional().or(z.literal("").transform(() => undefined));
export const agreementEnv = {
  AGENT_AGREEMENTS_ENABLED: flag.default(false), AGENT_AGREEMENTS_RULINGS_ENABLED: flag.default(false),
  AGREEMENT_ESCROW_ADDRESS: address, DISPUTE_ORACLE_ADDRESS: address,
  AGREEMENT_START_BLOCK: z.coerce.bigint().nonnegative().default(0n),
  AGREEMENT_FINALITY: z.enum(["finalized", "safe"]).default("finalized"),
  AGREEMENT_JURY_MODELS: z.string().default("auto"), AGREEMENT_JURY_THRESHOLD: z.coerce.number().int().min(1).max(16).default(2),
  AGREEMENT_JURY_INTERNAL_ENABLED: flag.default(false),
  AGREEMENT_JURY_API_KEY: optional, AGREEMENT_JURY_SIGNER_KEYS: optional,
  AGREEMENT_EVIDENCE_BYTES: z.coerce.number().int().min(1024).max(65536).default(16384),
  AGREEMENT_EVIDENCE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
  AGREEMENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
};
type Env = z.infer<z.ZodObject<typeof agreementEnv>> & { RUNTIME_ROLE: string; WORKER_JOBS: string; TLOG_ENABLED: boolean; ROUTER_PRIVATE_KEY?: string; SETTLEMENT_PRIVATE_KEY?: string; ANCHORER_PRIVATE_KEY?: string; SLASHER_PRIVATE_KEY?: string; KEEPER_PRIVATE_KEY?: string; IPX_KEEPER_PRIVATE_KEY?: string; PAYMASTER_SIGNER_KEY?: string };
export function agreementSettings(e: Env, production: boolean) {
  const present = (s?: string) => !!s && !/^0x0{40}$/i.test(s);
  const enabled = e.AGENT_AGREEMENTS_ENABLED && present(e.AGREEMENT_ESCROW_ADDRESS) && present(e.DISPUTE_ORACLE_ADDRESS);
  const models = e.AGREEMENT_JURY_MODELS === "auto" ? [] : e.AGREEMENT_JURY_MODELS.split(",").map(s => s.trim());
  if (models.length > 16 || models.some(s => !s || s.length > 160) || new Set(models).size !== models.length) throw new Error("AGREEMENT_JURY_MODELS must contain distinct model ids, at most 16.");
  const size = models.length || 3;
  const signerKeys = e.AGREEMENT_JURY_SIGNER_KEYS?.split(",").map(s => s.trim()) as Hex[] | undefined;
  if (signerKeys && (signerKeys.length !== size || signerKeys.some(s => !/^0x[0-9a-fA-F]{64}$/.test(s)) || new Set(signerKeys).size !== size)) throw new Error("AGREEMENT_JURY_SIGNER_KEYS must contain one distinct key per model.");
  if (e.AGREEMENT_JURY_THRESHOLD <= size / 2 || e.AGREEMENT_JURY_THRESHOLD > size) throw new Error("AGREEMENT_JURY_THRESHOLD must be a strict majority of the jury.");
  if (e.AGENT_AGREEMENTS_RULINGS_ENABLED && (!enabled || !e.AGREEMENT_JURY_SIGNER_KEYS || (!e.AGREEMENT_JURY_API_KEY && !e.AGREEMENT_JURY_INTERNAL_ENABLED) || !e.TLOG_ENABLED)) throw new Error("Agreement rulings require enabled agreements, jury transport, signer keys, and TLOG_ENABLED.");
  if (production && e.AGREEMENT_JURY_SIGNER_KEYS) {
    if (!e.AGENT_AGREEMENTS_RULINGS_ENABLED || e.RUNTIME_ROLE !== "worker" || e.WORKER_JOBS !== "agreement-jury") throw new Error("Agreement signer requires an isolated agreement-jury worker with rulings enabled.");
    if ([e.ROUTER_PRIVATE_KEY, e.SETTLEMENT_PRIVATE_KEY, e.ANCHORER_PRIVATE_KEY, e.SLASHER_PRIVATE_KEY, e.KEEPER_PRIVATE_KEY, e.IPX_KEEPER_PRIVATE_KEY, e.PAYMASTER_SIGNER_KEY].some(Boolean)) throw new Error("Agreement signer must be isolated from other signing roles.");
  }
  if (enabled && e.AGREEMENT_ESCROW_ADDRESS!.toLowerCase() === e.DISPUTE_ORACLE_ADDRESS!.toLowerCase()) throw new Error("Agreement escrow and dispute oracle must be distinct contracts.");
  return { enabled, internal: e.AGREEMENT_JURY_INTERNAL_ENABLED, rulings: e.AGENT_AGREEMENTS_RULINGS_ENABLED, escrow: e.AGREEMENT_ESCROW_ADDRESS?.toLowerCase() as Hex | undefined, oracle: e.DISPUTE_ORACLE_ADDRESS?.toLowerCase() as Hex | undefined,
    startBlock: e.AGREEMENT_START_BLOCK, finality: e.AGREEMENT_FINALITY, models, size, threshold: e.AGREEMENT_JURY_THRESHOLD, apiKey: e.AGREEMENT_JURY_API_KEY, signerKeys,
    evidenceBytes: e.AGREEMENT_EVIDENCE_BYTES, evidenceWindowSeconds: e.AGREEMENT_EVIDENCE_WINDOW_SECONDS, retentionDays: e.AGREEMENT_RETENTION_DAYS };
}
