import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { DpStats, LATENCY_EDGES_MS, type RandomBytes } from "../src/lib/dpstats.ts";
import { PRIVATE_LANES, ROUTER_BLOCK_REASONS, setPrivateLaneStats } from "../src/services/private-stats.ts";
import { statusDpHours, statusIncidents, statusWindows } from "../src/db/schema.ts";
import {
  BUCKET_MS,
  DP_MIN_ELIGIBLE,
  LATENCY_LABELS,
  SloRecorder,
  activeSurfaces,
  atomFeed,
  availability,
  buildSlo,
  dpAvailability,
  errorBudget,
  histogramPercentile,
  outcomeOf,
  persistDpHours,
  rssFeed,
  stateOf,
  sloRecorder,
  sumDp,
  suggestIncidents,
  surfaceOf,
  incidentJson,
} from "../src/services/slo.ts";

const HOUR = 3_600_000;
const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const QWEN = "qwen/qwen3-32b";
const op = { "x-admin-token": ADMIN };

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

describe("SLO math", () => {
  test("availability counts 5xx against the router and leaves 4xx and 429 out", () => {
    expect(availability(0, 0)).toBeNull();
    expect(availability(995, 5)).toBe(0.995);
    expect(availability(10, 0)).toBe(1);
    expect(outcomeOf(200)).toBe("ok");
    expect(outcomeOf(502)).toBe("failed");
    expect(outcomeOf(503)).toBe("failed");
    expect(outcomeOf(429)).toBe("rate_limited");
    expect(outcomeOf(400)).toBe("rejected");
    expect(outcomeOf(401)).toBe("rejected");
  });

  test("the error budget is the failures the target allows over 30 days", () => {
    expect(errorBudget(0.995, 10_000, 0)).toMatchObject({ allowed_failures: 50, failures: 0, remaining: 1, exhausted: false });
    expect(errorBudget(0.995, 10_000, 20)).toMatchObject({ allowed_failures: 50, remaining: 0.6, exhausted: false });
    expect(errorBudget(0.995, 10_000, 80)).toMatchObject({ remaining: 0, exhausted: true });
    expect(errorBudget(0.99, 0, 0)).toMatchObject({ remaining: null, exhausted: false });
    expect(errorBudget(1, 100, 0).remaining).toBe(1);
    expect(errorBudget(1, 100, 1).remaining).toBe(0);
  });

  test("percentiles are the upper edge of the bucket they fall in, and null past the last edge", () => {
    const counts = LATENCY_LABELS.map(() => 0);
    expect(histogramPercentile(counts, 50)).toBeNull();
    counts[2] = 50; // le_500
    counts[4] = 45; // le_2500
    counts[6] = 5; // le_10000
    expect(histogramPercentile(counts, 50)).toBe(500);
    expect(histogramPercentile(counts, 95)).toBe(2500);
    expect(histogramPercentile(counts, 99)).toBe(10_000);
    const tail = LATENCY_LABELS.map(() => 0);
    tail[LATENCY_EDGES_MS.length] = 10; // gt_60000
    expect(histogramPercentile(tail, 50)).toBeNull();
  });

  test("state follows the last hour, and an open incident can only make it worse", () => {
    expect(stateOf(null, 0.995)).toBe("no_data");
    expect(stateOf(0.999, 0.995)).toBe("operational");
    expect(stateOf(0.95, 0.995)).toBe("degraded");
    expect(stateOf(0.5, 0.995)).toBe("outage");
    expect(stateOf(1, 0.995, "major")).toBe("degraded");
    expect(stateOf(1, 0.995, "critical")).toBe("outage");
    expect(stateOf(0.5, 0.995, "minor")).toBe("outage");
    expect(stateOf(1, 0.995, "none")).toBe("operational");
  });

  test("surfaces are matched by method and path; other routes are not counted", () => {
    expect(surfaceOf("POST", "/api/v1/chat/completions")).toBe("chat");
    expect(surfaceOf("POST", "/v1/responses")).toBe("chat");
    expect(surfaceOf("POST", "/v1/embeddings")).toBe("embeddings");
    expect(surfaceOf("GET", "/api/v1/batches/b_1/output")).toBe("batch");
    expect(surfaceOf("POST", "/v1/messages")).toBe("messages");
    expect(surfaceOf("POST", "/v1/messages/count_tokens")).toBeNull();
    expect(surfaceOf("POST", "/ollama/api/chat")).toBe("ollama");
    expect(surfaceOf("GET", "/ollama/api/tags")).toBeNull();
    expect(surfaceOf("POST", "/api/v1/rerank")).toBe("rerank");
    expect(surfaceOf("OPTIONS", "/api/v1/chat/completions")).toBeNull();
    expect(surfaceOf("GET", "/api/v1/status/slo")).toBeNull();
    expect(activeSurfaces([{ method: "POST", path: "/api/v1/chat/completions" }, { method: "GET", path: "/v1/batches/:id" }, { method: "ALL", path: "*" }])).toEqual(["chat", "batch"]);
  });

  test("private-lane shares come from noisy sums, need enough eligible requests, and leave the caller's refusals out", () => {
    const hour = (attested: number, upstream: number, invalid: number) => ({ requests: { attested, unlinkable: 0, other: 0 }, blocked: { upstream_error: upstream, invalid_request: invalid }, latency: { le_1000: attested } });
    const s = sumDp([hour(60, 2, 10), hour(60, 0, 0)]);
    expect(s.hours).toBe(2);
    expect(s.eligible).toBe(110);
    expect(s.failed).toBe(2);
    expect(dpAvailability(s)).toBeCloseTo(1 - 2 / 110, 9);
    expect(dpAvailability(sumDp([hour(DP_MIN_ELIGIBLE - 1, 0, 0)]))).toBeNull();
    expect(dpAvailability({ eligible: 100, failed: 130 })).toBe(0); // noise can overshoot: clamped
  });

  test("the recorder sums outcomes per surface and five-minute bucket", () => {
    const r = new SloRecorder();
    const t = Date.parse("2026-09-30T10:02:00Z");
    r.record("chat", 200, 300, t);
    r.record("chat", 200, 3000, t + 60_000);
    r.record("chat", 503, 10, t);
    r.record("chat", 429, 10, t);
    r.record("chat", 200, 300, t + BUCKET_MS);
    r.record("embeddings", 400, 10, t);
    expect(r.size).toBe(3);
  });
});

