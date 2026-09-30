import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Catalog, ROUTING_SUFFIXES, SORT_SUFFIXES, type Candidate, type ModelRow } from "../src/catalog/catalog.ts";
import { selectProviders, type HealthView } from "../src/router/select.ts";
import { UNDECLARED, profileOf } from "../src/router/disclosure.ts";
import { MAINSTREAM } from "../src/router/lane.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

// Model suffixes :nitro (fastest first) and :floor (cheapest first), OpenRouter semantics: the same as provider.sort
// "throughput" and "price". They combine with every other provider preference, and a lane still filters first.

const LLAMA = "meta-llama/llama-3.3-70b-instruct";

describe("suffix parsing", () => {
  const catalog = new Catalog(null as never);
  const model = (id: string) => ({ id }) as unknown as ModelRow;
  catalog.models = new Map([
    [LLAMA, model(LLAMA)],
    ["acme/tagged:v2", model("acme/tagged:v2")],
  ]);
  const parse = (id: string) => {
    const r = catalog.resolve(id);
    return r ? { id: r.model.id, modifiers: [...r.modifiers].sort() } : null;
  };

  test(":nitro and :floor resolve to the base model with that modifier", () => {
    expect(parse(`${LLAMA}:nitro`)).toEqual({ id: LLAMA, modifiers: ["nitro"] });
    expect(parse(`${LLAMA}:floor`)).toEqual({ id: LLAMA, modifiers: ["floor"] });
    expect(parse(LLAMA)).toEqual({ id: LLAMA, modifiers: [] });
  });

  test("suffixes stack with :free and :private, in any order", () => {
    expect(parse(`${LLAMA}:floor:free`)).toEqual({ id: LLAMA, modifiers: ["floor", "free"] });
    expect(parse(`${LLAMA}:private:nitro`)).toEqual({ id: LLAMA, modifiers: ["nitro", "private"] });
  });

  test("an id that itself contains a colon still resolves, with or without a suffix", () => {
    expect(parse("acme/tagged:v2")).toEqual({ id: "acme/tagged:v2", modifiers: [] });
    expect(parse("acme/tagged:v2:nitro")).toEqual({ id: "acme/tagged:v2", modifiers: ["nitro"] });
  });

  test("unknown suffixes and unknown models do not resolve", () => {
    expect(parse(`${LLAMA}:turbo`)).toBeNull();
    expect(parse(`${LLAMA}:nitro:turbo`)).toBeNull();
    expect(parse("nobody/nothing:nitro")).toBeNull();
    expect(parse(":nitro")).toBeNull();
  });

  test("the sort suffixes are routing suffixes", () => {
    expect(SORT_SUFFIXES).toEqual(["nitro", "floor"]);
    for (const s of SORT_SUFFIXES) expect(ROUTING_SUFFIXES).toContain(s);
  });
});

// ---- ordering ------------------------------------------------------------------------------------------------

const provider = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, status: "live", dataPolicy: { training: false, retains_prompts: false, zdr: true }, attested: false, attestationHash: null, attestedAt: null, teeKind: null, anyrStake: 0n, datacenter: [], ...extra }) as unknown as Candidate["provider"];
const offer = (pid: string, prompt: bigint, pextra: Record<string, unknown> = {}) =>
  ({ modelId: "m/x", providerId: pid, providerModelId: "x", pricePrompt: prompt, priceCompletion: prompt * 3n, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, priceCacheRead: null, priceCacheWrite: null, quant: "bf16", ctx: 100_000, maxOut: 4096, supportedParameters: [], features: {}, isModerated: false, status: "live", updatedAt: new Date(), provider: provider(pid, pextra) }) as unknown as Candidate;
const tee = { attested: true, attestationHash: "0xabc", attestedAt: new Date(), teeKind: "tdx" };
const attestedProfile = profileOf({ retention: "attested", jurisdiction: "CH", legalHold: false, legalHoldNote: null, trainingUse: "none", claims: {}, updatedAt: new Date() });

