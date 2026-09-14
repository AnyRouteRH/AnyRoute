import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { generations, health, offers, providers, slashes } from "../db/schema.ts";
import { post } from "../ledger/ledger.ts";
import { allocate, mulBps, usdgToPico } from "../lib/money.ts";
import { canonicalJson, log, uid } from "../lib/util.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { latestCanaries } from "./canaries.ts";

// Evidence -> proposal -> 72h dispute window -> execute; refunds affected callers from the slash.
// Schedule: empty-200 > 2% over 24h -> 1% of bond; quant fraud (3/3 canaries) -> 25% + delist;
// uptime < 95% over 30d -> 0.5% per day. Disputes never block routing; a dispute unresolved for
// more than 72h past its window auto-refunds the affected callers from margin.

const KIND_CODE: Record<string, number> = { empty200: 0, quant_fraud: 1, uptime: 2, param_drop: 3 };
const DAY = 86_400_000;

type Evidence = { kind: keyof typeof KIND_CODE; modelId: string | null; bps: number; delist: boolean; items: unknown[]; window: { from: string; to: string } };

export function evidenceRoot(items: unknown[]): Hex {
  const leaves = (items.length ? items : [{ empty: true }]).map((i) => keccak256(keccak256(toBytes(canonicalJson(i)))));
  return new MerkleTree(leaves).root;
}

export async function gatherEvidence(ctx: Ctx, providerId: string, now = Date.now()): Promise<Evidence[]> {
  const out: Evidence[] = [];
  const since24 = new Date(now - DAY);
  // Empty-200 rate over 24h (traffic only), minimum sample 50.
  const e = await ctx.db
    .select({ modelId: health.modelId, n: sql<number>`count(*)::int`, empty: sql<number>`count(*) FILTER (WHERE ${health.empty200})::int`, callers: sql<number>`count(DISTINCT ${health.caller}) FILTER (WHERE ${health.empty200})::int` })
    .from(health)
    .where(and(eq(health.providerId, providerId), eq(health.source, "traffic"), gte(health.ts, since24)))
    .groupBy(health.modelId);
  const total = e.reduce((a, r) => a + r.n, 0);
  const empty = e.reduce((a, r) => a + r.empty, 0);
  // Evidence must come from several independent callers so one account can't get a provider slashed.
  const callers = e.reduce((a, r) => Math.max(a, r.callers), 0);
  if (total >= 50 && empty / total > ctx.cfg.routing.empty200SlashThreshold && callers >= 5)
    out.push({ kind: "empty200", modelId: null, bps: 100, delist: false, items: e.map((r) => ({ model: r.modelId, requests: r.n, empty200: r.empty })), window: { from: since24.toISOString(), to: new Date(now).toISOString() } });

  // Quantization fraud: the three most recent canaries all mismatch.
  const modelIds = (await ctx.db.select({ m: offers.modelId }).from(offers).where(eq(offers.providerId, providerId))).map((r) => r.m);
  const latest = await latestCanaries(ctx, providerId, modelIds, 3);
  for (const [modelId, list] of latest) {
    if (list.length === 3 && list.every((c) => c.quantMatch === false))
      out.push({
        kind: "quant_fraud",
        modelId,
        bps: 2500,
        delist: true,
        items: list.map((c) => ({ model: modelId, ts: c.ts.toISOString(), guess: c.quantGuess, distance: c.distance, detail: c.detail })),
        window: { from: list[2].ts.toISOString(), to: list[0].ts.toISOString() },
      });
  }

  // Uptime over 30 days, minimum sample 1000 events.
  const since30 = new Date(now - 30 * DAY);
  const [u] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, ok: sql<number>`count(*) FILTER (WHERE ${health.ok})::int` })
    .from(health)
    .where(and(eq(health.providerId, providerId), gte(health.ts, since30), sql`(${health.ok} OR (${health.errorKind} IS DISTINCT FROM 'rejected' AND ${health.errorKind} IS DISTINCT FROM 'rate_limited'))`));
  if (u && u.n >= 1000 && u.ok / u.n < ctx.cfg.routing.uptimeSlashThreshold)
    out.push({ kind: "uptime", modelId: null, bps: 50, delist: false, items: [{ events: u.n, ok: u.ok, uptime: u.ok / u.n }], window: { from: since30.toISOString(), to: new Date(now).toISOString() } });
  return out;
}

