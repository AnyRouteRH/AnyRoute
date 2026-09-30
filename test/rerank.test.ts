import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generations } from "../src/db/schema.ts";
import { estimateRerank, parseRerankRequest, readRerankResults, readRerankUsage } from "../src/router/rerank.ts";
import { priceUsage } from "../src/router/pricing.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import type { Candidate, ModelRow } from "../src/catalog/catalog.ts";

// POST /api/v1/rerank: Cohere / Jina shaped, routed to catalogue models whose outputs include "rerank", served through
// a provider's own /rerank. The mock providers score by word overlap (src/providers/mock.ts); the router passes their
// scores on, checked, and never makes one up.

const SMALL = "acme/rerank-small"; // priced per token (Jina-style answer with usage.total_tokens)
const SU = "acme/rerank-v3"; // priced per search unit (Cohere-style answer with meta.billed_units)
const RERANK_SMALL = { id: "rerank-small-v1", slug: SMALL, prompt: "0.00000002", completion: "0", output: ["rerank"] };
const RERANK_SMALL_PRICEY = { ...RERANK_SMALL, prompt: "0.0000001" };
const RERANK_SU = { id: "rerank-v3.5", slug: SU, prompt: "0", completion: "0", request: "0.002", output: ["rerank"] };
const LLAMA = "meta-llama/llama-3.3-70b-instruct";

const QUERY = "capital of france";
const DOCS = ["Bananas are yellow and grow in bunches.", "Paris is the capital of France.", { text: "Lyon is a city in France." }, "The capital of Australia is Canberra."];
const TEXTS = DOCS.map((d) => (typeof d === "string" ? d : d.text));
const mockTokens = (query: string, docs: string[]) => docs.reduce((n, d) => n + Math.ceil((query.length + d.length) / 4), 0);

let h: Harness;
let auth: Record<string, string>;
const rerank = (json: Record<string, unknown>, headers: Record<string, string> = auth, path = "/api/v1/rerank") => h.request(path, { method: "POST", headers, json });
const control = (id: string, cfg: Record<string, unknown>) => fetch(h.mocks[id].url + "/_control", { method: "POST", body: JSON.stringify(cfg) });
const balance = async (a: Record<string, string>) => Number((await (await h.request("/api/v1/credits", { headers: a })).json()).data.total_usage);

beforeAll(async () => {
  h = await startRouter({
    providers: [
      { id: "alpha", name: "Alpha", models: [MODELS.llama, RERANK_SMALL] },
      { id: "gamma", name: "Gamma", models: [RERANK_SMALL_PRICEY] },
      { id: "beta", name: "Beta", models: [RERANK_SU], rerankShape: "cohere" },
    ],
  });
  auth = (await h.fundedKey()).auth;
});
afterAll(() => h?.close());

describe("request shape", () => {
  test("parses string and { text } documents; top_n defaults to all and is capped at the document count", () => {
    const r = parseRerankRequest({ model: SMALL, query: QUERY, documents: DOCS });
    expect(r.documents).toEqual(TEXTS);
    expect(r.topN).toBe(4);
    expect(r.returnDocuments).toBe(false);
    expect(parseRerankRequest({ model: SMALL, query: QUERY, documents: DOCS, top_n: 99 }).topN).toBe(4);
  });

  test("400 for a missing query, empty or malformed documents, a bad top_n or return_documents", async () => {
    for (const body of [
      { model: SMALL, documents: TEXTS },
      { model: SMALL, query: "  ", documents: TEXTS },
      { model: SMALL, query: QUERY, documents: [] },
      { model: SMALL, query: QUERY, documents: "one" },
      { model: SMALL, query: QUERY, documents: [1, 2] },
      { model: SMALL, query: QUERY, documents: [{ title: "no text" }] },
      { model: SMALL, query: QUERY, documents: TEXTS, top_n: 0 },
      { model: SMALL, query: QUERY, documents: TEXTS, top_n: 1.5 },
      { model: SMALL, query: QUERY, documents: TEXTS, return_documents: "yes" },
      { query: QUERY, documents: TEXTS },
      { model: SMALL, query: QUERY, documents: Array.from({ length: 1001 }, () => "x") },
    ]) {
      const r = await rerank(body);
      expect(r.status).toBe(400);
      expect((await r.json()).error.type).toBe("invalid_request");
    }
  });
});

