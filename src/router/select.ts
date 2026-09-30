import type { Candidate, Modifier } from "../catalog/catalog.ts";
import { usdToPico } from "../lib/money.ts";
import { NOT_SERVABLE_REASON, isRestricted, restrictedExclusion, type ModelLane } from "./lane.ts";
import { DISCLOSURE_MAX_VALUES, OUTAGE_REASON, UNDECLARED, classAllowed, disclosureClass, disclosureExclusion, type DisclosureClass, type DisclosureMax, type DisclosureProfile, type Lane } from "./disclosure.ts";

// Provider selection, OpenRouter-compatible:
//   candidates = providers.serving(model)
//     .filter(prefs: only/ignore/data_collection/zdr/quantizations/private->attested/disclosure+lane/max_price/require_parameters)
//     .filter(p => !outage(p, 30s))
//   weights = uptime30d x qualityScore(model,p) x attested_bonus / price^2   // quality in [0.5, 1.0] from canaries
//   order = prefs.order ?? (sort ? sortBy(sort) : weightedShuffle(weights))
//
// Lanes (router/disclosure.ts): "attested" and "unlinkable" admit only endpoints served under the attested class
// (declared attested retention and a fresh, verified attestation) and never fall back to any other; "public" admits
// every endpoint and gives attested ones `attested_bonus` (default 1.25) in the weight above.

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
  /** "public" (default, no filter), "attested" or "unlinkable" (both imply disclosure "none"). Whether a request may use "unlinkable" is decided before selection. */
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
  /**
   * The variant and status of the model being routed (catalog.laneOf). Every caller in the router passes it: a
   * restricted variant (abliterated, native_low_refusal) is offered only by attested providers whose attestation
   * reports the in-enclave classifier as enabled, and a model that is not approved for serving is offered by none.
   * Left out, the model is treated as mainstream.
   */
  modelLane: ModelLane;
  /**
   * Weight multiplier for an endpoint served under the attested class, by lane (config ATTESTED_BONUS_*). Left out,
   * DEFAULT_ATTESTED_BONUS applies. Values below 1 are read as 1: attestation never lowers a weight.
   */
  attestedBonus?: Partial<Record<Lane, number>>;
  rand?: () => number;
};

/** Default attested bonus per lane: attested endpoints get a quarter more weight on the public lane. */
export const DEFAULT_ATTESTED_BONUS: Readonly<Record<Lane, number>> = Object.freeze({ public: 1.25, attested: 1, unlinkable: 1 });

/**
 * The selection weight of one endpoint within its lane: uptime x quality x attested_bonus / price^2, with price taken
 * relative to the cheapest priced endpoint of the request (scale-free) and floored at a tenth of it, so a free or
 * near-free endpoint cannot take every request. `attested` must come from the router's own attestation checks.
 */
export function selectionWeight(o: { price: number; minPrice: number; uptime: number; quality: number; attested: boolean; bonus: number }): number {
  const min = o.minPrice === Number.MAX_VALUE || !(o.minPrice > 0) ? 1 : o.minPrice;
  const price = Math.max(o.price, o.minPrice === Number.MAX_VALUE ? 1 : min / 10);
  const rel = price / min;
  const bonus = o.attested && Number.isFinite(o.bonus) ? Math.max(1, o.bonus) : 1;
  return (o.uptime * o.quality * bonus) / (rel * rel);
}

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

/**
 * Efraimidis–Spirakis weighted random order (sampling without replacement). Equal keys (the same draw at the same
 * weight) are ordered by the higher weight, then by `tie`, so the order never depends on the order of `items`.
 */
export function weightedShuffle<T>(items: T[], weight: (t: T) => number, rand: () => number = Math.random, tie?: (a: T, b: T) => number): T[] {
  return items
    .map((item) => {
      const w = Math.max(weight(item), 1e-300);
      return { item, w, key: Math.log(Math.max(rand(), 1e-12)) / w };
    })
    .sort((a, b) => b.key - a.key || b.w - a.w || (tie ? tie(a.item, b.item) : 0))
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
  const restricted = isRestricted(input.modelLane?.variant);
  const servable = input.modelLane?.servable !== false;
  const bonus = input.attestedBonus?.[lane] ?? DEFAULT_ATTESTED_BONUS[lane];
  // The class each passing candidate is served under, when a rule or the weight needs it (computed once per candidate).
  const classes = new Map<Candidate, DisclosureClass>();

  const pass: Candidate[] = [];
  for (const c of input.offers) {
    const id = c.providerId.toLowerCase();
    const policy = (c.provider.dataPolicy ?? {}) as { training?: boolean; retains_prompts?: boolean; zdr?: boolean };
    const isFree = c.pricePrompt === 0n && c.priceCompletion === 0n && c.priceRequest === 0n;
    const cls = disclosureMax === "any" && !restricted && bonus === 1 ? null : candidateDisclosure(c, input.disclosure?.(c.providerId), input.attestationMaxAgeMs, input.production);
    if (cls) classes.set(c, cls);
    // Lane rules apply before the outage check, so an outage is only ever reported for a provider that could serve.
    const laneReason = !servable ? NOT_SERVABLE_REASON : restricted ? restrictedExclusion(cls ?? "vendor-forwarded", c.provider.classifierEnabled) : null;
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
                          : cls && disclosureMax !== "any" && !classAllowed(cls, disclosureMax)
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
                                      : laneReason
                                        ? laneReason
                                        : health.outage(c.modelId, c.providerId)
                                          ? OUTAGE_REASON
                                          : null;
    if (reason) excluded.push({ provider: c.providerId, reason });
    else pass.push(c);
  }

  // `:nitro` = sort "throughput", `:floor` = sort "price" (a suffix wins over provider.sort; `:nitro` over `:floor`).
  // Sorting only orders the candidates that passed every filter above, lane included: it never adds one back.
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
      (c) =>
        selectionWeight({
          price: blendedPrice(c),
          minPrice,
          uptime: health.uptime30d(c.modelId, c.providerId),
          quality: health.quality(c.modelId, c.providerId),
          attested: classes.get(c) === "attested",
          bonus,
        }),
      input.rand,
      tieBreak,
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
