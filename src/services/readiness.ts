import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { anchors, spentRoots, chainCursor, kv } from "../db/schema.ts";
import type { JobSnapshot } from "./jobs.ts";

export const CRITICAL_JOBS = ["chain-indexer", "catalog-refresh", "provider-registry", "receipts-anchor", "settlement"];
export function jobReady(state: JobSnapshot | undefined, now = Date.now()) {
  if (!state || state.last_error || !state.last_success || !(state.every_ms > 0)) return false;
  const age = now - Date.parse(state.last_success);
  return Number.isFinite(age) && age >= 0 && age <= Math.max(state.every_ms * 2, 60_000);
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
  await Promise.all([
    (async () => { try { await bounded(async () => { await ctx.db.execute(sql`select 1`); }); checks.database = true; } catch { checks.database = false; } })(),
    (async () => {
      try {
        await bounded(async () => {
          await ctx.catalog.refresh();
          checks.providers = [...ctx.catalog.offersByModel.values()].some((rows) => rows.some((o) => o.status === "live" && o.provider.status === "live"));
          const staleBefore = new Date(Date.now() - 120_000);
          const [anchorBacklog, rootBacklog] = await Promise.all([
            ctx.db.select({ id: anchors.index }).from(anchors).where(and(inArray(anchors.status, ["pending", "local"]), lt(anchors.createdAt, staleBefore))).limit(1),
            ctx.db.select({ id: spentRoots.epoch }).from(spentRoots).where(and(eq(spentRoots.status, "pending"), lt(spentRoots.createdAt, staleBefore))).limit(1),
          ]);
          checks.chain_submissions = !anchorBacklog.length && !rootBacklog.length;
          const states = await ctx.db.select().from(kv).where(inArray(kv.key, CRITICAL_JOBS.map((n) => `job-health:${n}`)));
          for (const name of CRITICAL_JOBS) checks[name] = jobReady(states.find((r) => r.key === `job-health:${name}`)?.value as JobSnapshot | undefined);
        });
      } catch { checks.workers = false; checks.providers = false; }
    })(),
    (async () => {
      if (!ctx.cfg.chain.credits && !ctx.cfg.chain.callPay) { checks.chain = false; return; }
      try {
        await bounded(async () => {
          const [head, chainId] = await Promise.all([ctx.chain.blockNumber(), ctx.chain.client.getChainId()]);
          if (chainId !== ctx.cfg.chain.id) throw new Error("Chain mismatch");
          const [cursor] = await ctx.db.select().from(chainCursor).limit(1);
          checks.chain = !!cursor && head - cursor.block <= BigInt(Math.max(ctx.cfg.chain.confirmations + 20, 30)) && cursor.block <= head;
        });
      } catch { checks.chain = false; }
    })(),
    (async () => {
      try { await bounded(() => ctx.limiter.take("readiness", 0, 1, 60_000)); checks.rate_limiter = true; } catch { checks.rate_limiter = false; }
    })(),
  ]);
  checks.receipt_anchor_configured = !!ctx.cfg.chain.receiptAnchor;
  return { ok: Object.values(checks).every(Boolean), checks };
}