describe("provider answers", () => {
  const req = parseRerankRequest({ model: SMALL, query: QUERY, documents: TEXTS, top_n: 2, return_documents: true });

  test("orders by score (ties by index), cuts to top_n and attaches the caller's own text", () => {
    const out = readRerankResults({ results: [{ index: 0, relevance_score: 0.1 }, { index: 3, relevance_score: 0.9 }, { index: 1, relevance_score: 0.9 }, { index: 2, relevance_score: 0.5 }] }, req);
    expect(out).toEqual([
      { index: 1, relevance_score: 0.9, document: { text: TEXTS[1] } },
      { index: 3, relevance_score: 0.9, document: { text: TEXTS[3] } },
    ]);
  });

  test("accepts `score` and a bare array", () => {
    expect(readRerankResults([{ index: 2, score: 0.4 }], { ...req, returnDocuments: false })).toEqual([{ index: 2, relevance_score: 0.4 }]);
  });

  test("refuses anything that is not a ranking of the documents sent: nothing is filled in", () => {
    for (const bad of [
      null,
      {},
      { results: [] },
      { results: [{ index: 4, relevance_score: 0.5 }] },
      { results: [{ index: -1, relevance_score: 0.5 }] },
      { results: [{ index: 0.5, relevance_score: 0.5 }] },
      { results: [{ index: 0, relevance_score: "0.5" }] },
      { results: [{ index: 0 }] },
      { results: [{ index: 0, relevance_score: Number.NaN }] },
      { results: [{ index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.4 }] },
    ])
      expect(readRerankResults(bad, req)).toBeNull();
  });

  test("usage: tokens and search units as reported, null when not", () => {
    expect(readRerankUsage({ usage: { total_tokens: 42 } })).toEqual({ tokens: 42, searchUnits: null });
    expect(readRerankUsage({ meta: { billed_units: { search_units: 2 } } })).toEqual({ tokens: null, searchUnits: 2 });
    expect(readRerankUsage({})).toEqual({ tokens: null, searchUnits: null });
  });

  test("the estimate counts every (query, document) pair and Cohere's 100-chunk search units", () => {
    expect(estimateRerank({ query: "q", documents: ["a"] }).searchUnits).toBe(1);
    expect(estimateRerank({ query: "q", documents: Array.from({ length: 150 }, () => "a") }).searchUnits).toBe(2);
    // A 3,000-character document is three 500-token chunks.
    expect(estimateRerank({ query: "q", documents: Array.from({ length: 50 }, () => "a".repeat(3000)) }).searchUnits).toBe(2);
  });

  test("a search unit is charged the request price once per unit", () => {
    const cand = { pricePrompt: 0n, priceCompletion: 0n, priceRequest: 7n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, priceCacheRead: null, priceCacheWrite: null } as unknown as Candidate;
    const model = { royaltyBps: 0, creator: null } as unknown as ModelRow;
    const u = { prompt: 10, completion: 0, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: false };
    const fees = { royaltyBps: 0, perCallMarginBps: 0, byokFeeBps: 0 };
    expect(priceUsage(cand, model, { ...u, searchUnits: 3 }, "prepaid", fees, false).total).toBe(21n);
    expect(priceUsage(cand, model, u, "prepaid", fees, false).total).toBe(7n); // other calls: one request, as before
  });
});

