import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { DpStats, type RandomBytes } from "../src/lib/dpstats.ts";
import { blockReasonForStatus, noteLane, PRIVATE_LANES, privateLaneStats, recordPrivateLane, ROUTER_BLOCK_REASONS, setPrivateLaneStats } from "../src/services/private-stats.ts";

// The router's side of the private-lane stats. The noise itself is tested with the sidecar (sidecar/test/dpstats.test.ts).

const ROOT = join(import.meta.dir, "..");
const HOUR = 3_600_000;
const LLAMA = "meta-llama/llama-3.3-70b-instruct";

/** Deterministic byte source for tests only (splitmix32). */
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

test("the router and the sidecar run the same differential-privacy module, byte for byte", () => {
  expect(readFileSync(join(ROOT, "src/lib/dpstats.ts"), "utf8")).toBe(readFileSync(join(ROOT, "sidecar/src/dpstats.ts"), "utf8"));
});

test("block reasons come from the status alone, from a fixed list", () => {
  expect([401, 402, 403, 409, 429, 400, 502, 503].map((s) => blockReasonForStatus(s))).toEqual(["unauthorized", "payment_required", "forbidden", "no_provider", "rate_limited", "invalid_request", "upstream_error", "upstream_error"]);
  expect(blockReasonForStatus(503, "no_attested_endpoint")).toBe("no_provider");
  for (const s of [400, 404, 413, 500]) expect(ROUTER_BLOCK_REASONS).toContain(blockReasonForStatus(s) as (typeof ROUTER_BLOCK_REASONS)[number]);
});

describe("private lanes publish noisy counters only", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const clock = { t: Date.parse("2026-09-29T08:10:00Z") };
  const chat = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth, ...headers }, json: { model: LLAMA, messages: [{ role: "user", content: "hello" }], ...body } });

  beforeAll(async () => {
    h = await startRouter();
    auth = (await h.fundedKey()).auth;
    // epsilon 100: noise far below rounding, so the counts can be checked exactly
    setPrivateLaneStats(h.ctx, new DpStats({ requestKinds: PRIVATE_LANES, blockReasons: ROUTER_BLOCK_REASONS, epsilon: { requests: 100, blocked: 100, latency: 100, tokens: 100 }, random: seeded(4), now: () => clock.t }));
  });
  afterAll(() => h.close());

  test("a request is counted at most once, and only on a private lane", () => {
    const own = { t: clock.t };
    const s = new DpStats({ requestKinds: PRIVATE_LANES, blockReasons: ROUTER_BLOCK_REASONS, epsilon: { requests: 100, blocked: 100, latency: 100, tokens: 100 }, random: seeded(1), now: () => own.t });
    const ctx = {} as Harness["ctx"];
    setPrivateLaneStats(ctx, s);
    const pub = new Request("http://x/a");
    const att = new Request("http://x/b");
    noteLane(pub, "public");
    noteLane(att, "attested");
    for (let i = 0; i < 3; i++) {
      recordPrivateLane(ctx, pub, { tokens: 10 });
      recordPrivateLane(ctx, att, { tokens: 10, blocked: i === 1 ? "no_provider" : null });
    }
    own.t += HOUR;
    const [hour] = s.document().hours;
    expect(hour.counts!.requests).toEqual({ attested: 1, unlinkable: 0, other: 0 });
    expect(Object.values(hour.counts!.blocked).reduce((a, b) => a + b, 0)).toBe(0); // the first record won
    expect(privateLaneStats(ctx)).toBe(s);
  });

  test("a refused attested-lane request is counted under its reason and shows up only after the hour ends", async () => {
    const r = await chat({ provider: { lane: "attested" } });
    expect(r.status).toBe(503); // nothing attested in this router: no_attested_endpoint
    expect((await r.json()).error.type).toBe("no_attested_endpoint");
    const now = (await (await h.request("/api/v1/stats")).json()).data;
    expect(now.hours).toEqual([]);
    expect(now.lanes).toEqual(["attested", "unlinkable"]);
    clock.t += HOUR;
    const res = await h.request("/api/v1/stats");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = (await res.json()).data;
    expect(Object.keys(doc).sort()).toEqual(["buckets", "budget", "current_hour", "hours", "labels", "lanes", "object", "privacy"]);
    const [hour] = doc.hours;
    expect(hour.counts.requests.attested).toBe(1);
    expect(hour.counts.blocked.no_provider).toBe(1);
    expect(doc.privacy).toMatchObject({ mechanism: "laplace", unit: "request", sensitivity: 1 });
    expect(doc.budget.epsilon_per_hour).toBe(400);
  });

  test("raw status and rankings leave private-lane rows out", async () => {
    expect((await chat()).status).toBe(200);
    const status = async () => (await (await h.request("/api/v1/status")).json()).data.launch;
    const before = await status();
    expect(before.tokens_24h).toBeGreaterThan(0);
    expect((await (await h.request("/api/v1/status")).json()).data.private_lanes).toMatchObject({ lanes: ["attested", "unlinkable"], stats: "/api/v1/stats" });
    const ranked = async () => (await (await h.request("/api/v1/rankings?period=day")).json()).data.models.reduce((a: number, m: { requests: number }) => a + m.requests, 0);
    const rankedBefore = await ranked();
    expect(rankedBefore).toBeGreaterThan(0);
    // Mark every row as served on a private lane, as the receipt of an attested or `:private` request says.
    await h.ctx.db.execute(sql`UPDATE generations SET receipt = jsonb_set(coalesce(receipt, '{}'::jsonb), '{lane}', '"attested"')`);
    expect((await status()).tokens_24h).toBe(0);
    expect(await ranked()).toBe(0);
    await h.ctx.db.execute(sql`UPDATE generations SET receipt = jsonb_set(receipt, '{lane}', '"public"'), private = true`);
    expect((await status()).tokens_24h).toBe(0);
    expect(await ranked()).toBe(0);
  });
});
