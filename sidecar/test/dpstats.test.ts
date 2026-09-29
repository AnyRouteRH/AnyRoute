import { afterEach, describe, expect, test } from "bun:test";
import { bucketOf, DpStats, FAMILIES, laplace, LATENCY_EDGES_MS, powerOfTwoAtLeast, RandomBits, releaseCount, snappedLaplace, TOKEN_EDGES, uniformOpen01, type RandomBytes } from "../src/dpstats.ts";
import { BLOCK_REASONS, createSidecarStats, REQUEST_KINDS } from "../src/stats.ts";
import { API_KEY, cleanup, harness } from "./helpers.ts";

const chatBody = (over: Record<string, unknown> = {}) => JSON.stringify({ model: "ok", messages: [{ role: "user", content: "hi" }], ...over });

afterEach(cleanup);

/** Deterministic byte source for tests only (splitmix32). Production always uses crypto.getRandomValues. */
function seeded(seed: number): RandomBytes {
  let s = seed >>> 0;
  return (buf) => {
    for (let i = 0; i < buf.length; i++) {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      buf[i] = (z ^ (z >>> 16)) & 0xff;
    }
  };
}

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-29T10:15:00Z");
const clock = (start = T0) => {
  const c = { t: start, now: () => c.t };
  return c;
};

describe("Laplace noise", () => {
  test("uniform variates are in (0, 1) and never 0", () => {
    const r = new RandomBits(seeded(1));
    for (let i = 0; i < 20_000; i++) {
      const u = uniformOpen01(r);
      expect(u > 0 && u < 1).toBe(true);
    }
  });

  for (const b of [1, 2]) {
    test(`mean is about 0 and scale is about ${b} (b = sensitivity / epsilon) over many samples`, () => {
      const r = new RandomBits(seeded(42 + b));
      const n = 100_000;
      let sum = 0;
      let abs = 0;
      let sq = 0;
      for (let i = 0; i < n; i++) {
        const x = laplace(b, r);
        sum += x;
        abs += Math.abs(x);
        sq += x * x;
      }
      expect(Math.abs(sum / n)).toBeLessThan(0.03 * b); // E[X] = 0
      expect(Math.abs(abs / n - b)).toBeLessThan(0.03 * b); // E|X| = b
      expect(Math.abs(sq / n - 2 * b * b)).toBeLessThan(0.1 * b * b); // Var = 2b^2
    });
  }

  test("snapping rounds to a multiple of Lambda, the power of two at or above the scale, and clamps to the bound", () => {
    expect([0.3, 1, 1.5, 2, 3, 8].map(powerOfTwoAtLeast)).toEqual([0.5, 1, 2, 2, 4, 8]);
    const r = new RandomBits(seeded(7));
    for (let i = 0; i < 2000; i++) {
      const y = snappedLaplace(10, 3, 1000, r);
      expect(Math.abs(y % 4)).toBe(0);
      expect(Math.abs(y)).toBeLessThanOrEqual(1000);
    }
    // an input far past the bound is clamped before noise, and the output after
    for (let i = 0; i < 200; i++) expect(Math.abs(snappedLaplace(1e12, 1, 64, r))).toBeLessThanOrEqual(64);
  });

  test("released counts are non-negative integers, even for a zero count", () => {
    const r = new RandomBits(seeded(9));
    let zeros = 0;
    for (let i = 0; i < 5000; i++) {
      const v = releaseCount(0, 1, r);
      expect(Number.isInteger(v) && v >= 0).toBe(true);
      if (v === 0) zeros++;
    }
    expect(zeros).toBeGreaterThan(2500); // about half the noise is negative and is clamped to 0
  });
});