describe("POST /api/v1/rerank", () => {
  test("Cohere/Jina shape: results best first with scores, usage, cost and a signed receipt", async () => {
    const r = await rerank({ model: SMALL, query: QUERY, documents: DOCS });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.object).toBe("rerank");
    expect(j.model).toBe(SMALL);
    expect(j.provider).toBe("Alpha");
    expect(j.id).toBe(r.headers.get("x-receipt-id"));
    expect(j.results.map((x: { index: number }) => x.index)).toEqual([1, 3, 2, 0]);
    expect(j.results[0].relevance_score).toBe(1);
    for (let i = 1; i < j.results.length; i++) expect(j.results[i - 1].relevance_score).toBeGreaterThanOrEqual(j.results[i].relevance_score);
    expect(j.results[0].document).toBeUndefined();
    expect(j.usage.total_tokens).toBe(mockTokens(QUERY, TEXTS));
    expect(j.usage.search_units).toBe(1);
    expect(j.meta.billed_units.search_units).toBe(1);
    expect(j.cost).toBe(j.usage.cost);
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
    // What the provider was sent: its own model id, the documents as strings, top_n.
    const sent = h.mocks.alpha.stats.lastBody;
    expect(sent).toEqual({ model: "rerank-small-v1", query: QUERY, documents: TEXTS, top_n: 4 });
    expect(h.mocks.alpha.stats.lastAuth).toBe("Bearer upstream-key-alpha");
  });

  test("top_n keeps the best n; return_documents attaches each document's text", async () => {
    const one = await (await rerank({ model: SMALL, query: QUERY, documents: DOCS, top_n: 1 })).json();
    expect(one.results).toEqual([{ index: 1, relevance_score: 1 }]);
    const two = await (await rerank({ model: SMALL, query: QUERY, documents: DOCS, top_n: 2, return_documents: true })).json();
    expect(two.results.map((x: { index: number }) => x.index)).toEqual([1, 3]);
    expect(two.results[0].document).toEqual({ text: TEXTS[1] });
    expect(two.results[1].document).toEqual({ text: TEXTS[3] });
    const objects = await (await rerank({ model: SMALL, query: QUERY, documents: DOCS, return_documents: true })).json();
    expect(objects.results.find((x: { index: number }) => x.index === 2).document).toEqual({ text: "Lyon is a city in France." });
  });

  test("per-token pricing: the provider's reported tokens at its prompt price, charged exactly", async () => {
    const before = await balance(auth);
    const j = await (await rerank({ model: SMALL, query: QUERY, documents: DOCS })).json();
    const expected = (mockTokens(QUERY, TEXTS) * 20_000) / 1e12; // $0.00000002 a token = 20,000 pico-USD
    expect(j.usage.cost).toBeCloseTo(expected, 15);
    expect(j.usage.cost_details.upstream_inference_cost).toBeCloseTo(expected, 15);
    expect(j.usage.estimated).toBeUndefined();
    expect((await balance(auth)) - before).toBeCloseTo(expected, 12);
  });

  test("per-search-unit pricing: the provider's billed search units at its request price", async () => {
    const small = await rerank({ model: SU, query: QUERY, documents: DOCS, return_documents: true });
    expect(small.status).toBe(200);
    const j = await small.json();
    expect(j.provider).toBe("Beta");
    expect(j.usage.search_units).toBe(1);
    expect(j.usage.cost).toBeCloseTo(0.002, 15);
    // A Cohere-style answer carries no documents: the router attaches the caller's own.
    expect(j.results[0]).toEqual({ index: 1, relevance_score: 1, document: { text: TEXTS[1] } });
    const many = await (await rerank({ model: SU, query: QUERY, documents: Array.from({ length: 150 }, (_, i) => `doc ${i} about france`) })).json();
    expect(many.usage.search_units).toBe(2);
    expect(many.usage.cost).toBeCloseTo(0.004, 15);
    expect(many.results).toHaveLength(150);
  });

  test("an answer without usage is billed on the estimate and says so", async () => {
    await control("alpha", { behaviour: "no_usage" });
    try {
      const j = await (await rerank({ model: SMALL, query: QUERY, documents: DOCS, provider: { order: ["alpha"] } })).json();
      expect(j.provider).toBe("Alpha");
      expect(j.usage.estimated).toBe(true);
      expect(j.usage.total_tokens).toBe(estimateRerank({ query: QUERY, documents: TEXTS }).tokens);
      expect(j.receipt.payload.tokens.estimated).toBe(true);
    } finally {
      await control("alpha", { behaviour: "ok" });
    }
  });

  test("receipts: signed, verifiable, recorded as a generation with the rerank kind and billed units", async () => {
    const j = await (await rerank({ model: SU, query: QUERY, documents: DOCS })).json();
    const { payload, sig, key_id } = j.receipt;
    expect(payload).toMatchObject({ v: 1, id: j.id, kind: "rerank", model: SU, provider: "beta", search_units: 1, documents: 4, lane: "public", mode: "prepaid" });
    expect(payload.cost).toBe("0.002");
    const v = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload, sig, key_id } })).json();
    expect(v.data.signature_valid).toBe(true);
    const tampered = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: { ...payload, search_units: 0 }, sig, key_id } })).json();
    expect(tampered.data.signature_valid).toBe(false);
    const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, j.id));
    expect(row.modelId).toBe(SU);
    expect(row.providerId).toBe("beta");
    expect(row.receiptSig).toBe(sig);
    const g = await h.request(`/api/v1/generation?id=${j.id}`, { headers: auth });
    expect(g.status).toBe(200);
  });

  test("/v1/rerank is the same endpoint", async () => {
    const r = await rerank({ model: SMALL, query: QUERY, documents: DOCS, top_n: 1 }, auth, "/v1/rerank");
    expect(r.status).toBe(200);
    expect((await r.json()).results[0].index).toBe(1);
  });
});