/** Create proposals (at most one open per provider x kind x day). */
export async function runSlasher(ctx: Ctx, now = Date.now()) {
  // Execute matured proposals first so a delisted provider is not re-proposed.
  const executed = await executeReady(ctx, now);
  const autoRefunded = await autoRefundStaleDisputes(ctx, now);
  const live = await ctx.db.select().from(providers).where(inArray(providers.status, ["live", "shadow"]));
  const proposed: unknown[] = [];
  for (const p of live) {
    const bond = (await ctx.chain.bondOf(keccak256(toBytes(p.id))).catch(() => null)) ?? p.bondUsdg;
    for (const ev of await gatherEvidence(ctx, p.id, now)) {
      // Uptime accrues 0.5%/day, so one proposal per day; other kinds: one open proposal at a time.
      const [open] = await ctx.db
        .select({ id: slashes.id })
        .from(slashes)
        .where(
          and(
            eq(slashes.providerId, p.id),
            eq(slashes.kind, ev.kind),
            ...(ev.modelId ? [eq(slashes.modelId, ev.modelId)] : []),
            ev.kind === "uptime" ? gte(slashes.proposedAt, new Date(now - DAY)) : inArray(slashes.status, ["proposed", "disputed"]),
          ),
        );
      if (open) continue;
      const amount = (bond * BigInt(ev.bps)) / 10_000n;
      const root = evidenceRoot(ev.items);
      const id = uid("slash_");
      await ctx.db.insert(slashes).values({
        id,
        providerId: p.id,
        modelId: ev.modelId,
        kind: ev.kind,
        amountUsdg: amount,
        delist: ev.delist,
        evidenceRoot: root,
        evidence: { items: ev.items, window: ev.window, bond: bond.toString(), bps: ev.bps },
        executableAt: new Date(now + 72 * 3_600_000),
      });
      // Quantization fraud: stop sending real traffic to that model on this provider right away
      // (it stays in shadow, still canaried). The provider is delisted only when the slash executes.
      if (ev.kind === "quant_fraud" && ev.modelId) {
        await ctx.db.update(offers).set({ status: "shadow", updatedAt: new Date() }).where(and(eq(offers.providerId, p.id), eq(offers.modelId, ev.modelId)));
        await ctx.catalog.refresh();
      }
      let chain: unknown = null;
      if (amount > 0n && ctx.chain.address("providerBond")) {
        try {
          chain = await ctx.chain.proposeSlash(keccak256(toBytes(p.id)), KIND_CODE[ev.kind], amount, root, ev.delist);
          const r = chain as { submitted: boolean; slashId?: bigint | null; hash?: string };
          if (r.submitted) await ctx.db.update(slashes).set({ onchainId: r.slashId?.toString() ?? null, txHash: r.hash ?? null }).where(eq(slashes.id, id));
        } catch (e) {
          log.error("slash proposal failed on-chain", { provider: p.id, error: (e as Error).message });
        }
      }
      proposed.push({ id, provider: p.id, kind: ev.kind, amount_usdg: amount.toString(), evidence_root: root, chain });
      log.warn("slash proposed", { provider: p.id, kind: ev.kind, amount: amount.toString() });
    }
  }
  return { proposed, executed, autoRefunded };
}

/** Callers who paid for affected generations during the evidence window. */
async function affectedCallers(ctx: Ctx, s: typeof slashes.$inferSelect) {
  const w = (s.evidence as { window?: { from: string; to: string } }).window;
  if (!w || s.kind !== "quant_fraud") return [];
  return ctx.db
    .select({ accountId: generations.accountId, cost: sql<string>`sum(${generations.cost})` })
    .from(generations)
    .where(and(eq(generations.providerId, s.providerId), ...(s.modelId ? [eq(generations.modelId, s.modelId)] : []), gte(generations.ts, new Date(w.from)), lte(generations.ts, new Date(w.to))))
    .groupBy(generations.accountId);
}

async function refund(ctx: Ctx, s: typeof slashes.$inferSelect, pool: bigint, tag: string) {
  const callers = (await affectedCallers(ctx, s)).filter((c) => c.accountId);
  if (!callers.length || pool <= 0n) return 0n;
  const owed = callers.map((c) => BigInt(c.cost));
  const totalOwed = owed.reduce((a, b) => a + b, 0n);
  const budget = pool < totalOwed ? pool : totalOwed;
  const parts = allocate(budget, owed);
  let paid = 0n;
  for (let i = 0; i < callers.length; i++) {
    if (parts[i] <= 0n) continue;
    const ok = await post(ctx.db, { accountId: callers[i].accountId!, amount: parts[i], kind: "refund", ref: `${tag}:${s.id}:${callers[i].accountId}`, description: `Refund: ${s.kind} by ${s.providerId}` });
    if (ok) paid += parts[i];
  }
  return paid;
}

async function executeReady(ctx: Ctx, now: number) {
  const ready = await ctx.db.select().from(slashes).where(and(eq(slashes.status, "proposed"), lte(slashes.executableAt, new Date(now))));
  const out: unknown[] = [];
  for (const s of ready) {
    let chain: unknown = null;
    if (s.onchainId && ctx.chain.address("providerBond")) {
      try {
        chain = await ctx.chain.executeSlash(BigInt(s.onchainId));
      } catch (e) {
        log.error("slash execution failed", { id: s.id, error: (e as Error).message });
        continue;
      }
    }
    const refunded = await refund(ctx, s, usdgToPico(s.amountUsdg), "slashrefund");
    await ctx.db.update(slashes).set({ status: "executed", executedAt: new Date(now), refunded }).where(eq(slashes.id, s.id));
    if (s.delist) {
      await ctx.db.update(providers).set({ status: "delisted", updatedAt: new Date() }).where(eq(providers.id, s.providerId));
      await ctx.db.update(offers).set({ status: "disabled" }).where(eq(offers.providerId, s.providerId));
    }
    out.push({ id: s.id, refunded: refunded.toString(), chain });
  }
  if (out.length) await ctx.catalog.refresh();
  return out;
}

async function autoRefundStaleDisputes(ctx: Ctx, now: number) {
  const stale = await ctx.db.select().from(slashes).where(and(eq(slashes.status, "disputed"), lte(slashes.executableAt, new Date(now - 72 * 3_600_000))));
  const out: unknown[] = [];
  for (const s of stale) {
    // Refund from margin: the router eats it; the dispute continues but callers are made whole.
    const callers = await affectedCallers(ctx, s);
    const total = callers.reduce((a, c) => a + BigInt(c.cost), 0n);
    const refunded = await refund(ctx, s, total, "disputerefund");
    await ctx.db.update(slashes).set({ status: "auto_refunded", refunded }).where(eq(slashes.id, s.id));
    out.push({ id: s.id, refunded: refunded.toString() });
  }
  return out;
}

export { mulBps };