describe("counters", () => {
  const precise = (c = clock(), extra: Partial<ConstructorParameters<typeof DpStats>[0]> = {}) =>
    // epsilon 100 gives noise far below 0.5, so released counts equal the true ones: lets the tests check the counting
    new DpStats({ requestKinds: ["chat"], blockReasons: ["policy"], epsilon: { requests: 100, blocked: 100, latency: 100, tokens: 100 }, random: seeded(3), now: c.now, ...extra });

  test("one observation adds at most 1 to each family, and values are clamped into a bucket", () => {
    const c = clock();
    const s = precise(c);
    s.observe({ kind: "chat", blocked: "policy", latencyMs: 1e9, tokens: -5 });
    s.observe({ kind: "something-else", blocked: "no-such-reason", latencyMs: Number.NaN, tokens: Infinity });
    s.observe({ kind: "chat", latencyMs: 120, tokens: 64 });
    c.t += HOUR;
    const [h] = s.document().hours;
    expect(h.status).toBe("released");
    const sum = (f: (typeof FAMILIES)[number]) => Object.values(h.counts![f]).reduce((a, b) => a + b, 0);
    expect(h.counts!.requests).toEqual({ chat: 2, other: 1 });
    expect(h.counts!.blocked).toEqual({ policy: 1, other: 1 });
    expect(sum("latency")).toBe(3);
    expect(sum("tokens")).toBe(3);
    expect(h.counts!.latency.gt_60000).toBe(1);
    expect(h.counts!.latency.le_100).toBe(1); // NaN is clamped to 0
    expect(h.counts!.latency.le_250).toBe(1);
    expect(h.counts!.tokens.le_64).toBe(2); // -5 and 64
    expect(h.counts!.tokens.gt_65536).toBe(1);
    expect(bucketOf(TOKEN_EDGES, 65_537)).toBe("gt_65536");
    expect(bucketOf(LATENCY_EDGES_MS, 100)).toBe("le_100");
  });

  test("every label is released every hour, even at zero", () => {
    const c = clock();
    const s = precise(c);
    c.t += HOUR;
    const [h] = s.document().hours;
    expect(Object.keys(h.counts!.requests)).toEqual(["chat", "other"]);
    expect(Object.keys(h.counts!.latency)).toHaveLength(LATENCY_EDGES_MS.length + 1);
    expect(Object.values(h.counts!.tokens).every((v) => v === 0)).toBe(true);
  });

  test("hourly rollover: the current hour is never published, ended hours are released once, gaps are filled", () => {
    const c = clock();
    const s = new DpStats({ requestKinds: ["chat"], blockReasons: [], random: seeded(11), now: c.now, retentionHours: 5 });
    for (let i = 0; i < 40; i++) s.observe({ kind: "chat", latencyMs: 300, tokens: 500 });
    const before = s.document();
    expect(before.hours).toEqual([]);
    expect(before.current_hour).toEqual({ hour: "2026-09-29T10:00:00Z", status: "collecting" });
    c.t += HOUR;
    const once = s.document();
    expect(once.hours.map((h) => h.hour)).toEqual(["2026-09-29T10:00:00Z"]);
    expect(s.document().hours).toEqual(once.hours); // noise is drawn once, not on every read
    c.t += 3 * HOUR; // two empty hours in between
    expect(s.document().hours.map((h) => h.hour)).toEqual(["2026-09-29T13:00:00Z", "2026-09-29T12:00:00Z", "2026-09-29T11:00:00Z", "2026-09-29T10:00:00Z"]);
    c.t += 100 * HOUR; // a long idle gap: only the retention window is released, and kept
    const late = s.document();
    expect(late.hours).toHaveLength(5);
    expect(late.hours[0].hour).toBe(new Date(Math.floor(c.t / HOUR) * HOUR - HOUR).toISOString().replace(".000Z", "Z"));
  });

  test("no raw value leaves: counts are noised, and the document holds nothing else", () => {
    const c = clock();
    const s = new DpStats({ requestKinds: ["chat"], blockReasons: [], random: seeded(5), now: c.now, retentionHours: 200 });
    let exact = 0;
    for (let hour = 0; hour < 100; hour++) {
      for (let i = 0; i < 50; i++) s.observe({ kind: "chat" });
      c.t += HOUR;
    }
    const doc = s.document();
    for (const h of doc.hours) if (h.counts!.requests.chat === 50) exact++;
    expect(exact).toBeLessThan(60); // with scale 1 about 37% of releases land on the true value by rounding
    expect(doc.hours.some((h) => h.counts!.requests.chat !== 50)).toBe(true);
    expect(Object.keys(doc).sort()).toEqual(["buckets", "budget", "current_hour", "hours", "labels", "object", "privacy"]);
    expect(Object.keys(doc.current_hour).sort()).toEqual(["hour", "status"]);
    // releases hold integers only (no fractional value that could carry the floating-point trace)
    for (const h of doc.hours) for (const f of FAMILIES) for (const v of Object.values(h.counts![f])) expect(Number.isInteger(v) && v >= 0).toBe(true);
  });

  test("budget: each released hour spends the sum of the families' epsilon; the ledger is per UTC day; a cap withholds", () => {
    const c = clock(Date.parse("2026-09-29T21:30:00Z"));
    const s = new DpStats({ requestKinds: ["chat"], blockReasons: [], epsilon: { requests: 1, blocked: 0.5, latency: 1, tokens: 0.5 }, dailyEpsilonCap: 7, random: seeded(8), now: c.now });
    expect(s.epsilonPerHour).toBe(3);
    c.t += 3 * HOUR; // releases 21:00, 22:00, 23:00 on the 29th
    let b = s.budget();
    expect(b.day).toBe("2026-09-30");
    expect(b.epsilon_spent_today).toBe(0);
    expect(b.days).toEqual([{ day: "2026-09-29", epsilon_spent: 6 }]); // the third hour would pass the cap of 7
    const hours = s.document().hours;
    expect(hours.map((h) => h.status)).toEqual(["withheld", "released", "released"]);
    expect(hours[0]).toMatchObject({ epsilon: 0, counts: null });
    c.t += HOUR;
    b = s.budget();
    expect(b.epsilon_spent_today).toBe(3);
    expect(b.epsilon_per_hour).toBe(3);
    expect(b.daily_cap).toBe(7);
  });

  test("defaults: epsilon 1 per family per hour, scale 1, sensitivity 1", () => {
    const s = createSidecarStats({ epsilon: {}, retentionHours: 48, dailyEpsilonCap: null });
    const d = s.document();
    expect(d.privacy).toMatchObject({ mechanism: "laplace", sampler: "csprng-inverse-cdf", unit: "request", sensitivity: 1, epsilon_per_hour: { requests: 1, blocked: 1, latency: 1, tokens: 1 }, scale: { requests: 1, blocked: 1, latency: 1, tokens: 1 } });
    expect(d.labels.requests).toEqual([...REQUEST_KINDS, "other"]);
    expect(d.labels.blocked).toEqual([...BLOCK_REASONS, "other"]);
    expect(() => new DpStats({ requestKinds: ["chat"], blockReasons: [], epsilon: { requests: 0 } })).toThrow();
  });
});

