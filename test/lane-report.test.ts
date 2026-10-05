import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { generations, keys } from "../src/db/schema.ts";
import { LANE_REPORT_LIMITS, laneReportQuery, share, summarizeLanes } from "../src/lane-report/read.ts";
import { laneReportProblems, verifyProofPack } from "../scripts/verify-proof-pack.mjs";

// Lane report: GET /api/v1/lane-report and the lane report section of the proof pack.

const LLAMA = MODELS.llama.slug, QWEN = MODELS.qwen.slug;
const DAY = "2026-05-12";
const today = () => new Date().toISOString().slice(0, 10);
const USDG = 1_000_000_000_000n; // pico per USDG
type Key = { hash: string; auth: Record<string, string> };

let h: Harness;
beforeAll(async () => {
  h = await startRouter({ env: { STATEMENTS_ENABLED: "true" } });
});
afterAll(async () => {
  await h?.close();
});

const report = async (auth: Record<string, string>, query: Record<string, string> = { from: DAY, to: DAY }) => {
  const r = await h.request(`/api/v1/lane-report?${new URLSearchParams(query)}`, { headers: auth });
  return { status: r.status, headers: r.headers, body: (await r.json()) as { data?: any; error?: { type: string; message: string } } };
};
const okReport = async (auth: Record<string, string>, query?: Record<string, string>) => {
  const r = await report(auth, query);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  return r.body.data;
};
const okPack = async (auth: Record<string, string>, query: Record<string, string> = { from: DAY, to: DAY }) => {
  const r = await h.request(`/api/v1/proof-pack?${new URLSearchParams(query)}`, { headers: auth });
  expect(r.status).toBe(200);
  return (await r.json()).data;
};
const child = async (owner: Key): Promise<Key> => {
  const r = await h.request("/api/v1/keys", { method: "POST", headers: owner.auth, json: { name: "Lane agent" } });
  expect(r.status).toBe(201);
  const j = await r.json();
  return { hash: j.data.hash, auth: { authorization: `Bearer ${j.key}` } };
};
const accountOf = async (k: Key) => (await h.ctx.db.select({ accountId: keys.accountId }).from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId;
let n = 0;
/** Recorded calls, as the router stores them: the lane is read from the receipt JSON (null when none was recorded). */
const calls = async (k: Key, accountId: string, rows: [lane: string | null, provider: string, model: string, count: number, pico: bigint, ts?: string][]) => {
  const values = rows.flatMap(([lane, providerId, modelId, count, cost, ts]) =>
    Array.from({ length: count }, () => ({ id: `gen-lane-${k.hash.slice(0, 8)}-${String(n++).padStart(4, "0")}`, keyHash: k.hash, accountId, modelId, providerId, mode: "prepaid", cost, ts: new Date(ts ?? `${DAY}T10:00:00Z`), receipt: lane ? { lane } : null })));
  await h.ctx.db.insert(generations).values(values);
};

describe("the lane report", () => {
  let owner: Key, agent: Key, other: Key;
  beforeAll(async () => {
    owner = await h.fundedKey();
    agent = await child(owner);
    other = await h.fundedKey();
    const account = await accountOf(owner);
    await calls(owner, account, [
      ["attested", "alpha", LLAMA, 2, USDG / 4n],
      ["attested", "beta", QWEN, 1, USDG / 10n],
      ["unlinkable", "alpha", LLAMA, 1, USDG / 20n],
      ["public", "alpha", LLAMA, 3, USDG / 10n],
      [null, "alpha", LLAMA, 1, USDG / 20n],
      ["attested", "alpha", LLAMA, 1, USDG, "2026-05-13T00:00:00Z"], // the next UTC day: outside the range
      ["public", "alpha", LLAMA, 1, USDG, "2026-05-11T23:59:59Z"], // the day before
    ]);
    await calls(agent, account, [["attested", "beta", QWEN, 1, USDG / 5n]]);
    await calls(other, await accountOf(other), [["attested", "alpha", LLAMA, 1, 5n * USDG]]);
  });

  test("totals per lane, the proven share and per provider rows with evidence links", async () => {
    const r = await okReport(owner.auth);
    expect(r).toMatchObject({ type: "anyroute.lane-report.v1", scope: "account", key_hash: null, currency: "USDG", proof_time_url: "/status/#proof-time" });
    expect(r.range).toMatchObject({ from: DAY, to: DAY, from_ts: `${DAY}T00:00:00.000Z`, to_exclusive: "2026-05-13T00:00:00.000Z", days: 1, so_far: false, time_zone: "UTC" });
    expect(r.totals).toEqual({ calls: 9, spend: "1.2" });
    expect(r.lanes).toEqual([
      { lane: "public", proven: false, calls: 3, spend: "0.3", share_of_calls: 0.3333, share_of_spend: 0.25 },
      { lane: "attested", proven: true, calls: 4, spend: "0.8", share_of_calls: 0.4444, share_of_spend: 0.6667 },
      { lane: "unlinkable", proven: true, calls: 1, spend: "0.05", share_of_calls: 0.1111, share_of_spend: 0.0417 },
      { lane: null, proven: false, calls: 1, spend: "0.05", share_of_calls: 0.1111, share_of_spend: 0.0417 },
    ]);
    expect(r.proven).toEqual({ lanes: ["attested", "unlinkable"], calls: 5, spend: "0.85", share_of_calls: 0.5556, share_of_spend: 0.7083 });
    expect(r.providers).toEqual([
      { lane: "attested", provider: "alpha", model: LLAMA, calls: 2, spend: "0.5", evidence_url: "/verify/?p=alpha", attestation_url: "/api/v1/attestation/alpha" },
      { lane: "attested", provider: "beta", model: QWEN, calls: 2, spend: "0.3", evidence_url: "/verify/?p=beta", attestation_url: "/api/v1/attestation/beta" },
      { lane: "unlinkable", provider: "alpha", model: LLAMA, calls: 1, spend: "0.05", evidence_url: "/verify/?p=alpha", attestation_url: "/api/v1/attestation/alpha" },
    ]);
    // What is not recorded per call is said, not guessed.
    expect(Object.keys(r.not_recorded).sort()).toEqual(["default_route", "refusals"]);
    // Every evidence link opens a page or record that exists for that provider.
    expect((await h.request(r.providers[0].attestation_url)).status).toBe(200);
    // Two days, the edges included.
    expect((await okReport(owner.auth, { from: "2026-05-11", to: DAY })).totals).toEqual({ calls: 10, spend: "2.2" });
  });

  test("only the account's own rows: an ordinary key reads only itself, another account sees none of these", async () => {
    const own = await okReport(agent.auth);
    expect(own).toMatchObject({ scope: "key", key_hash: agent.hash, totals: { calls: 1, spend: "0.2" } });
    expect(own.providers).toEqual([expect.objectContaining({ lane: "attested", provider: "beta", model: QWEN, calls: 1, spend: "0.2" })]);
    const theirs = await okReport(other.auth);
    expect(theirs.totals).toEqual({ calls: 1, spend: "5" });
    expect(theirs.providers.map((p: any) => p.calls)).toEqual([1]);
    const nobody = await okReport((await h.fundedKey()).auth);
    expect(nobody.totals).toEqual({ calls: 0, spend: "0" });
    expect(nobody.lanes.map((l: any) => [l.lane, l.calls, l.share_of_calls])).toEqual([["public", 0, null], ["attested", 0, null], ["unlinkable", 0, null]]);
    expect(nobody.proven).toMatchObject({ calls: 0, share_of_calls: null, share_of_spend: null });
    expect(nobody.providers).toEqual([]);
  });

  test("the proof pack carries the same report for its calls, and the offline verifier checks it", async () => {
    const pack = await okPack(owner.auth);
    const r = await okReport(owner.auth);
    const { covers, ...body } = pack.lane_report;
    expect(covers).toBe("calls_in_this_file");
    expect(body).toEqual({ currency: r.currency, totals: r.totals, lanes: r.lanes, proven: r.proven, providers: r.providers });
    expect(pack.manifest.payload.lane_report).toEqual(pack.lane_report);
    const result = verifyProofPack(pack);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ lane_report: "matches", proven_calls: 5, proven_share_of_calls: 0.5556 });
    expect(result.lines.join("\n")).toContain("Lane report: adds up and matches the calls in this file · 5 call(s) on proven hardware");

    const fails = (mutate: (p: any) => void, expected: RegExp) => {
      const copy = structuredClone(pack);
      mutate(copy);
      const v = verifyProofPack(copy);
      expect(v.ok).toBe(false);
      expect(v.failures.join("\n")).toMatch(expected);
    };
    // A changed report fails against the calls, and against the signed manifest.
    fails((p) => (p.lane_report.totals.calls = 8), /lane report: the totals/);
    fails((p) => (p.lane_report.proven.calls = 6), /lane report: the proven share/);
    fails((p) => (p.lane_report.lanes[1].spend = "0.9"), /lane report: lane attested/);
    fails((p) => (p.lane_report.providers[0].evidence_url = "/verify/?p=beta"), /evidence links/);
    fails((p) => p.lane_report.providers.pop(), /has calls in this file but is not listed/);
    fails((p) => (p.lane_report.totals.calls = 8), /manifest: .*lane_report/);
    fails((p) => delete p.lane_report, /manifest: .*lane_report/);
    // So does a call moved to another lane.
    fails((p) => (p.calls.find((c: any) => c.lane === "public").lane = "attested"), /lane report: lane public/);
  });

  test("on receipted calls, each listed lane, provider and model must be what the receipt signed", async () => {
    const k = await h.fundedKey();
    for (let i = 0; i < 2; i++) {
      const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, messages: [{ role: "user", content: "hello" }] } });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    const pack = await okPack(k.auth, { from: today(), to: today() });
    expect(pack.calls).toHaveLength(2);
    expect(pack.lane_report).toMatchObject({ totals: { calls: 2 }, proven: { calls: 0, share_of_calls: 0 }, providers: [] });
    expect(pack.lane_report.lanes[0]).toMatchObject({ lane: "public", calls: 2, share_of_calls: 1 });
    expect(verifyProofPack(pack).ok).toBe(true);
    const copy = structuredClone(pack);
    copy.calls[0].lane = "attested";
    const v = verifyProofPack(copy);
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toMatch(/the listed lane attested is not the signed public/);
    const moved = structuredClone(pack);
    moved.calls[1].provider = "elsewhere";
    expect(verifyProofPack(moved).failures.join("\n")).toMatch(/the listed provider elsewhere is not the signed (alpha|beta)/);
  });
});