describe("status page API", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const clock = { t: Date.now() };

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.embed] },
        { id: "beta", name: "Beta", models: [MODELS.qwen], behaviour: "error500" },
      ],
    });
    auth = (await h.fundedKey()).auth;
    setPrivateLaneStats(h.ctx, new DpStats({ requestKinds: PRIVATE_LANES, blockReasons: ROUTER_BLOCK_REASONS, epsilon: { requests: 100, blocked: 100, latency: 100, tokens: 100 }, random: seeded(7), now: () => clock.t }));
  });
  afterAll(() => h.close());

  const chat = (model: string, extra: Record<string, unknown> = {}) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model, messages: [{ role: "user", content: "hello" }], ...extra } });
  const windowsTotal = async () => {
    await sloRecorder(h.ctx).flush(h.ctx.db);
    const rows = await h.ctx.db.select().from(statusWindows);
    return rows.reduce((a, r) => ({ ok: a.ok + r.ok, failed: a.failed + r.failed, rejected: a.rejected + r.rejected }), { ok: 0, failed: 0, rejected: 0 });
  };

  test("public-lane requests are counted per surface; private-lane requests never reach the public record", async () => {
    expect((await chat(LLAMA)).status).toBe(200);
    expect((await chat(LLAMA, { stream: true })).status).toBe(200);
    expect((await chat(QWEN)).status).toBeGreaterThanOrEqual(500);
    const e = await h.request("/api/v1/embeddings", { method: "POST", headers: auth, json: { model: "acme/embed-small", input: "hi" } });
    expect(e.status).toBe(200);
    const before = await windowsTotal();
    expect(before).toEqual({ ok: 3, failed: 1, rejected: 0 });

    // An attested-lane request (refused: nothing here attests) and one that names the lane in a header.
    const att = await chat(LLAMA, { provider: { lane: "attested" } });
    expect(att.status).toBeGreaterThanOrEqual(400);
    const hdr = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth, "x-anyroute-lane": "unlinkable" }, json: { model: LLAMA, messages: [{ role: "user", content: "x" }] } });
    expect(hdr.status).toBeGreaterThanOrEqual(200);
    // Embeddings name the lane in the body; the refusal only a private-lane request can get is left out as well.
    const emb = await h.request("/api/v1/embeddings", { method: "POST", headers: auth, json: { model: "acme/embed-small", input: "hi", provider: { lane: "attested" } } });
    expect(emb.status).toBeGreaterThanOrEqual(400);
    expect(await windowsTotal()).toEqual(before);

    const rows = await h.ctx.db.select({ surface: statusWindows.surface, ok: statusWindows.ok, latency: statusWindows.latency }).from(statusWindows);
    expect(rows.map((r) => r.surface).sort()).toEqual(["chat", "embeddings"]);
    const chatRow = rows.find((r) => r.surface === "chat")!;
    expect(chatRow.latency.length).toBe(LATENCY_LABELS.length);
    expect(chatRow.latency.reduce((a, b) => a + b, 0)).toBe(chatRow.ok); // latency is kept for served requests only
  });

  test("a messages call is counted once, under messages, not again as the chat call it makes inside", async () => {
    const before = await h.ctx.db.select().from(statusWindows);
    const r = await h.request("/v1/messages", { method: "POST", headers: { ...auth, "anthropic-version": "2023-06-01" }, json: { model: LLAMA, max_tokens: 16, messages: [{ role: "user", content: "hi" }] } });
    expect(r.status).toBe(200);
    await sloRecorder(h.ctx).flush(h.ctx.db);
    const after = await h.ctx.db.select().from(statusWindows);
    const sum = (rows: typeof after, s: string) => rows.filter((x) => x.surface === s).reduce((a, x) => a + x.ok + x.failed, 0);
    expect(sum(after, "messages") - sum(before, "messages")).toBe(1);
    expect(sum(after, "chat")).toBe(sum(before, "chat"));
  });

  test("GET /api/v1/status/slo: public lane from request sums, private lanes marked dp-noised", async () => {
    const res = await h.request("/api/v1/status/slo");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const d = (await res.json()).data;
    expect(d.object).toBe("status.slo");
    expect(d.windows).toEqual(["1h", "24h", "7d", "30d"]);
    expect(d.lanes.map((l: { lane: string }) => l.lane)).toEqual(["public", "attested", "unlinkable"]);
    const [pub, att, unl] = d.lanes;
    expect(pub.source).toBe("request-aggregates");
    expect(att.source).toBe("dp-noised");
    expect(unl.source).toBe("dp-noised");
    expect(att.privacy.note).toContain("/api/v1/stats");
    expect(pub.target).toBe(0.995);
    expect(att.target).toBe(0.99);
    expect(pub.windows["1h"].eligible).toBeGreaterThanOrEqual(4);
    expect(pub.windows["1h"].errors.server_error).toBe(1);
    expect(pub.daily.length).toBe(90);
    expect(pub.error_budget.window).toBe("30d");
    expect(d.surfaces.map((s: { surface: string }) => s.surface)).toEqual(["chat", "embeddings", "batch", "messages", "ollama", "rerank"]);
    expect(d.surfaces.every((s: { source: string; lane: string }) => s.source === "request-aggregates" && s.lane === "public")).toBe(true);
  });

  test("private lanes are built from the noisy hourly releases only", async () => {
    // Before any hour is released there is nothing to show, whatever the public record holds.
    let d = await buildSlo(h.ctx);
    expect(d.lanes[1].windows["24h"].hours).toBe(0);
    expect(d.lanes[1].windows["24h"].availability).toBeNull();
    // The refused attested request above is in the current hour: release it (epsilon 100, so the count is exact).
    clock.t += HOUR;
    expect(await persistDpHours(h.ctx)).toBeGreaterThanOrEqual(1);
    const stored = await h.ctx.db.select().from(statusDpHours);
    expect(stored.some((r) => (r.counts as { requests: Record<string, number> }).requests.attested >= 1)).toBe(true);
    // Public failures do not move a private lane; a released hour does.
    const now = Date.now();
    await h.ctx.db.insert(statusWindows).values({ surface: "chat", bucket: new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS - 2 * BUCKET_MS), ok: 0, failed: 500, rejected: 0, rateLimited: 0, latency: LATENCY_LABELS.map(() => 0) });
    await h.ctx.db.insert(statusDpHours).values({ instance: "test", hour: new Date(Math.floor(now / HOUR) * HOUR - HOUR), epsilon: 4, counts: { requests: { attested: 150, unlinkable: 50, other: 0 }, blocked: { upstream_error: 4, invalid_request: 0 }, latency: { le_2500: 200 } } });
    d = await buildSlo(h.ctx, ["chat"], now);
    const att = d.lanes[1];
    expect(att.windows["1h"].eligible).toBe(200);
    expect(att.windows["1h"].lane_requests).toBe(150);
    expect(d.lanes[2].windows["1h"].lane_requests).toBe(50);
    expect(att.windows["1h"].availability).toBe(0.98);
    expect(att.latency_24h.p50_ms).toBe(2500);
    expect(att.state).toBe("degraded");
    expect(d.lanes[0].windows["1h"].errors.server_error).toBeGreaterThanOrEqual(500);
    await h.ctx.db.delete(statusWindows).where(sql`${statusWindows.failed} = 500`);
  });

  test("incidents: only the operator writes; the lifecycle ends at resolved", async () => {
    const body = { title: "Slow answers on <chat>", lanes: ["public", "attested"], surfaces: ["chat"], impact: "major", message: "Looking into slow first tokens & timeouts." };
    expect((await h.request("/api/v1/status/incidents", { method: "POST", json: body })).status).toBe(401);
    expect((await h.request("/api/v1/status/incidents", { method: "POST", headers: { "x-admin-token": "wrong" }, json: body })).status).toBe(401);
    expect((await h.request("/api/v1/status/incidents", { method: "POST", headers: auth, json: body })).status).toBe(401);
    expect((await h.request("/api/v1/status/incidents", { method: "POST", headers: op, json: { ...body, lanes: ["moon"] } })).status).toBe(400);
    const created = await h.request("/api/v1/status/incidents", { method: "POST", headers: op, json: body });
    expect(created.status).toBe(201);
    const inc = (await created.json()).data;
    expect(inc).toMatchObject({ status: "investigating", impact: "major", lanes: ["public", "attested"], source: "operator", resolved_at: null });

    const slo = await buildSlo(h.ctx, ["chat"]);
    expect(slo.incidents.open.map((i) => i.id)).toContain(inc.id);
    expect(["degraded", "outage"]).toContain(slo.lanes[0].state);

    const upd = (status: string, message = "update", headers: Record<string, string> = op) => h.request(`/api/v1/status/incidents/${inc.id}/updates`, { method: "POST", headers, json: { status, message } });
    expect((await upd("monitoring", "x", auth)).status).toBe(401);
    expect((await upd("dismissed")).status).toBe(409); // only a suggestion can be dismissed
    expect((await upd("identified", "A slow upstream.")).status).toBe(200);
    const patched = await h.request(`/api/v1/status/incidents/${inc.id}`, { method: "PATCH", headers: op, json: { impact: "minor" } });
    expect((await patched.json()).data.impact).toBe("minor");
    const resolved = await upd("resolved", "Back to normal.");
    const r = (await resolved.json()).data;
    expect(r.status).toBe("resolved");
    expect(r.resolved_at).toBeString();
    expect(r.updates.map((u: { status: string }) => u.status)).toEqual(["resolved", "identified", "investigating"]); // newest first
    expect((await upd("monitoring")).status).toBe(409);

    const list = (await (await h.request("/api/v1/status/incidents")).json()).data;
    expect(list[0].id).toBe(inc.id);
    expect((await h.request(`/api/v1/status/incidents/${inc.id}`)).status).toBe(200);
    expect((await h.request("/api/v1/status/incidents?all=true")).status).toBe(401);
  });

  test("a dip below target for five minutes is recorded as a suggestion, public only once confirmed", async () => {
    const now = Date.now();
    const bucket = new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS - BUCKET_MS);
    await h.ctx.db.insert(statusWindows).values({ surface: "embeddings", bucket, ok: 10, failed: 30, rejected: 0, rateLimited: 0, latency: LATENCY_LABELS.map(() => 0) }).onConflictDoUpdate({ target: [statusWindows.surface, statusWindows.bucket], set: { ok: 10, failed: 30 } });
    const found = await suggestIncidents(h.ctx, now);
    // The public dip above, and the private lanes' last released hour from the earlier test (98% against 99%, dp-noised).
    expect(found.length).toBe(2);
    const made = found.filter((id) => id.startsWith("sug_public_"));
    expect(made.length).toBe(1);
    const [priv] = await h.ctx.db.select().from(statusIncidents).where(sql`${statusIncidents.id} = ${found.find((id) => id.startsWith("sug_private_"))}`);
    expect(priv.lanes).toEqual(["attested", "unlinkable"]);
    expect(priv.evidence).toMatchObject({ window: "1h", source: "dp-noised" });
    expect(await suggestIncidents(h.ctx, now)).toEqual([]); // one open suggestion per lane
    const [row] = await h.ctx.db.select().from(statusIncidents).where(sql`${statusIncidents.id} = ${made[0]}`);
    expect(row.status).toBe("suggested");
    expect(row.surfaces).toEqual(["embeddings"]);
    expect(row.evidence).toMatchObject({ window: "5m", source: "request-aggregates", target: 0.995 });

    const pub = async () => (await (await h.request("/api/v1/status/incidents")).json()).data.map((i: { id: string }) => i.id);
    expect(await pub()).not.toContain(made[0]);
    expect((await h.request(`/api/v1/status/incidents/${made[0]}`)).status).toBe(404);
    const all = (await (await h.request("/api/v1/status/incidents?all=true", { headers: op })).json()).data.map((i: { id: string }) => i.id);
    expect(all).toContain(made[0]);

    const confirm = await h.request(`/api/v1/status/incidents/${made[0]}/updates`, { method: "POST", headers: op, json: { status: "investigating", message: "Confirmed: embeddings failing." } });
    expect(confirm.status).toBe(200);
    expect(await pub()).toContain(made[0]);
  });

  test("feeds: Atom and RSS list confirmed incidents, escaped", async () => {
    const atom = await h.request("/api/v1/status/incidents.atom");
    expect(atom.status).toBe(200);
    expect(atom.headers.get("content-type")).toContain("application/atom+xml");
    const a = await atom.text();
    expect(a.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(a).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(a).toContain("Slow answers on &lt;chat&gt;");
    expect(a).not.toContain("<chat>");
    expect(a.match(/<entry>/g)?.length).toBe(2);
    expect(a).toMatch(/<updated>\d{4}-\d\d-\d\dT/);
    const rss = await h.request("/api/v1/status/incidents.rss");
    expect(rss.headers.get("content-type")).toContain("application/rss+xml");
    const s = await rss.text();
    expect(s).toContain('<rss version="2.0"');
    expect(s.match(/<item>/g)?.length).toBe(2);
    expect(s).toContain("first tokens &amp; timeouts");
    expect(s).not.toContain("—");

    const row = { id: "inc_x", title: "A & B", status: "resolved", impact: "minor", lanes: ["public"], surfaces: [], source: "operator", updates: [{ at: "2026-09-30T00:00:00.000Z", status: "resolved", text: "done" }], evidence: null, startedAt: new Date("2026-09-30T00:00:00Z"), resolvedAt: new Date("2026-09-30T01:00:00Z"), createdAt: new Date(), updatedAt: new Date("2026-09-30T01:00:00Z") };
    const feed = atomFeed("https://anyroute.example", [incidentJson(row)], Date.parse("2026-09-30T02:00:00Z"));
    expect(feed).toContain("<title>[Resolved] A &amp; B</title>");
    expect(feed).toContain("https://anyroute.example/status/#incident-inc_x");
    expect(rssFeed("https://anyroute.example", [])).not.toContain("<item>");
  });
});
