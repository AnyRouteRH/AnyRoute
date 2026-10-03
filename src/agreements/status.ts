import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { Ctx } from "../context.ts";
import { kv } from "../db/schema.ts";

/**
 * Automatic rulings are signed by an isolated agreement-jury worker; production refuses the signer keys (and so
 * AGENT_AGREEMENTS_RULINGS_ENABLED) anywhere else, so the public API cannot read that flag. Instead the jury worker
 * writes this heartbeat each pass after its keys matched the DisputeOracle's current jury and threshold on chain, and
 * GET /api/v1/status reports rulings as on only while that heartbeat is fresh and names the configured contracts.
 */
export const JURY_HEARTBEAT_KEY = "agreement-jury:heartbeat";
/** The jury pass runs every minute; after five missed passes the API stops reporting rulings as on. */
export const JURY_HEARTBEAT_MAX_AGE_MS = 5 * 60_000;
export type JuryHeartbeat = { escrow: string; oracle: string; threshold: number; signers: string[]; at: string };

export async function recordJuryHeartbeat(ctx: Ctx, now = new Date()) {
  const cfg = ctx.cfg.agreements;
  if (!cfg.enabled || !cfg.rulings || !cfg.signerKeys?.length) return;
  const value: JuryHeartbeat = {
    escrow: cfg.escrow!, oracle: cfg.oracle!, threshold: cfg.threshold,
    signers: cfg.signerKeys.map((key) => privateKeyToAccount(key).address.toLowerCase()), at: now.toISOString(),
  };
  await ctx.db.insert(kv).values({ key: JURY_HEARTBEAT_KEY, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
}

export type AgreementsStatus = {
  enabled: boolean; escrow: string | null; oracle: string | null; start_block: string | null; finality: "finalized" | "safe" | null;
  rulings: { enabled: boolean; source: "jury-worker-heartbeat"; last_seen: string | null; max_age_ms: number; threshold: number | null; jury_size: number | null };
};

/** The agreements section of GET /api/v1/status: what this router serves, and whether a jury worker is posting rulings. */
export async function agreementsStatus(ctx: Ctx, now = Date.now()): Promise<AgreementsStatus> {
  const cfg = ctx.cfg.agreements;
  const rulings = { enabled: false, source: "jury-worker-heartbeat" as const, last_seen: null as string | null, max_age_ms: JURY_HEARTBEAT_MAX_AGE_MS, threshold: null as number | null, jury_size: null as number | null };
  if (!cfg.enabled) return { enabled: false, escrow: null, oracle: null, start_block: null, finality: null, rulings };
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, JURY_HEARTBEAT_KEY));
  const beat = row?.value as Partial<JuryHeartbeat> | undefined;
  const seen = typeof beat?.at === "string" ? Date.parse(beat.at) : NaN;
  // A heartbeat for other contracts (an earlier deployment) says nothing about this one.
  const same = beat?.escrow?.toLowerCase() === cfg.escrow && beat?.oracle?.toLowerCase() === cfg.oracle;
  if (same && Number.isFinite(seen)) {
    rulings.last_seen = new Date(seen).toISOString();
    rulings.enabled = now - seen <= JURY_HEARTBEAT_MAX_AGE_MS && seen - now <= 60_000;
    rulings.threshold = typeof beat?.threshold === "number" ? beat.threshold : null;
    rulings.jury_size = Array.isArray(beat?.signers) ? beat.signers.length : null;
  }
  return { enabled: true, escrow: cfg.escrow ?? null, oracle: cfg.oracle ?? null, start_block: cfg.startBlock.toString(), finality: cfg.finality, rulings };
}
