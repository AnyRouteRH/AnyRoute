import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { sql } from "drizzle-orm";
import { MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { keys as keysTable } from "../src/db/schema.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const chat = (h: Harness, auth: Record<string, string>, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
  h.request("/api/v1/chat/completions", { method: "POST", headers: { ...auth, ...extraHeaders }, json: { model: LLAMA, messages: [{ role: "user", content: "hello" }], ...body } });

describe("API parity (OpenRouter shapes)", () => {
  let h: Harness;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    h = await startRouter();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: h.app.fetch, idleTimeout: 60 });
  });
  afterAll(async () => {
    server.stop(true);
    await h.close();
  });

  test("GET /models lists models with OpenRouter fields", async () => {
    const j = await (await h.request("/api/v1/models")).json();
    const m = j.data.find((x: any) => x.id === LLAMA);
    expect(m).toBeDefined();
    for (const k of ["id", "name", "created", "context_length", "architecture", "pricing", "top_provider", "supported_parameters", "data_policy", "quantization", "attested_available", "creator", "royalty_bps"]) expect(m).toHaveProperty(k);
    expect(m.pricing.prompt).toBe(MODELS.llama.prompt); // cheapest provider's price
    expect(typeof m.pricing.completion).toBe("string");
    const tools = await (await h.request("/api/v1/models?supported_parameters=tools")).json();
    expect(tools.data.length).toBeGreaterThan(0);
  });

  test("GET /models/:author/:slug/endpoints lists every provider", async () => {
    const j = await (await h.request(`/api/v1/models/${LLAMA}/endpoints`)).json();
    expect(j.data.endpoints.map((e: any) => e.provider_slug).sort()).toEqual(["alpha", "beta"]);
    expect(j.data.endpoints[0]).toHaveProperty("uptime_last_30d");
    expect(j.data.endpoints[0]).toHaveProperty("bond_usdg");
  });

  test("official OpenAI SDK works unchanged (base URL + key), incl. streaming and OpenRouter extras", async () => {
    const k = await h.fundedKey(5n);
    const client = new OpenAI({ apiKey: k.secret, baseURL: `http://127.0.0.1:${server.port}/api/v1` });
    const r = await client.chat.completions.create({
      model: LLAMA,
      messages: [{ role: "user", content: "What is 17 * 23? Reply with only the number." }],
      // OpenRouter extensions pass through the SDK untouched:
      // @ts-expect-error provider prefs are an OpenRouter extension
      provider: { sort: "price", data_collection: "deny" },
    });
    expect(r.choices[0].message.content).toBe("391");
    expect((r as any).provider).toBe("Alpha");
    expect((r.usage as any).cost).toBeGreaterThan(0);
    expect((r as any).receipt.sig).toBeTruthy();
    const stream = await client.chat.completions.create({ model: LLAMA + ":floor", messages: [{ role: "user", content: "stream please" }], stream: true });
    let text = "";
    let usage: any = null;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toContain("stream please");
    expect(usage.cost).toBeGreaterThan(0);
    const models = await client.models.list();
    expect(models.data.some((m) => m.id === LLAMA)).toBe(true);
    const emb = await client.embeddings.create({ model: "acme/embed-small", input: ["a", "bb"] });
    expect(emb.data.length).toBe(2);
  });

  test("non-stream response: usage, cost_details, provider, receipt; /generation returns the row", async () => {
    const k = await h.fundedKey(5n);
    const r = await chat(h, k.auth, { usage: { include: true } }, { "http-referer": "https://example.app", "x-title": "Example" });
    expect(r.status).toBe(200);
    const j = await r.json();
    const cost = j.usage.cost; // (bun's toMatchObject writes matchers back into the object)
    const receipt = structuredClone(j.receipt);
    expect(j.object).toBe("chat.completion");
    expect(j.model).toBe(LLAMA);
    expect(j.usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number), total_tokens: expect.any(Number), cost: expect.any(Number) });
    expect(j.usage.cost_details).toHaveProperty("upstream_inference_cost");
    expect(j.usage.cost_details).toHaveProperty("royalty");
    expect(j.usage.prompt_tokens_details).toHaveProperty("cached_tokens");
    expect(j.usage.completion_tokens_details).toHaveProperty("reasoning_tokens");
    expect(j.receipt).toMatchObject({ id: j.id, sig: expect.any(String), key_id: expect.any(String), anchor_hint: expect.any(String) });
    const g = await (await h.request(`/api/v1/generation?id=${j.id}`, { headers: k.auth })).json();
    for (const f of ["id", "model", "provider_name", "generation_time", "latency", "native_tokens_prompt", "native_tokens_completion", "total_cost", "upstream_inference_cost", "royalty", "cache_discount", "finish_reason", "native_finish_reason", "streamed", "cancelled", "quantization", "data_region", "is_byok", "private", "attestation_hash", "receipt_sig", "paid_with", "anchor"]) expect(g.data).toHaveProperty(f);
    expect(g.data.total_cost).toBe(cost);
    // Other keys can't read it.
    const other = await h.fundedKey(1n);
    expect((await h.request(`/api/v1/generation?id=${j.id}`, { headers: other.auth })).status).toBe(404);
    // Receipt verifies through the public endpoint.
    const v = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id } })).json();
    expect(v.data.signature_valid).toBe(true);
    const tampered = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: { ...receipt.payload, cost: "0" }, sig: receipt.sig, key_id: receipt.key_id } })).json();
    expect(tampered.data.signature_valid).toBe(false);
  });

  test("streaming: SSE chunks, keep-alive comment, final usage+receipt chunk, [DONE]", async () => {
    const k = await h.fundedKey(5n);
    const r = await chat(h, k.auth, { stream: true });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const s = await sse(r);
    expect(s.raw.startsWith(": ANYROUTE PROCESSING")).toBe(true);
    expect(s.done).toBe(true);
    const last = s.events.at(-1);
    expect(last.usage.cost).toBeGreaterThan(0);
    expect(last.receipt.sig).toBeTruthy();
    expect(s.events.every((e: any) => e.id === last.id && e.model === LLAMA)).toBe(true);
    const text = s.events.map((e: any) => e.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toContain("hello");
  });

  test("dev faucet is off unless configured for a local chain", async () => {
    expect((await (await h.request("/api/v1/status")).json()).data.dev_faucet).toBe(false);
    const k = await h.fundedKey(1n);
    const r = await h.request("/api/v1/dev/faucet", { method: "POST", headers: k.auth, json: { amount: "10" } });
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("not_found");
  });

  test("legacy /completions works", async () => {
    const k = await h.fundedKey(1n);
    const r = await h.request("/api/v1/completions", { method: "POST", headers: k.auth, json: { model: LLAMA, prompt: "Once upon" } });
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].text).toContain("Once upon");
  });

  test("validation errors are OpenRouter-shaped", async () => {
    const k = await h.fundedKey(1n);
    const r = await chat(h, k.auth, { messages: [] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ code: 400, message: expect.any(String) });
    expect((await chat(h, k.auth, { model: "nope/nope" })).status).toBe(404);
    expect((await chat(h, { authorization: "Bearer sk-ar-v1-" + "0".repeat(64) }, {})).status).toBe(401);
  });

  test("privacy: no prompt/output columns anywhere in the schema", async () => {
    const r = await h.ctx.db.execute(sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const cols = ((r as any).rows ?? r) as { table_name: string; column_name: string }[];
    // Hashes (…_sha256) and prices (price_…) are allowed; anything that could hold text is not.
    const bad = cols.filter((c) => /(^|_)(prompt|content|messages?|completion|output|response|input|answer|text|body)($|_)/.test(c.column_name) && !/_sha256$|^price_|^max_out$|^tokens_|_tokens$/.test(c.column_name));
    expect(bad.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
  });
});

describe("routing behaviour (fallback, empty-200, failures, budgets)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ rand: () => 0.5 });
  });
  afterAll(async () => h.close());
  const reset = async () => {
    for (const m of Object.values(h.mocks)) await fetch(m.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "ok", delayMs: 0 }) });
    h.ctx.health = new (h.ctx.health.constructor as any)(h.ctx.cfg.routing.outageWindowMs);
  };

  test("5xx on the preferred provider falls back; attempts recorded; only the winner is billed", async () => {
    await reset();
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
    const k = await h.fundedKey(5n);
    const r = await chat(h, k.auth, { provider: { order: ["alpha", "beta"] } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.provider).toBe("Beta");
    const g = await (await h.request(`/api/v1/generation?id=${j.id}`, { headers: k.auth })).json();
    expect(g.data.attempts.map((a: any) => [a.provider, a.ok])).toEqual([["alpha", false], ["beta", true]]);
    expect(g.data.provider_name).toBe("beta");
  });
});