describe("limits and access", () => {
  test("no key is 401 and an inference-only key is 403", async () => {
    expect((await h.request(`/api/v1/lane-report?from=${DAY}&to=${DAY}`)).status).toBe(401);
    const owner = await h.fundedKey();
    const limited = await child(owner);
    await h.ctx.db.update(keys).set({ scope: "inference" }).where(eq(keys.keyHash, limited.hash));
    expect((await report(limited.auth)).status).toBe(403);
  });

  test("dates are checked, at most 31 days, and a range may not start in the future", async () => {
    const k = await h.fundedKey();
    for (const q of [{}, { from: DAY }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-3-01", to: "2026-03-02" }, { from: "2026-03-05", to: "2026-03-01" }]) {
      expect((await report(k.auth, q as Record<string, string>)).status, JSON.stringify(q)).toBe(400);
    }
    const long = await report(k.auth, { from: "2026-01-01", to: "2026-02-01" });
    expect(long.status).toBe(413);
    expect(long.body.error).toMatchObject({ type: "range_too_large" });
    expect(long.body.error!.message).toContain(`at most ${LANE_REPORT_LIMITS.maxDays} days`);
    expect((await okReport(k.auth, { from: "2026-01-01", to: "2026-01-31" })).range.days).toBe(31);
    // The clock is passed in, never compared with a fixed future date.
    const now = new Date("2026-03-10T12:00:00Z");
    expect(laneReportQuery({ from: "2026-03-10", to: "2026-03-12" }, now)).toMatchObject({ days: 3 });
    expect(() => laneReportQuery({ from: "2026-03-11", to: "2026-03-12" }, now)).toThrow(/starts in the future/);
  });

  test(`${LANE_REPORT_LIMITS.perMinute} reports per key per minute, then 429 with retry-after`, async () => {
    const k = await h.fundedKey();
    for (let i = 0; i < LANE_REPORT_LIMITS.perMinute; i++) expect((await report(k.auth)).status).toBe(200);
    const limited = await report(k.auth);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await report((await h.fundedKey()).auth)).status).toBe(200); // per key
  });

  test("off with statements: no route answers", async () => {
    const off = await startRouter();
    try {
      const k = await off.fundedKey();
      expect(off.ctx.cfg.statementsEnabled).toBe(false);
      expect((await off.request(`/api/v1/lane-report?from=${DAY}&to=${DAY}`, { headers: k.auth })).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe("the summary", () => {
  test("shares round half up to four places; other recorded lane names sort after the three lanes, unrecorded last", () => {
    expect([share(1n, 3n), share(2n, 3n), share(1n, 8n), share(1n, 20000n), share(0n, 5n), share(1n, 0n)]).toEqual([0.3333, 0.6667, 0.125, 0.0001, 0, null]);
    const s = summarizeLanes([
      { lane: null, provider: "a", model: "m", calls: 1, pico: 1n },
      { lane: "zeta", provider: "a", model: "m", calls: 1, pico: 1n },
      { lane: "attested", provider: "b", model: "m", calls: 1, pico: 2n },
      { lane: "attested", provider: "a", model: "m", calls: 1, pico: 2n },
    ]);
    expect(s.lanes.map((l) => l.lane)).toEqual(["public", "attested", "unlinkable", "zeta", null]);
    expect(s.providers.map((p) => p.provider)).toEqual(["a", "b"]);
    expect(s.totals).toEqual({ calls: 4, spend: "0.000000000006" });
    expect(laneReportProblems(s, [
      { lane: null, provider: "a", model: "m", cost: "0.000000000001" },
      { lane: "zeta", provider: "a", model: "m", cost: "0.000000000001" },
      { lane: "attested", provider: "b", model: "m", cost: "0.000000000002" },
      { lane: "attested", provider: "a", model: "m", cost: "0.000000000002" },
    ])).toEqual([]);
    expect(summarizeLanes([]).providers).toEqual([]);
    // Provider ids are links: anything unusual in an id is encoded.
    expect(summarizeLanes([{ lane: "attested", provider: "a b/c", model: "m", calls: 1, pico: 0n }]).providers[0].evidence_url).toBe("/verify/?p=a%20b%2Fc");
  });
});