// Throughput (tokens/s, p50) and price per provider: cheap is slow, fast is dear.
const TPS: Record<string, number> = { cheap: 20, mid: 80, fast: 300, tee_slow: 30, tee_fast: 250 };
const health: HealthView = {
  outage: () => false,
  uptime30d: () => 1,
  quality: () => 1,
  stats: (_m, p) => (TPS[p] != null ? { latency: { p50: 100 }, throughput: { p50: TPS[p] } } : null),
};
const cheap = offer("cheap", 100n);
const mid = offer("mid", 200n);
const fast = offer("fast", 400n);
const teeSlow = offer("tee_slow", 300n, tee);
const teeFast = offer("tee_fast", 900n, tee);
const unknown = offer("unmeasured", 150n);

function run(offers: Candidate[], modifiers: string[], prefs: Record<string, unknown> = {}) {
  const attested = new Set(offers.filter((o) => o.provider.attested).map((o) => o.providerId));
  const s = selectProviders({
    modelId: "m/x",
    offers,
    prefs,
    modifiers: new Set(modifiers) as never,
    requestParams: [],
    estimatedTokens: 100,
    health,
    production: true,
    attestationMaxAgeMs: 3_600_000,
    disclosure: (id) => (attested.has(id) ? attestedProfile : UNDECLARED),
    modelLane: MAINSTREAM,
    rand: () => 0.5,
  });
  return { order: s.ordered.map((o) => o.providerId), excluded: s.excluded };
}

describe("ordering", () => {
  const all = [mid, cheap, fast, unknown];

  test(":nitro orders by measured throughput, fastest first; unmeasured endpoints go last", () => {
    expect(run(all, ["nitro"]).order).toEqual(["fast", "mid", "cheap", "unmeasured"]);
  });

  test(":floor orders by price, cheapest first", () => {
    expect(run(all, ["floor"]).order).toEqual(["cheap", "unmeasured", "mid", "fast"]);
  });

  test("each is exactly provider.sort throughput / price", () => {
    expect(run(all, ["nitro"]).order).toEqual(run(all, [], { sort: "throughput" }).order);
    expect(run(all, ["floor"]).order).toEqual(run(all, [], { sort: "price" }).order);
    expect(run(all, ["floor"]).order).toEqual(run(all, [], { sort: { by: "price" } }).order);
  });

  test("a suffix wins over provider.sort, and :nitro wins over :floor", () => {
    expect(run(all, ["floor"], { sort: "throughput" }).order[0]).toBe("cheap");
    expect(run(all, ["nitro"], { sort: "price" }).order[0]).toBe("fast");
    expect(run(all, ["nitro", "floor"]).order[0]).toBe("fast");
  });
});

describe("combinations", () => {
  test("provider.order pins its providers first; the rest follow in suffix order", () => {
    expect(run([mid, cheap, fast], ["nitro"], { order: ["cheap"] }).order).toEqual(["cheap", "fast", "mid"]);
    expect(run([mid, cheap, fast], ["floor"], { order: ["fast"] }).order).toEqual(["fast", "cheap", "mid"]);
    expect(run([mid, cheap, fast], ["floor"], { order: ["fast", "mid"], allow_fallbacks: false }).order).toEqual(["fast", "mid"]);
  });

  test("allow_fallbacks false without an order keeps only the first by suffix", () => {
    expect(run([mid, cheap, fast], ["nitro"], { allow_fallbacks: false }).order).toEqual(["fast"]);
    expect(run([mid, cheap, fast], ["floor"], { allow_fallbacks: false }).order).toEqual(["cheap"]);
  });

  test("only / ignore / max_price filter before the sort", () => {
    expect(run([mid, cheap, fast], ["nitro"], { ignore: ["fast"] }).order).toEqual(["mid", "cheap"]);
    expect(run([mid, cheap, fast], ["floor"], { only: ["mid", "fast"] }).order).toEqual(["mid", "fast"]);
    // Prices here are pico-USD a token: "fast" (400) is $0.0004 per million prompt tokens, over a $0.0003 ceiling.
    expect(run([mid, cheap, fast], ["nitro"], { max_price: { prompt: "0.0003" } }).order).toEqual(["mid", "cheap"]);
  });

  test("lane attested filters first: :floor never picks a cheaper endpoint outside the lane", () => {
    const r = run([cheap, mid, teeSlow, teeFast], ["floor"], { lane: "attested" });
    expect(r.order).toEqual(["tee_slow", "tee_fast"]);
    for (const p of ["cheap", "mid"]) expect(r.excluded.map((e) => e.provider)).toContain(p);
  });

  test("lane attested filters first: :nitro never picks a faster endpoint outside the lane", () => {
    expect(run([fast, teeSlow, teeFast], ["nitro"], { lane: "attested" }).order).toEqual(["tee_fast", "tee_slow"]);
  });

  test("lane attested + provider.order: a pinned endpoint outside the lane is not added back", () => {
    expect(run([fast, cheap, teeSlow, teeFast], ["nitro"], { lane: "attested", order: ["cheap", "tee_slow"] }).order).toEqual(["tee_slow", "tee_fast"]);
    expect(run([fast, cheap, teeSlow], ["floor"], { lane: "attested", order: ["cheap"], allow_fallbacks: false }).order).toEqual([]);
  });

  test("a lane with no endpoint stays empty whatever the suffix", () => {
    expect(run([cheap, mid, fast], ["floor"], { lane: "attested" }).order).toEqual([]);
    expect(run([cheap, mid, fast], ["nitro"], { disclosure: "none" }).order).toEqual([]);
  });

  test(":private with :floor: attested endpoints only, cheapest first", () => {
    expect(run([cheap, teeFast, teeSlow], ["private", "floor"]).order).toEqual(["tee_slow", "tee_fast"]);
  });
});