describe("GET /v1/stats", () => {
  test("is public, serves noisy hours only, and every inference request is counted once", async () => {
    const h = await harness({ raw: { stats: { epsilon: { requests: 10, blocked: 10, latency: 10, tokens: 10 } } } });
    const c = clock();
    expect(h.cfg.stats.epsilon).toEqual({ requests: 10, blocked: 10, latency: 10, tokens: 10 });
    // Same labels, a test clock, a seeded source and epsilon 100 (noise far below rounding) so exact counts can be checked.
    h.rt.stats = new DpStats({ requestKinds: REQUEST_KINDS, blockReasons: BLOCK_REASONS, epsilon: { requests: 100, blocked: 100, latency: 100, tokens: 100 }, random: seeded(21), now: c.now });
    expect((await h.chat(chatBody())).status).toBe(200);
    await (await h.chat(chatBody({ stream: true }))).text();
    expect((await h.chat(chatBody(), "wrong-key")).status).toBe(401);
    const early = await h.call("/v1/stats", { key: null });
    expect(early.status).toBe(200);
    const body = (await early.json()) as ReturnType<typeof h.rt.stats.document>;
    expect(body.object).toBe("stats");
    expect(body.hours).toEqual([]); // the running hour is never served
    expect(body.privacy.epsilon_per_hour.requests).toBe(100);
    expect(body.budget).toMatchObject({ epsilon_spent_today: 0, epsilon_per_hour: 400 });
    c.t += HOUR;
    const doc = (await (await h.call("/v1/stats", { key: null })).json()) as typeof body;
    const [hour] = doc.hours;
    expect(hour.counts!.requests.chat_completions).toBe(3);
    expect(hour.counts!.blocked.unauthorized).toBe(1);
    expect(Object.values(hour.counts!.tokens).reduce((a, b) => a + b, 0)).toBe(2); // the refused request has no tokens
    expect(Object.values(hour.counts!.latency).reduce((a, b) => a + b, 0)).toBe(3);
    expect(doc.budget.epsilon_spent_today).toBe(400);
    expect((await h.call("/v1/stats", { method: "POST", key: API_KEY })).status).toBe(405);
  });

  test("rejects unknown stats settings", async () => {
    await expect(harness({ raw: { stats: { public_logs: true } } })).rejects.toThrow(/stats\.public_logs: unknown setting/);
    await expect(harness({ raw: { stats: { epsilon: { requests: 0 } } } })).rejects.toThrow(/stats\.epsilon\.requests/);
  });
});
