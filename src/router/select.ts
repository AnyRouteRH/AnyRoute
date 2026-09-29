import type { Candidate, Modifier } from "../catalog/catalog.ts";
import { usdToPico } from "../lib/money.ts";
import { DISCLOSURE_MAX_VALUES, OUTAGE_REASON, UNDECLARED, classAllowed, disclosureClass, disclosureExclusion, type DisclosureClass, type DisclosureMax, type DisclosureProfile, type Lane } from "./disclosure.ts";

// Provider selection, OpenRouter-compatible:
//   candidates = providers.serving(model)
//     .filter(prefs: only/ignore/data_collection/zdr/quantizations/private->attested/disclosure+lane/max_price/require_parameters)
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
  /** Ceiling on how a prompt may be handled: "none" = attested retention only, "policy" = attested or documented no-retention policy, "any" = no filter (default). */
  disclosure?: DisclosureMax;
  /** "public" (default, no filter) or "attested" (implies disclosure "none"). "unlinkable" is refused before selection. */
  lane?: Lane;
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
  /** Disclosure profile of a provider (see router/disclosure.ts). Absent = every provider is undeclared, which no strict request accepts. */
  disclosure?: (providerId: string) => DisclosureProfile | undefined;
  rand?: () => number;
};

const PER_MILLION = 1_000_000n;

/** Effective per-token price used for weighting: blended 3:1 prompt:completion. */
export function blendedPrice(c: Candidate): number {
  return Number(c.pricePrompt * 3n + c.priceCompletion) / 4;
}