// ---- through the router --------------------------------------------------------------------------------------

describe("chat completions with :nitro and :floor", () => {
  let h: Harness;
  let auth: Record<string, string>;
  beforeAll(async () => {
    // alpha serves llama cheaply, beta at four times the price.
    h = await startRouter({
      providers: [
        { id: "alpha", name: "Alpha", models: [MODELS.llama] },
        { id: "beta", name: "Beta", models: [MODELS.llamaPricey] },
      ],
    });
    auth = (await h.fundedKey()).auth;
    // beta measures ten times alpha's throughput.
    for (let i = 0; i < 3; i++) {
      h.ctx.health.record({ modelId: LLAMA, providerId: "alpha", ok: true, latencyMs: 200, tps: 20, source: "probe" });
      h.ctx.health.record({ modelId: LLAMA, providerId: "beta", ok: true, latencyMs: 200, tps: 200, source: "probe" });
    }
  });
  afterAll(() => h?.close());

  const chat = (model: string, provider?: Record<string, unknown>) =>
    h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model, messages: [{ role: "user", content: "hi" }], ...(provider ? { provider } : {}) } });

  test(":floor serves from the cheapest provider, :nitro from the fastest, every time", async () => {
    for (let i = 0; i < 3; i++) {
      const floor = await chat(`${LLAMA}:floor`);
      expect(floor.status).toBe(200);
      expect((await floor.json()).provider).toBe("Alpha");
      const nitro = await chat(`${LLAMA}:nitro`);
      expect(nitro.status).toBe(200);
      expect((await nitro.json()).provider).toBe("Beta");
    }
  });

  test("the response names the base model", async () => {
    const j = await (await chat(`${LLAMA}:nitro`)).json();
    expect(j.model).toBe(LLAMA);
  });

  test("provider.order still pins first", async () => {
    expect((await (await chat(`${LLAMA}:nitro`, { order: ["alpha"] })).json()).provider).toBe("Alpha");
    expect((await (await chat(`${LLAMA}:floor`, { order: ["beta"] })).json()).provider).toBe("Beta");
  });

  test(":floor falls back to the next cheapest when the cheapest fails", async () => {
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
    try {
      const r = await chat(`${LLAMA}:floor`);
      expect(r.status).toBe(200);
      expect((await r.json()).provider).toBe("Beta");
    } finally {
      await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "ok" }) });
    }
  });

  test("lane attested with :floor is refused when no endpoint is attested: no fallback to the cheap public one", async () => {
    const r = await chat(`${LLAMA}:floor`, { lane: "attested" });
    expect([409, 503]).toContain(r.status);
    expect((await r.json()).error.message).not.toContain("Hello from");
  });

  test("GET /api/v1/models lists the routing variants", async () => {
    const j = await (await h.request("/api/v1/models")).json();
    const m = j.data.find((x: { id: string }) => x.id === LLAMA);
    expect(m.routing_variants).toEqual(["nitro", "floor"]);
  });
});
