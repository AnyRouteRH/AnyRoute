import type { Candidate, Modifier } from "../catalog/catalog.ts";
import { usdToPico } from "../lib/money.ts";

// Provider selection, OpenRouter-compatible:
//   candidates = providers.serving(model)
//     .filter(prefs: only/ignore/data_collection/zdr/quantizations/private->attested/max_price/require_parameters)
//     .filter(p => !outage(p, 30s))
//   weights = 1/price^2 x uptime30d x qualityScore(model,p)     // quality in [0.5, 1.0] from canaries
//   order = prefs.order ?? (sort ? sortBy(sort) : weightedShuffle(weights))

export type Percentiles = { p50?: number; p75?: number; p90?: number; p99?: number };
export type ProviderPrefs = {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: "price" | "throughput" | "latency" | { by: "price" | "throughput" | "latency"; partition?: string };
  preferred_min_throughput?: number | Percentiles;
  preferred_max_latency?: number | Percentiles;
  max_price?: { prompt?: number | string; completion?: number | string; request?: number | string; image?: number | string };
  private?: boolean;
};

export interface HealthView {
  outage(modelId: string, providerId: string): boolean;
  uptime30d(modelId: string, providerId: string): number;
  quality(modelId: string, providerId: string): number;
  stats(modelId: string, providerId: string): { latency: Percentiles; throughput: Percentiles } | null;
}

export type Exclusion = { provider: string; reason: string };
export type Selection = { ordered: Candidate[]; excluded: Exclusion[] };

export type SelectInput = {
  modelId: string;
  offers: Candidate[];
  prefs: ProviderPrefs;
  modifiers: Set<Modifier>;
  requestParams: string[];
  estimatedTokens: number;
  byokProviders?: Set<string>;
  health: HealthView;
  production: boolean;
  attestationMaxAgeMs: number;
  rand?: () => number;
};

const PER_MILLION = 1_000_000n;

/** Effective per-token price used for weighting: blended 3:1 prompt:completion. */
export function blendedPrice(c: Candidate): number {
  return Number(c.pricePrompt * 3n + c.priceCompletion) / 4;
}

export function attestationFresh(c: Candidate, maxAgeMs: number, production: boolean) {
  const p = c.provider;
  if (!p.attested || !p.attestationHash || !p.attestedAt) return false;
  if (production && p.teeKind === "dev") return false;
  return Date.now() - p.attestedAt.getTime() <= maxAgeMs;
}

function metric(p: Percentiles | undefined, key: keyof Percentiles) {
  return p?.[key] ?? undefined;
}

function meetsPreferred(
  c: Candidate,
  health: HealthView,
  minTps: number | Percentiles | undefined,
  maxLatency: number | Percentiles | undefined,
): boolean {
  const s = health.stats(c.modelId, c.providerId);
  if (!s) return true; // no data yet: don't penalize
  const check = (want: number | Percentiles | undefined, have: Percentiles, cmp: (h: number, w: number) => boolean) => {
    if (want == null) return true;
    const reqs: Percentiles = typeof want === "number" ? { p50: want } : want;
    for (const k of ["p50", "p75", "p90", "p99"] as const) {
      const w = reqs[k];
      const h = metric(have, k);
      if (w != null && h != null && !cmp(h, w)) return false;
    }
    return true;
  };
  return check(minTps, s.throughput, (h, w) => h >= w) && check(maxLatency, s.latency, (h, w) => h <= w);
}

/** Efraimidis–Spirakis weighted random order (sampling without replacement). */
export function weightedShuffle<T>(items: T[], weight: (t: T) => number, rand: () => number = Math.random): T[] {
  return items
    .map((item) => {
      const w = Math.max(weight(item), 1e-300);
      return { item, key: Math.log(Math.max(rand(), 1e-12)) / w };
    })
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}
