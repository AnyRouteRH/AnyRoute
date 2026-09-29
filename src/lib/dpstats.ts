// Differentially private hourly counters.
//
// This file is shared byte for byte by the sidecar (sidecar/src/dpstats.ts) and the router (src/lib/dpstats.ts):
// each ships as its own container, so neither can import the other at run time. test/dpstats.test.ts fails when the
// two copies differ. It has no dependencies.
//
// What it keeps: four families of counters for the current hour, and nothing else. No request, no timestamp finer
// than the hour, no key, no address.
//
//   requests  one count per request, under the request's kind (a fixed, public list)
//   blocked   at most one count per request, under the reason it was refused (a fixed, public list)
//   latency   at most one count per request, in a fixed latency bucket
//   tokens    at most one count per request, in a fixed token bucket
//
// `observe()` is the only way in, and it adds at most 1 to each family, so adding or removing one request changes
// each family's histogram by at most 1 in L1 norm (sensitivity 1). Values are clamped into the last bucket, unknown
// labels fall into "other", and every label is always released, even at zero, so which labels appear says nothing.
//
// When the hour ends its counts are released once, with Laplace noise of scale 1/epsilon per family (default
// epsilon 1 per family per hour), and the raw counts are discarded. Every hour since start is released, including
// hours with no traffic, so whether an hour appears says nothing either. Nothing is ever re-noised on read.
//
// Noise comes from a CSPRNG (crypto.getRandomValues). Textbook Laplace sampling in floating point is attackable:
// the set of doubles that `x + b*ln(u)` can produce depends on `x`, so an observer of the exact output can learn
// the true value (Mironov, "On Significance of the Least Significant Bits for Differential Privacy", CCS 2012).
// The mitigation here is Mironov's snapping mechanism: the input is clamped to [-B, B], the uniform variate is drawn
// over all doubles in (0, 1) with the right weight for each exponent (not a 53-bit grid), the noisy value is rounded
// to the nearest multiple of Lambda (the smallest power of two >= the scale), and the result is clamped to [-B, B].
// With the default B = 2^24 the extra privacy loss this leaves is below 2^-20 per release. Finally the value is
// clamped at zero (post-processing, which costs no privacy).
//
// The privacy unit is one request (event-level). A person who sends k requests in an hour can move each family by up
// to k. The budget ledger adds up the epsilon of every hour released in a UTC day; that is the basic-composition
// bound for someone who sends one request in every hour of the day.

export type RandomBytes = (buf: Uint8Array) => void;

/** The production source: the platform CSPRNG. */
export const cryptoRandom: RandomBytes = (buf) => {
  crypto.getRandomValues(buf);
};

export const FAMILIES = ["requests", "blocked", "latency", "tokens"] as const;
export type Family = (typeof FAMILIES)[number];

/** Upper edges, inclusive. A value above the last edge lands in the final "gt_" bucket. */
export const LATENCY_EDGES_MS: readonly number[] = Object.freeze([100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000]);
export const TOKEN_EDGES: readonly number[] = Object.freeze([64, 256, 1024, 4096, 16_384, 65_536]);

export const OTHER = "other";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Default clamp for the snapping mechanism: no single bucket of one hour is expected above 16.7M. */
export const DEFAULT_BOUND = 2 ** 24;

export function bucketLabels(edges: readonly number[]): string[] {
  return [...edges.map((e) => `le_${e}`), `gt_${edges[edges.length - 1]}`];
}

/** The bucket a value falls in. Negative, NaN and infinite values are clamped: never more than one bucket. */
export function bucketOf(edges: readonly number[], value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, value) : value === Infinity ? Infinity : 0;
  for (const e of edges) if (v <= e) return `le_${e}`;
  return `gt_${edges[edges.length - 1]}`;
}

// ---- noise ----------------------------------------------------------------------------------------------

/** Reads random bits from a byte source, a buffer at a time. */
export class RandomBits {
  private buf = new Uint8Array(64);
  private pos = 512; // bit position; starts exhausted
  constructor(private readonly source: RandomBytes = cryptoRandom) {}
  bit(): number {
    if (this.pos >= 512) {
      this.source(this.buf);
      this.pos = 0;
    }
    const b = (this.buf[this.pos >> 3] >> (this.pos & 7)) & 1;
    this.pos++;
    return b;
  }
  /** n <= 32 bits as an unsigned integer. */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
}

/**
 * A uniform double in (0, 1) drawn over every representable value with the right weight: the exponent is geometric
 * (each halving of the range is half as likely) and the 52 mantissa bits are uniform. 0 cannot come out.
 */
export function uniformOpen01(r: RandomBits): number {
  let e = -1;
  while (e > -1074 && r.bit() === 0) e--;
  const mantissa = r.bits(20) * 2 ** 32 + r.bits(32); // 52 bits
  return (1 + mantissa / 2 ** 52) * 2 ** e;
}