describe("routing", () => {
  test(":floor serves from the cheaper provider; :nitro from the faster", async () => {
    for (let i = 0; i < 3; i++) {
      h.ctx.health.record({ modelId: SMALL, providerId: "alpha", ok: true, latencyMs: 300, tps: 10, source: "probe" });
      h.ctx.health.record({ modelId: SMALL, providerId: "gamma", ok: true, latencyMs: 300, tps: 500, source: "probe" });
    }
    expect((await (await rerank({ model: `${SMALL}:floor`, query: QUERY, documents: DOCS })).json()).provider).toBe("Alpha");
    const nitro = await (await rerank({ model: `${SMALL}:nitro`, query: QUERY, documents: DOCS })).json();
    expect(nitro.provider).toBe("Gamma");
    expect(nitro.model).toBe(SMALL);
  });

  test("a failed or malformed answer falls back to the next provider; nothing is billed for it", async () => {
    await control("alpha", { behaviour: "error500" });
    try {
      const j = await (await rerank({ model: `${SMALL}:floor`, query: QUERY, documents: DOCS })).json();
      expect(j.provider).toBe("Gamma");
    } finally {
      await control("alpha", { behaviour: "ok" });
    }
    await control("alpha", { rerankShape: "invalid" });
    try {
      const j = await (await rerank({ model: `${SMALL}:floor`, query: QUERY, documents: DOCS })).json();
      expect(j.provider).toBe("Gamma");
      expect(j.results.every((x: { index: number }) => x.index >= 0 && x.index < DOCS.length)).toBe(true);
    } finally {
      await control("alpha", { rerankShape: "jina" });
    }
  });

  test("never fakes scores: when no provider gives a valid ranking the call fails (502) and nothing is charged", async () => {
    await control("alpha", { rerankShape: "invalid" });
    await control("gamma", { behaviour: "empty200" });
    try {
      const before = await balance(auth);
      const r = await rerank({ model: SMALL, query: QUERY, documents: DOCS });
      expect(r.status).toBe(502);
      const e = (await r.json()).error;
      expect(e.type).toBe("providers_unavailable");
      expect(e.metadata.attempts.map((a: { error_kind: string }) => a.error_kind).sort()).toEqual(["empty200", "unreadable"]);
      expect(await balance(auth)).toBe(before);
    } finally {
      await control("alpha", { rerankShape: "jina" });
      await control("gamma", { behaviour: "ok" });
    }
  });

  test("provider preferences apply: ignoring every provider is 404 no_providers", async () => {
    const r = await rerank({ model: SMALL, query: QUERY, documents: DOCS, provider: { ignore: ["alpha", "gamma"] } });
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("no_providers");
    expect((await (await rerank({ model: SMALL, query: QUERY, documents: DOCS, provider: { only: ["gamma"] } })).json()).provider).toBe("Gamma");
  });

  test("lane attested is never served by a public endpoint", async () => {
    const r = await rerank({ model: `${SMALL}:floor`, query: QUERY, documents: DOCS, provider: { lane: "attested" } });
    expect([409, 503]).toContain(r.status);
    expect((await r.json()).results).toBeUndefined();
    const hdr = await rerank({ model: SMALL, query: QUERY, documents: DOCS }, { ...auth, "x-anyroute-lane": "attested" });
    expect([409, 503]).toContain(hdr.status);
  });

  test("budgets: a session key whose budget is below the hold is refused before any provider is called", async () => {
    const owner = await h.fundedKey();
    const s = await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { name: "rerank", budget_usd: 0.0000001 } })).json();
    const before = h.mocks.beta.stats.requests;
    const r = await rerank({ model: SU, query: QUERY, documents: DOCS }, { authorization: `Bearer ${s.data.key}` });
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("key_budget_exceeded");
    expect(h.mocks.beta.stats.requests).toBe(before);
  });

  test("an empty balance is 402 insufficient_credits", async () => {
    const k = await h.newKey();
    const r = await rerank({ model: SMALL, query: QUERY, documents: DOCS }, k.auth);
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("insufficient_credits");
  });

  test("a key's model allowlist applies", async () => {
    const owner = await h.fundedKey();
    const s = await (await h.request("/api/v1/sessions", { method: "POST", headers: owner.auth, json: { name: "llama-only", budget_usd: 1, allowed_models: [LLAMA] } })).json();
    const r = await rerank({ model: SMALL, query: QUERY, documents: DOCS }, { authorization: `Bearer ${s.data.key}` });
    expect(r.status).toBe(403);
  });
});

