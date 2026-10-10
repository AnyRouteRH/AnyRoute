import { expect, test } from "bun:test";
import { Hono } from "hono";
import { modelsRoutes } from "../src/api/models.ts";
import { modelPerformance, recentPerformance } from "../src/catalog/model-performance.ts";
import { HealthTracker, type HealthEvent } from "../src/services/health.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { Candidate, ModelRow } from "../src/catalog/catalog.ts";

const model = { id: "sample/model", name: "Sample model", hidden: false, ctx: 4000, createdUnix: 1 } as ModelRow;
function fixture(cache = false) {
  const offers = ["first", "second"].map(providerId => ({
    modelId: model.id, providerId, providerModelId: model.id, status: "live", pricePrompt: 1n, priceCompletion: 1n,
    priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n,
    provider: { id: providerId, name: providerId, status: "live", attested: false },
  })) as Candidate[];
  const cfg = loadConfig({}); cfg.rush.catalogCache = cache;
  const health = new HealthTracker();
  const ctx = { cfg, health, catalog: {
    models: new Map([[model.id, model]]), offers: () => offers, ensureFresh: async () => {},
    providers: new Map(offers.map(o => [o.providerId, o.provider])), disclosure: new Map(), manifests: new Map(), lane: new Map(), laneOf: () => ({ variant: "mainstream", servable: true, source: "default" }),
  } } as unknown as Ctx;
  const app = new Hono(); modelsRoutes(app, ctx);
  return { ctx, health, offers, app };
}
const record = (health: HealthTracker, providerId: string, latencyMs: number, tps: number) => {
  for (let i = 0; i < 3; i++) health.record({ modelId: model.id, providerId, ok: true, latencyMs, tps });
};

test("recent speed medians exclude old, future, failed and invalid readings, without substituting zero", () => {
  const now = 10_000_000;
  const event = (patch: Partial<HealthEvent> = {}): HealthEvent => ({ modelId: model.id, providerId: "first", ok: true, at: now, latencyMs: 400, tps: 20, ...patch });
  expect(recentPerformance([], now)).toEqual({ latency_p50_ms: null, throughput_p50_tps: null });
  expect(recentPerformance([event(), event()], now).latency_p50_ms).toBeNull();
  const fresh = [event({ latencyMs: 200, tps: 10 }), event(), event({ latencyMs: 800, tps: 40 })];
  const ignored = [event({ at: now - 1800_000 }), event({ at: now + 1 }), event({ ok: false }), event({ latencyMs: NaN, tps: Infinity }), event({ latencyMs: -1, tps: -1 })];
  expect(recentPerformance([...fresh, ...ignored], now)).toEqual({ latency_p50_ms: 400, throughput_p50_tps: 20 });
  expect(recentPerformance(fresh, now + 1800_001)).toEqual({ latency_p50_ms: null, throughput_p50_tps: null });
  expect(recentPerformance([event({ latencyMs: 0, tps: 0 }), event({ latencyMs: 0, tps: 0 }), event({ latencyMs: 0, tps: 0 })], now)).toEqual({ latency_p50_ms: 0, throughput_p50_tps: 0 });
});

test("model readings use only its eligible routes, deduplicate providers and weight observed uptime without a prior", () => {
  const { ctx, health, offers } = fixture();
  expect(modelPerformance(ctx, model.id, offers)).toMatchObject({ latency_p50_ms: null, throughput_p50_tps: null, uptime_percent: null, uptime_observations: 0 });
  record(health, "first", 400, 20); record(health, "second", 800, 70); record(health, "unrelated", 1, 1000);
  health.record({ modelId: model.id, providerId: "second", ok: false, errorKind: "timeout" });
  health.record({ modelId: model.id, providerId: "second", ok: false, errorKind: "rejected" });
  health.record({ modelId: model.id, providerId: "second", ok: false, errorKind: "rate_limited" });
  expect(modelPerformance(ctx, model.id, [...offers, offers[0]])).toEqual({ latency_p50_ms: 400, throughput_p50_tps: 70, speed_window_seconds: 1800, uptime_percent: 85.71, uptime_window_days: 30, uptime_observations: 7 });
  expect(modelPerformance(ctx, model.id, [offers[0]])).toMatchObject({ throughput_p50_tps: 20, uptime_percent: 100, uptime_observations: 3 });
  expect(modelPerformance(ctx, "sample/other", offers).uptime_percent).toBeNull();
});

test("both public aliases opt in without a key; default and unrecognised query responses remain byte-identical", async () => {
  const { app, health } = fixture(); record(health, "first", 400, 20);
  const original = await app.request("/api/v1/models"); expect(original.status).toBe(200);
  const body = await original.text();
  expect(await (await app.request("/api/v1/models?health=unknown")).text()).toBe(body);
  expect(JSON.parse(body).data[0]).not.toHaveProperty("performance");
  for (const path of ["/api/v1/models", "/v1/models"]) {
    const response = await app.request(path + "?health=recent"); expect(response.status).toBe(200);
    expect((await response.json()).data[0].performance).toMatchObject({ latency_p50_ms: 400, throughput_p50_tps: 20, uptime_percent: 100 });
    const restricted = await app.request(path + "?health=recent&lane=attested");
    expect(restricted.status).toBe(200); expect((await restricted.json()).data).toEqual([]);
  }
});

test("opt-in health cannot poison the default cache or reuse an old cached reading", async () => {
  const { app, health } = fixture(true);
  const first = await app.request("/api/v1/models?health=recent");
  expect((await first.json()).data[0].performance.latency_p50_ms).toBeNull();
  record(health, "first", 400, 20);
  const defaults = await app.request("/api/v1/models"); const body = await defaults.text();
  expect(JSON.parse(body).data[0]).not.toHaveProperty("performance");
  expect((await (await app.request("/v1/models?health=recent")).json()).data[0].performance.latency_p50_ms).toBe(400);
  expect(await (await app.request("/api/v1/models")).text()).toBe(body);
});
