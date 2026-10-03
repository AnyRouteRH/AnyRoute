// The commerce ledger page (/commerce): reads GET /api/v1/commerce/stats and turns it into what the page shows.
// Every figure is shown as a pair, filtered first and gross beside it; nothing here produces a gross number alone.

export const COMMERCE_PATH = "/api/v1/commerce/stats";
export const REFRESH_MS = 60_000;
export const WINDOW_NAMES = ["24h", "7d", "30d"];
export const WINDOW_LABELS = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
export const EXCLUSIONS = [
  { key: "unanchored", label: "Not anchored on chain" },
  { key: "same_owner", label: "Same owner" },
  { key: "round_trip", label: "Round trip within 24 hours" },
  { key: "funding_link", label: "Linked by funding" },
];
export const DUNE_QUERY_URL = "https://github.com/AnyRouteRH/AnyRoute/blob/main/integrations/dune/commerce.sql";

const count = v => Number.isSafeInteger(v) && v >= 0;
const units = v => typeof v === "string" && /^\d+$/.test(v);
const rate = v => v === null || (typeof v === "number" && v >= 0 && v <= 1);

function validFigures(f) {
  return !!f && [f.settlements, f.payers, f.payees, f.refunds].every(count) && units(f.volume_usdg)
    && (f.median_price_usdg === null || units(f.median_price_usdg)) && rate(f.refund_rate) && f.refunds <= f.settlements;
}
function validBlock(b) {
  return !!b && validFigures(b.gross) && validFigures(b.filtered) && !!b.excluded
    && EXCLUSIONS.every(e => count(b.excluded[e.key])) && b.filtered.settlements <= b.gross.settlements
    && b.filtered.settlements + EXCLUSIONS.reduce((n, e) => n + b.excluded[e.key], 0) === b.gross.settlements;
}

/** A response is shown only when every block carries both gross and filtered figures that add up. */
export function validCommerceStats(data) {
  if (!data || !Number.isFinite(Date.parse(data.as_of)) || !Array.isArray(data.kinds) || !data.windows || !data.filters?.funding) return false;
  if (!data.kinds.every(k => typeof k?.kind === "string" && typeof k.label === "string" && typeof k.wired === "boolean")) return false;
  for (const name of WINDOW_NAMES) {
    const w = data.windows[name];
    if (!w || !validBlock(w.total) || !w.kinds) return false;
    for (const k of data.kinds) if (!validBlock(w.kinds[k.kind])) return false;
  }
  return true;
}

/** { state: "ok", data } | { state: "off" } (404: not switched on here) | { state: "error" }. */
export async function fetchCommerceStats(base = "", fetcher = fetch, signal) {
  try {
    const response = await fetcher(base + COMMERCE_PATH, { credentials: "omit", cache: "no-store", signal, headers: { accept: "application/json" } });
    if (response.status === 404) return { state: "off" };
    if (!response.ok) return { state: "error" };
    const { data } = await response.json();
    return validCommerceStats(data) ? { state: "ok", data } : { state: "error" };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return { state: "error" };
  }
}

/** USDG base units (6 decimals) as a plain decimal with thousands separators: "1234500000" -> "1,234.5". */
export function formatUsdg(value) {
  if (value === null || value === undefined) return null;
  const n = BigInt(value);
  const whole = (n / 1_000_000n).toLocaleString("en-US");
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const int = v => Number(v).toLocaleString("en-US");
const pct = v => (v === null ? null : `${(Math.round(v * 1000) / 10).toLocaleString("en-US")}%`);

/** The paired figures for one block: filtered and gross text for each measure. */
export function pairs(block) {
  const g = block.gross, f = block.filtered;
  const usdg = v => (v === null ? "none" : `${formatUsdg(v)} USDG`);
  return [
    { key: "settlements", label: "Settlements", filtered: int(f.settlements), gross: int(g.settlements) },
    { key: "payers", label: "Distinct payers", filtered: int(f.payers), gross: int(g.payers) },
    { key: "payees", label: "Distinct payees", filtered: int(f.payees), gross: int(g.payees) },
    { key: "volume", label: "Settled volume", filtered: usdg(f.volume_usdg), gross: usdg(g.volume_usdg) },
    { key: "median", label: "Median price", filtered: usdg(f.median_price_usdg), gross: usdg(g.median_price_usdg) },
    { key: "refunds", label: "Refund rate", filtered: pct(f.refund_rate) ?? "none", gross: pct(g.refund_rate) ?? "none" },
  ];
}

/** Solid bar segments for a block: what passed, then each exclusion, as shares of the gross count. */
export function segments(block) {
  const total = block.gross.settlements;
  const parts = [{ key: "filtered", label: "Counted", n: block.filtered.settlements }, ...EXCLUSIONS.map(e => ({ key: e.key, label: e.label, n: block.excluded[e.key] }))];
  return parts.filter(p => p.n > 0).map(p => ({ ...p, share: total ? p.n / total : 0, text: `${int(p.n)} ${p.label.toLowerCase()}` }));
}

/** Everything the page shows for one window. */
export function describeWindow(data, name) {
  const w = data.windows[name];
  const kinds = data.kinds.map(k => {
    const b = w.kinds[k.kind];
    return { kind: k.kind, label: k.label, wired: k.wired, empty: b.gross.settlements === 0, pairs: pairs(b), segments: segments(b),
      share: w.total.gross.settlements ? b.gross.settlements / w.total.gross.settlements : 0 };
  });
  const f = data.filters.funding;
  return {
    name, label: WINDOW_LABELS[name], empty: w.total.gross.settlements === 0,
    headline: pairs(w.total), segments: segments(w.total), kinds,
    excluded: EXCLUSIONS.map(e => ({ ...e, n: w.total.excluded[e.key] })),
    funding: f.available
      ? `Funding links are checked within ${f.hops} transfers of at least ${formatUsdg(f.min_units)} USDG, from block ${f.from_block}, read up to block ${f.indexed_block}.`
      : "Funding links are not checked on this router: it keeps no copy of USDG transfers yet. The other three rules still apply.",
    asOf: data.as_of.replace("T", " ").replace(/\.\d+Z$/, " UTC"),
  };
}
