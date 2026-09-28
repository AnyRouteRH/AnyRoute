import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { anchors, spentRoots, chainCursor, kv, providers } from "../db/schema.ts";
import type { JobSnapshot } from "./jobs.ts";
import { attestationFresh } from "../router/select.ts";

// One-day production timelock plus one day for review/execution. Submission failures retain the 2-minute bound.
export const ROOT_REVIEW_SLA_MS = 48 * 3_600_000;
export const CRITICAL_JOBS = ["chain-indexer", "catalog-refresh", "provider-registry", "receipts-anchor", "settlement"];
// PAYMENTS_MODE=escrow has no Anyroute contracts: receipts stay signed locally, no settlement runs,
// and chain health is the escrow watcher's progress.
export const ESCROW_CRITICAL_JOBS = ["escrow-indexer", "catalog-refresh", "provider-registry", "receipts-anchor"];
export function jobReady(state: JobSnapshot | undefined, now = Date.now()) {
  if (!state || state.last_error || !state.last_success || !(state.every_ms > 0)) return false;
  const age = now - Date.parse(state.last_success);
  return Number.isFinite(age) && age >= 0 && age <= Math.max(state.every_ms * 2, 60_000);
}
function configuredEndpoint(value: string | undefined) {
  if (!value) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}
async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Readiness timeout")), 2000); })]);
  } finally { clearTimeout(timer!); }
}

/** Public readiness never exposes exception text, credentials, hostnames or RPC URLs.
 * Worker heartbeats are persisted, so API replicas can observe a separate worker. */
export async function readiness(ctx: Ctx) {
  const checks: Record<string, boolean> = {};
  const escrowMode = ctx.cfg.escrow.mode === "escrow";
  await Promise.all([
    (async () => { try { await bounded(async () => { await ctx.db.execute(sql`select 1`); }); checks.database = true; } catch { checks.database = false; } })(),
    (async () => {
      try {
        await bounded(async () => {
          await ctx.catalog.refresh();
          checks.providers = [...ctx.catalog.offersByModel.values()].some((rows) => rows.some((o) => o.status === "live" && o.provider.status === "live"));
          const livePrivateProviders = ctx.cfg.production
            ? await ctx.db.select({ teeKind: providers.teeKind }).from(providers).where(and(eq(providers.status, "live"), isNotNull(providers.teeKind)))
            : [];
          const privateRoutingEnabled = livePrivateProviders.some((p) => !!p.teeKind && p.teeKind !== "dev");
          // Every non-dev report passes through the DCAP verifier; NVIDIA confidential-computing
          // reports also require the separate NRAS verification endpoint.
          checks.private_attestation_verifiers = !privateRoutingEnabled || (
            configuredEndpoint(ctx.cfg.attestation.tdxVerifierUrl) &&
            (!livePrivateProviders.some((p) => p.teeKind === "nvidia-cc") || configuredEndpoint(ctx.cfg.attestation.nrasUrl))
          );
          if (privateRoutingEnabled) {
            const liveAttested = [...ctx.catalog.offersByModel.values()].flat().some((o) =>
              o.status === "live" && o.provider.status === "live" && !!o.provider.teeKind && o.provider.teeKind !== "dev" &&
              attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, true));
            checks.private_attestation = liveAttested;
          }
          const staleBefore = new Date(Date.now() - 120_000);
          const [anchorBacklog, rootBacklog, approvalBacklog] = await Promise.all([
            ctx.db.select({ id: anchors.index }).from(anchors).where(and(inArray(anchors.status, escrowMode ? ["pending"] : ["pending", "local"]), lt(anchors.createdAt, staleBefore))).limit(1),
            ctx.db.select({ id: spentRoots.epoch }).from(spentRoots).where(and(eq(spentRoots.status, "pending"), lt(spentRoots.createdAt, staleBefore))).limit(1),
            ctx.db.select({ id: spentRoots.epoch }).from(spentRoots).where(and(eq(spentRoots.status, "awaiting_approval"), lt(spentRoots.createdAt, new Date(Date.now() - ROOT_REVIEW_SLA_MS)))).limit(1),
          ]);
          checks.settlement_review = !approvalBacklog.length;
          checks.chain_submissions = !anchorBacklog.length && !rootBacklog.length;
          const requiredJobs = [...(escrowMode ? ESCROW_CRITICAL_JOBS : CRITICAL_JOBS), ...(privateRoutingEnabled ? ["attestor"] : [])];
          const states = await ctx.db.select().from(kv).where(inArray(kv.key, requiredJobs.map((n) => `job-health:${n}`)));
          for (const name of requiredJobs) checks[name] = jobReady(states.find((r) => r.key === `job-health:${name}`)?.value as JobSnapshot | undefined);
        });
      } catch { checks.workers = false; checks.providers = false; }
    })(),
    (async () => {
      if (!escrowMode && !ctx.cfg.chain.credits && !ctx.cfg.chain.callPay) { checks.chain = false; return; }
      try {
        await bounded(async () => {
          const [head, chainId] = await Promise.all([ctx.chain.blockNumber(), ctx.chain.client.getChainId()]);
          if (chainId !== ctx.cfg.chain.id) throw new Error("Chain mismatch");
          const [cursor] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, escrowMode ? "escrow" : "main"));
          // Robinhood Chain produces ~10 blocks/s and the escrow watcher polls every 5 s, so its lag is
          // bounded in time (~2 minutes of blocks), not by a handful of blocks.
          const maxLag = escrowMode ? Math.max(ctx.cfg.chain.confirmations + 20, 1_200) : Math.max(ctx.cfg.chain.confirmations + 20, 30);
          checks.chain = !!cursor && head - cursor.block <= BigInt(maxLag) && cursor.block <= head;
        });
      } catch { checks.chain = false; }
    })(),
    (async () => {
      if (escrowMode) return;
      try { checks.custody_controls = await bounded(() => ctx.chain.custodyControlsReady()); } catch { checks.custody_controls = false; }
    })(),
    (async () => {
      try { await bounded(() => ctx.limiter.take("readiness", 0, 1, 60_000)); checks.rate_limiter = true; } catch { checks.rate_limiter = false; }
    })(),
  ]);
  if (!escrowMode) checks.receipt_anchor_configured = !!ctx.cfg.chain.receiptAnchor;
  return { ok: Object.values(checks).every(Boolean), checks };
}
