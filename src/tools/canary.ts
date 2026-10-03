import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { usdToPico, usdgToPico } from "../lib/money.ts";
import { log, sha256 } from "../lib/util.ts";
import { toolCanaryRuns, toolListings } from "./schema.ts";
import { egressFetch, type ToolFetch } from "./fetch.ts";
import { quoteTool, reserveCanarySpend, sendPaid, toolRequest } from "./call.ts";
import { signPayment } from "./x402.ts";
import { DELIST_AFTER, probeAddress, type ListingRow } from "./catalog.ts";

// Tool canaries (the treatment src/services/canaries.ts gives models): once per TOOLS_CANARY_INTERVAL_MS each listed
// tool gets a paid probe with its known answer. The buyer wallet pays the seller's price; no key is charged. Three
// failures in a row delist the tool automatically; the state and the last runs show on its listing.

export type ProbeResult = { ok: boolean; failure: string | null; latencyMs: number; priceUnits: bigint | null; settleTx: string | null } | { skipped: string };

export async function probeListing(ctx: Ctx, row: ListingRow, fetchImpl: ToolFetch): Promise<ProbeResult> {
  const started = Date.now();
  const failed = (failure: string, priceUnits: bigint | null = null, settleTx: string | null = null) => ({ ok: false, failure, latencyMs: Date.now() - started, priceUnits, settleTx });
  const req = toolRequest(ctx, { resource: probeAddress(row.resource, row.canary.query), method: row.canary.method, ...(row.canary.body !== undefined ? { body: row.canary.body } : {}) });
  let offer;
  try {
    offer = await quoteTool(ctx, req, fetchImpl);
  } catch (e) {
    return failed(e instanceof ApiError ? e.type : "unreachable");
  }
  if (offer.payTo.toLowerCase() !== row.payTo.toLowerCase()) return failed("pay_to_changed");
  if (usdgToPico(offer.amount) > usdToPico(ctx.cfg.tools.canaryMaxPriceUsd)) return { skipped: "price_above_canary_cap" };
  if (!(await reserveCanarySpend(ctx, offer.amount))) return { skipped: "daily_limit" };
  const signed = await signPayment(ctx, ctx.cfg.tools.buyer!, offer);
  const result = await sendPaid(ctx, req, signed, fetchImpl);
  if (!result.ok) return failed(result.failure, offer.amount, result.settleTx);
  const answer = "json" in result.parsed ? JSON.stringify(result.parsed.json) : result.parsed.text;
  const expect = row.canary.expect;
  const right = expect.sha256 ? result.sha256 === expect.sha256 || sha256(answer) === expect.sha256 : answer.includes(expect.contains ?? "");
  return right ? { ok: true, failure: null, latencyMs: Date.now() - started, priceUnits: offer.amount, settleTx: result.settleTx } : failed("wrong_answer", offer.amount, result.settleTx);
}

/** Record one probe and apply the delisting rule. Returns the listing's new state. */
export async function recordProbe(ctx: Ctx, row: ListingRow, r: Exclude<ProbeResult, { skipped: string }>, now = new Date()) {
  await ctx.db.insert(toolCanaryRuns).values({ sellerId: row.id, ok: r.ok, latencyMs: r.latencyMs, failure: r.failure, priceUnits: r.priceUnits, settleTx: r.settleTx, at: now });
  const failures = r.ok ? 0 : row.failures + 1;
  const delist = !r.ok && failures >= DELIST_AFTER;
  const [updated] = await ctx.db.update(toolListings).set({ failures, checkedAt: now, updatedAt: now, ...(delist ? { status: "delisted", delistedAt: now } : {}) })
    .where(and(eq(toolListings.id, row.id), eq(toolListings.status, "listed"))).returning();
  if (delist) log.warn("tool delisted after failed canaries", { seller: row.id, failures });
  return updated ?? row;
}

/** Worker job tools-canary. Probes listed tools not checked within the interval, oldest first, at most 50 per run. */
export async function runToolCanaries(ctx: Ctx, o: { fetch?: ToolFetch; now?: Date; force?: boolean } = {}) {
  if (!ctx.cfg.tools.enabled) return { skipped: "TOOLS_MARKET_ENABLED is off" };
  if (!ctx.cfg.tools.buyer) return { skipped: "no buyer wallet" };
  const now = o.now ?? new Date();
  const due = new Date(now.getTime() - Math.floor(ctx.cfg.tools.canaryIntervalMs * 0.9));
  const rows = await ctx.db.select().from(toolListings)
    .where(and(eq(toolListings.status, "listed"), o.force ? sql`true` : or(isNull(toolListings.checkedAt), lt(toolListings.checkedAt, due))))
    .orderBy(asc(sql`coalesce(${toolListings.checkedAt}, to_timestamp(0))`)).limit(50);
  const fetchImpl = o.fetch ?? egressFetch(ctx);
  let ok = 0, failed = 0, skipped = 0, delisted = 0;
  for (const row of rows) {
    let r: ProbeResult;
    try {
      r = await probeListing(ctx, row, fetchImpl);
    } catch {
      r = { ok: false, failure: "probe_error", latencyMs: 0, priceUnits: null, settleTx: null };
    }
    if ("skipped" in r) { skipped++; continue; }
    const after = await recordProbe(ctx, row, r, now);
    if (r.ok) ok++; else failed++;
    if (after.status === "delisted") delisted++;
  }
  // Probe history is kept for 90 days.
  await ctx.db.delete(toolCanaryRuns).where(lt(toolCanaryRuns.at, new Date(now.getTime() - 90 * 86_400_000)));
  return { probed: rows.length - skipped, ok, failed, skipped, delisted };
}
