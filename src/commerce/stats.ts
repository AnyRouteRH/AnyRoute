import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import { statsCache } from "../network/stats.ts";
import { loadFunding } from "./funding.ts";
import { COMMERCE_KINDS, LOOKBACK_MS, ROUND_TRIP_MS, classify, isAddress, report, type Settlement } from "./ledger.ts";
import { commerceSources, operatorAddresses } from "./sources.ts";

// GET /api/v1/commerce/stats (COMMERCE_STATS_ENABLED): the honest commerce ledger. Public, read-only, cached 60 seconds.
// Every figure comes in a gross and a filtered version side by side; see ledger.ts for the filters and
// web/components/CommerceStatsDocs.jsx (/docs/#commerce-stats) for the published methodology. The response holds counts,
// sums and medians only: no payer, payee, transaction, receipt or single settlement, and no split by privacy lane.

export const COMMERCE_STATS_CACHE_MS = 60_000;
export const DUNE_QUERY_PATH = "integrations/dune/commerce.sql";

export async function readCommerceStats(ctx: Ctx, asOf = new Date()) {
  const since = new Date(asOf.getTime() - LOOKBACK_MS);
  const sources = commerceSources();
  const settlements: Settlement[] = [];
  for (const source of sources) {
    for (const s of await source.read(ctx, since, asOf)) settlements.push({ ...s, kind: source.kind });
  }
  const f = ctx.cfg.commerce.funding;
  const funding = await loadFunding(ctx, {
    payers: [...new Set(settlements.map((s) => s.payer).filter(isAddress))],
    payees: [...new Set(settlements.map((s) => s.payee).filter(isAddress))],
    settlementTxs: [...new Set(settlements.flatMap((s) => (s.txHash ? [s.txHash] : [])))],
    since,
  });
  const reasons = classify(settlements, funding?.view ?? null, operatorAddresses(ctx));
  const wired = new Set(sources.map((s) => s.kind));
  const known = COMMERCE_KINDS.map((k) => k.kind as string);
  const extra = [...wired].filter((k) => !known.includes(k));
  return {
    as_of: asOf.toISOString(),
    cache_seconds: COMMERCE_STATS_CACHE_MS / 1000,
    currency: { asset: "USDG", decimals: 6, units: "base units (1 USDG = 1000000)" },
    kinds: [...COMMERCE_KINDS.map((k) => ({ kind: k.kind, label: k.label, wired: wired.has(k.kind) })), ...extra.map((k) => ({ kind: k, label: k, wired: true }))],
    filters: {
      anchored_only: true,
      same_owner: true,
      round_trip_hours: ROUND_TRIP_MS / 3_600_000,
      funding: {
        available: funding !== null,
        hops: f.hops,
        min_units: f.minUnits.toString(),
        hub_fanout: f.hubFanout,
        from_block: f.fromBlock?.toString() ?? null,
        indexed_block: funding?.indexedBlock.toString() ?? null,
        indexed_at: funding?.indexedAt.toISOString() ?? null,
      },
    },
    windows: report(settlements, reasons, asOf, [...known, ...extra]),
    methodology_url: "/docs/#commerce-stats",
    dune_query: DUNE_QUERY_PATH,
  };
}

export type CommerceStats = Awaited<ReturnType<typeof readCommerceStats>>;

/** The /api/v1/status section: what is switched on, stated plainly. */
export function commerceStatus(ctx: Ctx) {
  const on = ctx.cfg.commerce.enabled;
  return {
    enabled: on,
    stats_url: on ? "/api/v1/commerce/stats" : null,
    kinds: on ? commerceSources().map((s) => s.kind) : [],
    // Settlements count as filtered only once their receipts are in a root confirmed on ReceiptAnchor; with no
    // ReceiptAnchor configured, every settlement is reported as unanchored.
    receipt_anchor_configured: !!ctx.chain.address("receiptAnchor"),
    funding_filter: on && ctx.cfg.commerce.funding.fromBlock !== null,
  };
}

export function commerceStatsRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.commerce.enabled) return;
  const get = statsCache(() => readCommerceStats(ctx), Date.now, COMMERCE_STATS_CACHE_MS);
  app.get("/api/v1/commerce/stats", async (c) => {
    try {
      const result = await get();
      // HTTP freshness never outlives the in-process snapshot.
      c.header("Cache-Control", `public, max-age=${Math.max(0, Math.floor((result.expires - Date.now()) / 1000))}, must-revalidate`);
      return c.json({ data: result.data });
    } catch (e) {
      log.warn("commerce stats unavailable", { error: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200) });
      c.header("Cache-Control", "no-store");
      fail(503, "Commerce statistics unavailable.", "unavailable");
    }
  });
}