export function attestationFresh(c: Pick<Candidate, "provider">, maxAgeMs: number, production: boolean) {
  const p = c.provider;
  if (!p.attested || !p.attestationHash || !p.attestedAt || !p.teeKind) return false;
  if (production && p.teeKind === "dev") return false;
  const age = Date.now() - p.attestedAt.getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

/** The disclosure class this candidate's provider is served under right now. */
export function candidateDisclosure(c: Candidate, profile: DisclosureProfile | undefined, maxAgeMs: number, production: boolean): DisclosureClass {
  return disclosureClass(profile ?? UNDECLARED, attestationFresh(c, maxAgeMs, production));
}

/** The ceiling a request asks for. Anything unrecognised is read as the strictest setting, never a relaxed one. */
export function disclosureCeiling(prefs: Pick<ProviderPrefs, "disclosure" | "lane">): { max: DisclosureMax; lane: Lane } {
  const lane = prefs.lane == null ? "public" : prefs.lane;
  const asked = prefs.disclosure == null ? "any" : (DISCLOSURE_MAX_VALUES as readonly string[]).includes(prefs.disclosure) ? prefs.disclosure : "none";
  return { max: lane !== "public" ? "none" : asked, lane };
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

export function selectProviders(input: SelectInput): Selection {
  const { prefs, modifiers, health } = input;
  const excluded: Exclusion[] = [];
  const wantPrivate = prefs.private === true || modifiers.has("private");
  const wantFree = modifiers.has("free");
  const only = prefs.only?.length ? new Set(prefs.only.map((s) => s.toLowerCase())) : null;
  const ignore = new Set((prefs.ignore ?? []).map((s) => s.toLowerCase()));
  const quants = prefs.quantizations?.length ? new Set(prefs.quantizations.map((q) => q.toLowerCase())) : null;
  const maxPrompt = prefs.max_price?.prompt != null ? usdToPico(prefs.max_price.prompt) : null; // USD per 1M tokens
  const maxCompletion = prefs.max_price?.completion != null ? usdToPico(prefs.max_price.completion) : null;
  const maxRequest = prefs.max_price?.request != null ? usdToPico(prefs.max_price.request) : null;
  const byok = input.byokProviders ?? new Set<string>();
  const { max: disclosureMax, lane } = disclosureCeiling(prefs);

  const pass: Candidate[] = [];
  for (const c of input.offers) {
    const id = c.providerId.toLowerCase();
    const policy = (c.provider.dataPolicy ?? {}) as { training?: boolean; retains_prompts?: boolean; zdr?: boolean };
    const isFree = c.pricePrompt === 0n && c.priceCompletion === 0n && c.priceRequest === 0n;
    const cls = disclosureMax === "any" ? null : candidateDisclosure(c, input.disclosure?.(c.providerId), input.attestationMaxAgeMs, input.production);
    const reason =
      c.provider.status !== "live"
        ? `provider ${c.provider.status}`
        : c.status !== "live"
          ? `offer ${c.status}`
          : only && !only.has(id)
            ? "not in provider.only"
            : ignore.has(id)
              ? "in provider.ignore"
              : wantFree && !isFree
                ? "not free"
                : !wantFree && isFree && !byok.has(c.providerId) && input.offers.some((o) => o.pricePrompt > 0n || o.priceCompletion > 0n)
                  ? "free tier requires :free"
                  : prefs.data_collection === "deny" && (policy.training || policy.retains_prompts)
                    ? "data_collection=deny"
                    : prefs.zdr && !policy.zdr
                      ? "zdr required"
                      : quants && !quants.has((c.quant || "unknown").toLowerCase())
                        ? `quantization ${c.quant} not allowed`
                        : wantPrivate && !attestationFresh(c, input.attestationMaxAgeMs, input.production)
                          ? "private route requires a fresh TEE attestation"
                          : cls && !classAllowed(cls, disclosureMax)
                            ? disclosureExclusion(disclosureMax, lane, cls)
                            : maxPrompt != null && c.pricePrompt * PER_MILLION > maxPrompt
                              ? "above max_price.prompt"
                              : maxCompletion != null && c.priceCompletion * PER_MILLION > maxCompletion
                                ? "above max_price.completion"
                                : maxRequest != null && c.priceRequest > maxRequest
                                  ? "above max_price.request"
                                  : prefs.require_parameters &&
                                      input.requestParams.some((p) => !(c.supportedParameters ?? []).includes(p))
                                    ? "missing required parameters"
                                    : (c.ctx ?? Number.MAX_SAFE_INTEGER) < input.estimatedTokens
                                      ? "context length exceeded"
                                      : health.outage(c.modelId, c.providerId)
                                        ? OUTAGE_REASON
                                        : null;
    if (reason) excluded.push({ provider: c.providerId, reason });
    else pass.push(c);
  }

  const sortBy = modifiers.has("nitro")
    ? "throughput"
    : modifiers.has("floor")
      ? "price"
      : typeof prefs.sort === "string"
        ? prefs.sort
        : prefs.sort?.by;

  const stake = (c: Candidate) => c.provider.anyrStake ?? 0n;
  const tieBreak = (a: Candidate, b: Candidate) => (stake(b) > stake(a) ? 1 : stake(b) < stake(a) ? -1 : a.providerId.localeCompare(b.providerId));
  const p50 = (c: Candidate, k: "latency" | "throughput") => health.stats(c.modelId, c.providerId)?.[k]?.p50;

  let ordered: Candidate[];
  if (sortBy === "price") {
    ordered = [...pass].sort((a, b) => blendedPrice(a) - blendedPrice(b) || tieBreak(a, b));
  } else if (sortBy === "throughput") {
    ordered = [...pass].sort((a, b) => (p50(b, "throughput") ?? -1) - (p50(a, "throughput") ?? -1) || tieBreak(a, b));
  } else if (sortBy === "latency") {
    ordered = [...pass].sort(
      (a, b) => (p50(a, "latency") ?? Number.MAX_SAFE_INTEGER) - (p50(b, "latency") ?? Number.MAX_SAFE_INTEGER) || tieBreak(a, b),
    );
  } else {
    const minPrice = Math.min(...pass.map((c) => blendedPrice(c)).filter((p) => p > 0), Number.MAX_VALUE);
    ordered = weightedShuffle(
      pass,
      (c) => {
        const price = Math.max(blendedPrice(c), minPrice === Number.MAX_VALUE ? 1 : minPrice / 10);
        const rel = price / (minPrice === Number.MAX_VALUE ? 1 : minPrice); // scale-free
        return (1 / (rel * rel)) * health.uptime30d(c.modelId, c.providerId) * health.quality(c.modelId, c.providerId);
      },
      input.rand,
    );
  }

  // Preferred throughput/latency: providers that miss the target move to the back, in order.
  if (prefs.preferred_min_throughput != null || prefs.preferred_max_latency != null) {
    const good = ordered.filter((c) => meetsPreferred(c, health, prefs.preferred_min_throughput, prefs.preferred_max_latency));
    ordered = [...good, ...ordered.filter((c) => !good.includes(c))];
  }

  // Pinned order: listed providers first, in the given order.
  if (prefs.order?.length) {
    const byId = new Map(ordered.map((c) => [c.providerId.toLowerCase(), c]));
    const pinned = prefs.order.map((id) => byId.get(id.toLowerCase())).filter((c): c is Candidate => !!c);
    const rest = ordered.filter((c) => !pinned.includes(c));
    ordered = prefs.allow_fallbacks === false ? pinned : [...pinned, ...rest];
  } else if (prefs.allow_fallbacks === false) {
    ordered = ordered.slice(0, 1);
  }

  return { ordered, excluded };
}