describe("no rerank provider", () => {
  test("an unknown model is 404 model_not_found", async () => {
    const r = await rerank({ model: "acme/nope", query: QUERY, documents: DOCS });
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("model_not_found");
  });

  test("a chat model is 404 model_not_found: it is not a rerank model", async () => {
    const r = await rerank({ model: LLAMA, query: QUERY, documents: DOCS });
    expect(r.status).toBe(404);
    const e = (await r.json()).error;
    expect(e.type).toBe("model_not_found");
    expect(e.message).toContain("not a rerank model");
  });

  test("a router with no rerank model says so, and never calls a provider", async () => {
    const bare = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.embed] }] });
    try {
      const k = await bare.fundedKey();
      for (const model of [LLAMA, "acme/embed-small", "acme/rerank-small"]) {
        const r = await bare.request("/api/v1/rerank", { method: "POST", headers: k.auth, json: { model, query: QUERY, documents: TEXTS } });
        expect(r.status).toBe(404);
        const e = (await r.json()).error;
        expect(e.type).toBe("model_not_found");
      }
      const e = (await (await bare.request("/api/v1/rerank", { method: "POST", headers: k.auth, json: { model: LLAMA, query: QUERY, documents: TEXTS } })).json()).error;
      expect(e.message).toContain("no rerank model is available");
      expect(bare.mocks.alpha.stats.requests).toBe(0);
      const listed = await (await bare.request("/api/v1/models?output_modalities=rerank")).json();
      expect(listed.data).toEqual([]);
    } finally {
      await bare.close();
    }
  });
});

describe("GET /api/v1/models", () => {
  test("?output_modalities=rerank lists the rerank models, with their pricing and routing variants", async () => {
    const j = await (await h.request("/api/v1/models?output_modalities=rerank")).json();
    expect(j.data.map((m: { id: string }) => m.id).sort()).toEqual([SMALL, SU]);
    const su = j.data.find((m: { id: string }) => m.id === SU);
    expect(su.architecture.output_modalities).toEqual(["rerank"]);
    expect(su.pricing.request).toBe("0.002");
    expect(su.routing_variants).toEqual(["nitro", "floor"]);
    const all = await (await h.request("/api/v1/models?output_modalities=all")).json();
    expect(all.data.length).toBeGreaterThan(j.data.length);
  });
});