/** Laplace(0, scale) by inverse CDF: a random sign times scale * -ln(U), U uniform in (0, 1). */
export function laplace(scale: number, r: RandomBits): number {
  const sign = r.bit() === 1 ? 1 : -1;
  return sign * scale * -Math.log(uniformOpen01(r));
}

/** The smallest power of two that is >= x (x > 0). */
export function powerOfTwoAtLeast(x: number): number {
  let l = 1;
  while (l < x) l *= 2;
  while (l / 2 >= x) l /= 2;
  return l;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Mironov's snapping mechanism: clamp, add Laplace noise, round to a multiple of Lambda, clamp again. */
export function snappedLaplace(value: number, scale: number, bound: number, r: RandomBits): number {
  const lambda = powerOfTwoAtLeast(scale);
  const noisy = clamp(value, -bound, bound) + laplace(scale, r);
  return clamp(lambda * Math.round(noisy / lambda), -bound, bound);
}

/** Released value: snapped Laplace, then post-processed to a non-negative integer. */
export function releaseCount(value: number, epsilon: number, r: RandomBits, bound = DEFAULT_BOUND): number {
  const out = Math.round(snappedLaplace(value, 1 / epsilon, bound, r)); // sensitivity 1
  return out > 0 ? out : 0;
}

// ---- counters -------------------------------------------------------------------------------------------

export type Observation = {
  /** What kind of request this was; a value outside the configured list counts as "other". */
  kind: string;
  /** Why it was refused, if it was; a value outside the configured list counts as "other". */
  blocked?: string | null;
  latencyMs?: number | null;
  tokens?: number | null;
};

export type DpStatsOptions = {
  requestKinds: readonly string[];
  blockReasons: readonly string[];
  /** Per family and per hour. Default 1 for each family. */
  epsilon?: Partial<Record<Family, number>>;
  /** Released hours kept for GET, newest first. Default 48. */
  retentionHours?: number;
  /** Optional cap on epsilon per UTC day: an hour that would exceed it is withheld (no values). */
  dailyEpsilonCap?: number | null;
  /** Clamp B of the snapping mechanism. */
  bound?: number;
  random?: RandomBytes;
  now?: () => number;
};

export type ReleasedHour = {
  hour: string;
  status: "released" | "withheld";
  /** Sum of the families' epsilon spent on this hour (0 when withheld). */
  epsilon: number;
  counts: Record<Family, Record<string, number>> | null;
};

export type StatsDocument = {
  object: "stats";
  privacy: {
    mechanism: "laplace";
    sampler: "csprng-inverse-cdf";
    snapping: { bound: number };
    unit: "request";
    sensitivity: 1;
    epsilon_per_hour: Record<Family, number>;
    scale: Record<Family, number>;
    post_processing: "rounded, clamped at 0";
  };
  labels: Record<Family, string[]>;
  buckets: { latency_ms: readonly number[]; tokens: readonly number[] };
  current_hour: { hour: string; status: "collecting" };
  hours: ReleasedHour[];
  budget: BudgetView;
};

export type BudgetView = {
  day: string;
  epsilon_per_hour: number;
  epsilon_spent_today: number;
  daily_cap: number | null;
  days: { day: string; epsilon_spent: number }[];
};

const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const floorHour = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;

function checkLabels(list: readonly string[], what: string): string[] {
  const out = [...new Set(list)];
  for (const l of out) if (!/^[a-z][a-z0-9_]{0,39}$/.test(l)) throw new Error(`dpstats: bad ${what} label "${l}"`);
  if (!out.includes(OTHER)) out.push(OTHER);
  return out;
}

export class DpStats {
  readonly labels: Record<Family, string[]>;
  readonly epsilon: Record<Family, number>;
  private readonly retention: number;
  private readonly cap: number | null;
  private readonly bound: number;
  private readonly rng: RandomBits;
  private readonly now: () => number;
  private hourStart: number;
  private raw: Record<Family, Map<string, number>>;
  private released: ReleasedHour[] = [];
  private readonly ledger = new Map<string, number>();

  constructor(o: DpStatsOptions) {
    this.labels = {
      requests: checkLabels(o.requestKinds, "request kind"),
      blocked: checkLabels(o.blockReasons, "block reason"),
      latency: bucketLabels(LATENCY_EDGES_MS),
      tokens: bucketLabels(TOKEN_EDGES),
    };
    const eps = {} as Record<Family, number>;
    for (const f of FAMILIES) {
      const e = o.epsilon?.[f] ?? 1;
      if (!Number.isFinite(e) || e <= 0 || e > 100) throw new Error(`dpstats: epsilon for ${f} must be in (0, 100]`);
      eps[f] = e;
    }
    this.epsilon = eps;
    this.retention = Math.max(1, Math.floor(o.retentionHours ?? 48));
    this.cap = o.dailyEpsilonCap ?? null;
    if (this.cap !== null && !(this.cap > 0)) throw new Error("dpstats: dailyEpsilonCap must be positive");
    this.bound = o.bound ?? DEFAULT_BOUND;
    this.rng = new RandomBits(o.random ?? cryptoRandom);
    this.now = o.now ?? Date.now;
    this.hourStart = floorHour(this.now());
    this.raw = this.empty();
  }

  /** Epsilon spent by one released hour: basic composition over the four families. */
  get epsilonPerHour(): number {
    return FAMILIES.reduce((s, f) => s + this.epsilon[f], 0);
  }

  private empty(): Record<Family, Map<string, number>> {
    return { requests: new Map(), blocked: new Map(), latency: new Map(), tokens: new Map() };
  }

  private bump(f: Family, label: string) {
    const key = this.labels[f].includes(label) ? label : OTHER;
    const m = this.raw[f];
    m.set(key, (m.get(key) ?? 0) + 1);
  }

  /** Count one request. Adds at most 1 to each family, whatever the observation holds. */
  observe(o: Observation): void {
    this.roll();
    this.bump("requests", o.kind);
    if (o.blocked) this.bump("blocked", o.blocked);
    if (typeof o.latencyMs === "number") this.bump("latency", bucketOf(LATENCY_EDGES_MS, o.latencyMs));
    if (typeof o.tokens === "number") this.bump("tokens", bucketOf(TOKEN_EDGES, o.tokens));
  }

  /** Release every hour that has ended. Called on each observe and read; noise is drawn exactly once per hour. */
  roll(): void {
    const current = floorHour(this.now());
    if (current <= this.hourStart) return;
    this.release(this.hourStart, this.raw);
    this.raw = this.empty();
    // Hours with no traffic are released too (as noisy zeros), but only the ones still inside the retention window:
    // which hours are skipped depends on the clock alone.
    const firstGap = Math.max(this.hourStart + HOUR_MS, current - this.retention * HOUR_MS);
    for (let h = firstGap; h < current; h += HOUR_MS) this.release(h, this.empty());
    this.hourStart = current;
  }

  private release(hour: number, raw: Record<Family, Map<string, number>>) {
    const day = dayOf(hour);
    const spent = this.ledger.get(day) ?? 0;
    const cost = this.epsilonPerHour;
    let entry: ReleasedHour;
    if (this.cap !== null && spent + cost > this.cap + 1e-9) {
      entry = { hour: iso(hour), status: "withheld", epsilon: 0, counts: null };
    } else {
      const counts = {} as Record<Family, Record<string, number>>;
      for (const f of FAMILIES) {
        counts[f] = {};
        for (const label of this.labels[f]) counts[f][label] = releaseCount(raw[f].get(label) ?? 0, this.epsilon[f], this.rng, this.bound);
      }
      this.ledger.set(day, spent + cost);
      entry = { hour: iso(hour), status: "released", epsilon: cost, counts };
    }
    this.released.unshift(entry);
    if (this.released.length > this.retention) this.released.length = this.retention;
    for (const d of [...this.ledger.keys()]) if (Date.parse(`${d}T00:00:00Z`) < hour - 30 * DAY_MS) this.ledger.delete(d);
  }

  budget(): BudgetView {
    this.roll();
    const today = dayOf(this.now());
    return {
      day: today,
      epsilon_per_hour: this.epsilonPerHour,
      epsilon_spent_today: round6(this.ledger.get(today) ?? 0),
      daily_cap: this.cap,
      days: [...this.ledger.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, e]) => ({ day, epsilon_spent: round6(e) })),
    };
  }

  /** The public document: released noisy hours, the budget, and no raw value. */
  document(): StatsDocument {
    this.roll();
    const scale = {} as Record<Family, number>;
    for (const f of FAMILIES) scale[f] = 1 / this.epsilon[f];
    return {
      object: "stats",
      privacy: {
        mechanism: "laplace",
        sampler: "csprng-inverse-cdf",
        snapping: { bound: this.bound },
        unit: "request",
        sensitivity: 1,
        epsilon_per_hour: { ...this.epsilon },
        scale,
        post_processing: "rounded, clamped at 0",
      },
      labels: { requests: [...this.labels.requests], blocked: [...this.labels.blocked], latency: [...this.labels.latency], tokens: [...this.labels.tokens] },
      buckets: { latency_ms: LATENCY_EDGES_MS, tokens: TOKEN_EDGES },
      current_hour: { hour: iso(this.hourStart), status: "collecting" },
      hours: this.released.map((h) => ({ ...h, counts: h.counts ? structuredClone(h.counts) : null })),
      budget: this.budget(),
    };
  }
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
