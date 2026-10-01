import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { sql } from "drizzle-orm";
import { MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { keys as keysTable } from "../src/db/schema.ts";
import { checkDatabaseColumns, columnsHoldingRequestData, type DatabaseColumn } from "../src/privacy/inventory.ts";

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

  test("privacy: only declared agreement evidence and jury reasons retain content", async () => {
    const r = await h.ctx.db.execute(sql`SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const cols = ((r as any).rows ?? r) as { table_name: string; column_name: string }[];
    // Hashes (…_sha256) and prices (price_…) are allowed; anything that could hold text is not.
    const bad = cols.filter((c) => /(^|_)(prompt|content|messages?|completion|output|response|input|answer|text|body)($|_)/.test(c.column_name) && !/_sha256$|^price_|^max_out$|^tokens_|_tokens$/.test(c.column_name));
    expect(bad.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual(["agreement_evidence.content"]);
    // The data inventory (src/privacy) goes further, on the database as the migrations built it: every column has an entry; every column
    // whose name or type suggests request content or a network address (prompt, content, messages, body, text, ip, address, user_agent,
    // jsonb, inet ...) carries a reviewed justification; agreement evidence and jury answer text are explicitly declared, with no caller network address column.
    expect(checkDatabaseColumns(cols as unknown as DatabaseColumn[])).toEqual([]);
    expect(columnsHoldingRequestData()).toEqual(["agreement_evidence.content", "agreement_jury.statement"]);
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

  test("empty-200 is a failure: falls back and is recorded as slash evidence", async () => {
    await reset();
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "empty200" }) });
    const k = await h.fundedKey(5n);
    for (const stream of [false, true]) {
      const r = await chat(h, k.auth, { stream, provider: { order: ["alpha", "beta"] } });
      expect(r.status).toBe(200);
      if (stream) {
        const s = await sse(r);
        expect(s.events.at(-1).receipt.payload.provider).toBe("beta");
      } else expect((await r.json()).provider).toBe("Beta");
    }
    expect(h.ctx.health.empty200Rate(LLAMA, "alpha").rate).toBe(1);
    await h.ctx.health.flush(h.ctx.db);
    const rows = await h.ctx.db.execute(sql`SELECT count(*)::int AS n FROM health WHERE provider_id = 'alpha' AND empty200`);
    expect(((rows as any).rows ?? rows)[0].n).toBeGreaterThanOrEqual(2);
  });

  test("after 2 hard failures a provider is in outage for 30s and skipped without being tried", async () => {
    await reset();
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
    const k = await h.fundedKey(5n);
    await chat(h, k.auth, { provider: { order: ["alpha", "beta"] } });
    await chat(h, k.auth, { provider: { order: ["alpha", "beta"] } });
    expect(h.ctx.health.outage(LLAMA, "alpha")).toBe(true);
    const before = (await (await fetch(h.mocks.alpha.url + "/_stats")).json()).requests;
    const j = await (await chat(h, k.auth, { provider: { order: ["alpha", "beta"] } })).json();
    const after = (await (await fetch(h.mocks.alpha.url + "/_stats")).json()).requests;
    expect(j.provider).toBe("Beta");
    expect(after).toBe(before);
  });

  test("all providers failing: 502, nothing charged, hold released", async () => {
    await reset();
    for (const m of Object.values(h.mocks)) await fetch(m.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
    const k = await h.fundedKey(2n);
    const [row] = await h.ctx.db.select().from(keysTable).where(sql`${keysTable.keyHash} = ${k.hash}`);
    const before = await balanceOf(h.ctx.db, row.accountId);
    const r = await chat(h, k.auth, {});
    expect(r.status).toBe(502);
    expect((await r.json()).error.metadata.attempts.length).toBeGreaterThan(0);
    const after = await balanceOf(h.ctx.db, row.accountId);
    expect(after.balance).toBe(before.balance);
    expect(after.held).toBe(0n);
    // Both providers are now in their 30s outage window, so the next request is refused up front.
    expect((await chat(h, k.auth, {})).status).toBe(404);
    // Streaming failure (fresh health) reports the error in-stream and also charges nothing.
    h.ctx.health = new (h.ctx.health.constructor as any)(h.ctx.cfg.routing.outageWindowMs);
    const s = await sse(await chat(h, k.auth, { stream: true }));
    expect(s.events.at(-1).error.code).toBe(502);
    expect((await balanceOf(h.ctx.db, row.accountId)).balance).toBe(before.balance);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("provider-side 400s surface the provider message when every provider rejects", async () => {
    await reset();
    for (const m of Object.values(h.mocks)) await fetch(m.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "reject400" }) });
    const k = await h.fundedKey(1n);
    const r = await chat(h, k.auth, {});
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("bad parameter foo");
  });

  test("mid-stream provider error is forwarded in-stream and partial output is billed", async () => {
    await reset();
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "midstream_error" }) });
    const k = await h.fundedKey(1n);
    const s = await sse(await chat(h, k.auth, { stream: true, provider: { only: ["alpha"] }, messages: [{ role: "user", content: "a fairly long question so the answer has several chunks" }] }));
    expect(s.events.some((e: any) => e.error?.type === "provider_error")).toBe(true);
    const final = s.events.at(-1);
    expect(final.receipt).toBeDefined();
    expect(final.usage.completion_tokens).toBeGreaterThan(0);
  });

  test("models[] fallback moves to the next model when the first has no working provider", async () => {
    await reset();
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
    const k = await h.fundedKey(2n);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: { models: ["qwen/qwen3-32b", LLAMA], route: "fallback", messages: [{ role: "user", content: "x" }] } });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.model).toBe(LLAMA); // qwen only lives on alpha, which is down
    expect(j.provider).toBe("Beta");
  });

  test("tools are only sent to providers that support them; tool_calls are not empty-200s", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    const r = await chat(h, k.auth, { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("lookup");
  });

  test("budgets: a key stops at its budget; rpm enforced", async () => {
    await reset();
    const k = await h.fundedKey(5n);
    const sub = await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { name: "capped", limit: 0.000004, rpm: 3 } })).json();
    const auth = { authorization: `Bearer ${sub.key}` };
    // Each call worst-case hold > $0.000004 with default max_tokens, so cap max_tokens small.
    const body = { max_tokens: 5, provider: { only: ["alpha"] } };
    const r1 = await chat(h, auth, body);
    expect(r1.status).toBe(200);
    let blocked = 0;
    for (let i = 0; i < 3; i++) {
      const r = await chat(h, auth, body);
      if (r.status === 402) {
        expect((await r.json()).error.type).toBe("key_budget_exceeded");
        blocked++;
      } else if (r.status === 429) {
        expect((await r.json()).error.type).toBe("rate_limited");
        blocked++;
      }
    }
    expect(blocked).toBeGreaterThan(0);
    // rpm: 4th request in the same minute is rate limited even for a fresh budget key.
    const fast = await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { name: "rpm", rpm: 2 } })).json();
    const fa = { authorization: `Bearer ${fast.key}` };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await chat(h, fa, { max_tokens: 5 })).status);
    expect(codes).toEqual([200, 200, 429]);
  });

  test("insufficient balance -> 402 with required/available", async () => {
    await reset();
    const k = await h.newKey();
    const r = await chat(h, k.auth, {});
    expect(r.status).toBe(402);
    expect((await r.json()).error.type).toBe("insufficient_credits");
  });

  test("allowed_models and viewer role", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    const sub = await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { allowed_models: ["qwen/qwen3-32b"] } })).json();
    expect((await chat(h, { authorization: `Bearer ${sub.key}` }, {})).status).toBe(403);
    const team = await (await h.request("/api/v1/teams", { method: "POST", headers: k.auth, json: { name: "eng" } })).json();
    const viewer = await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { team: team.data.id } })).json();
    await h.request(`/api/v1/teams/${team.data.id}/members/${viewer.data.hash}`, { method: "PUT", headers: k.auth, json: { role: "viewer" } });
    expect((await chat(h, { authorization: `Bearer ${viewer.key}` }, {})).status).toBe(403);
  });

  test("BYOK: provider called with the caller's key; upstream not charged", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    expect((await h.request("/api/v1/byok", { method: "POST", headers: k.auth, json: { provider: "beta", key: "my-own-beta-key" } })).status).toBe(201);
    const j = await (await chat(h, k.auth, { provider: { only: ["beta"] } })).json();
    const stats = await (await fetch(h.mocks.beta.url + "/_stats")).json();
    expect(stats.lastAuth).toBe("Bearer my-own-beta-key");
    expect(j.usage.is_byok).toBe(true);
    expect(j.usage.cost_details.upstream_inference_cost).toBe(0);
  });

  test("opt-in exact cache: second identical call is a free hit with its own receipt", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    const body = { cache: { mode: "exact" }, temperature: 0, messages: [{ role: "user", content: "cache me" }] };
    const a = await (await chat(h, k.auth, body)).json();
    const r = await chat(h, k.auth, body);
    const b = await r.json();
    expect(r.headers.get("x-anyroute-cache")).toBe("hit");
    expect(b.cached).toBe(true);
    expect(b.usage.cost).toBe(0);
    expect(b.choices[0].message.content).toBe(a.choices[0].message.content);
    expect(b.receipt.payload.mode).toBe("cache");
    // Never shared across accounts.
    const other = await h.fundedKey(1n);
    const c = await chat(h, other.auth, body);
    expect(c.headers.get("x-anyroute-cache")).toBeNull();
  });

  test("cache TTL accepts shorter values and rejects malformed or over-limit values", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    const body = { cache: { mode: "exact", ttl: 60 }, temperature: 0, messages: [{ role: "user", content: "short cache ttl" }] };
    expect(h.ctx.cfg.gateway.cacheTtlS).toBeGreaterThan(60);
    expect((await chat(h, k.auth, body)).status).toBe(200);
    const hit = await chat(h, k.auth, body);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-anyroute-cache")).toBe("hit");

    for (const ttl of [null, -1, 0, 1.5, "60", "NaN", h.ctx.cfg.gateway.cacheTtlS + 1]) {
      const rejected = await chat(h, k.auth, { cache: { mode: "exact", ttl }, messages: [{ role: "user", content: `invalid ttl ${String(ttl)}` }] });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error.type).toBe("invalid_request");
    }
  });

  test("guardrails (per key): redaction reaches the provider redacted", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { guardrails: { pii: "redact" } } });
    await chat(h, k.auth, { provider: { only: ["alpha"] }, messages: [{ role: "user", content: "email me: me@corp.com" }] });
    const stats = await (await fetch(h.mocks.alpha.url + "/_stats")).json();
    expect(stats.lastBody.messages[0].content).toBe("email me: [REDACTED_EMAIL]");
  });

  test("request guardrails can tighten but cannot clear key guardrails", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { guardrails: { pii: "block", deny_patterns: ["key-restricted"], max_input_chars: 100 } } });
    const denied = await chat(h, k.auth, { guardrails: {}, messages: [{ role: "user", content: "contains key-restricted phrase" }] });
    expect(denied.status).toBe(400);
    expect((await denied.json()).error.metadata.guardrail).toBe("deny_patterns");
    const pii = await chat(h, k.auth, { guardrails: { pii: "redact" }, messages: [{ role: "user", content: "contact person@example.test" }] });
    expect(pii.status).toBe(400);
    expect((await pii.json()).error.metadata.guardrail).toBe("pii");
    const stricter = await chat(h, k.auth, { guardrails: { max_input_chars: 4 }, messages: [{ role: "user", content: "12345" }] });
    expect(stricter.status).toBe(400);
    expect((await stricter.json()).error.metadata.guardrail).toBe("max_input_chars");
  });

  test("key output redaction remains enabled when request guardrails are empty", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { guardrails: { redact_output: true } } });
    const r = await chat(h, k.auth, { guardrails: {}, provider: { only: ["alpha"] }, messages: [{ role: "user", content: "include person@example.test" }] });
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toContain("[REDACTED_EMAIL]");
  });

  test("combined deny pattern overflow is rejected instead of ignoring request rules", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    const keyPatterns = Array.from({ length: 50 }, (_, i) => `key-rule-${i}`);
    await h.request(`/api/v1/keys/${k.hash}`, { method: "PATCH", headers: k.auth, json: { guardrails: { deny_patterns: keyPatterns } } });
    const response = await chat(h, k.auth, { guardrails: { deny_patterns: ["request-only-rule"] }, messages: [{ role: "user", content: "ordinary prompt" }] });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/Combined key and request deny_patterns cannot exceed 50 unique entries/);
  });

  test("OpenRouter provider/model fields never leak upstream", async () => {
    await reset();
    const k = await h.fundedKey(1n);
    await chat(h, k.auth, { provider: { only: ["alpha"] }, transforms: ["middle-out"], usage: { include: true }, models: [LLAMA] });
    const stats = await (await fetch(h.mocks.alpha.url + "/_stats")).json();
    expect(stats.lastBody.model).toBe("llama-3.3-70b"); // provider's own model id
    for (const f of ["provider", "models", "transforms", "usage", "route"]) expect(stats.lastBody).not.toHaveProperty(f);
    expect(stats.lastAuth).toBe("Bearer upstream-key-alpha");
  });

  test("ledger invariants hold after everything above", async () => {
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
});

describe("limits and log privacy", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter({ env: { LOG_LEVEL: "debug" } })));
  afterAll(async () => h.close());

  test("tpm: prompt tokens per minute are enforced per key", async () => {
    const k = await h.fundedKey(1n);
    const sub = await (await h.request("/api/v1/keys", { method: "POST", headers: k.auth, json: { tpm: 60 } })).json();
    const auth = { authorization: `Bearer ${sub.key}` };
    const big = "word ".repeat(60); // ~100 estimated tokens
    expect((await chat(h, auth, { max_tokens: 5, messages: [{ role: "user", content: "small" }] })).status).toBe(200);
    const r = await chat(h, auth, { max_tokens: 5, messages: [{ role: "user", content: big }] });
    expect(r.status).toBe(429);
    expect((await r.json()).error.message).toContain("tokens/min");
  });

  test("logs never contain prompts, completions or keys, even at debug level (also on failures)", async () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const k = await h.fundedKey(1n);
      const secretPrompt = "TOP-SECRET-PROMPT-7f3a";
      await chat(h, k.auth, { messages: [{ role: "user", content: secretPrompt }] });
      await chat(h, k.auth, { stream: true, messages: [{ role: "user", content: secretPrompt }] });
      for (const m of Object.values(h.mocks)) await fetch(m.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "error500" }) });
      await chat(h, k.auth, { messages: [{ role: "user", content: secretPrompt }] });
      const joined = lines.join("\n");
      expect(joined).not.toContain(secretPrompt);
      expect(joined).not.toContain("Hello from"); // mock completions
      expect(joined).not.toContain(k.secret);
    } finally {
      Object.assign(console, orig);
    }
  });

  test("tRPC paywith.open returns the wallet's unsigned transactions", async () => {
    const k = await h.fundedKey(1n);
    const r = await (await h.request("/trpc/paywith.open", { method: "POST", headers: { ...k.auth, "content-type": "application/json" }, body: JSON.stringify({ token: "NVDA", capRawPerDay: "1000", wallet: "0x0000000000000000000000000000000000001111" }) })).json();
    expect(r.result.data.transactions.length).toBe(2);
  });
});

describe("retries", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter({ providers: [{ id: "solo", name: "Solo", models: [MODELS.llama] }] })));
  afterAll(async () => h.close());

  test("a single provider that 429s once is retried after a short backoff; timeouts are not retried", async () => {
    const k = await h.fundedKey(1n);
    // Fail exactly one request, then recover.
    await fetch(h.mocks.solo.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "rate429" }) });
    setTimeout(() => void fetch(h.mocks.solo.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "ok" }) }), 100);
    const r = await chat(h, k.auth, {});
    expect(r.status).toBe(200);
    const g = await (await h.request(`/api/v1/generation?id=${(await r.json()).id}`, { headers: k.auth })).json();
    expect(g.data.attempts.map((a: any) => [a.provider, a.error_kind ?? "ok"])).toEqual([["solo", "rate_limited"], ["solo", "ok"]]);
  });
});

describe("empty-200 abuse resistance", () => {
  let h: Harness;
  beforeAll(async () => (h = await startRouter()));
  afterAll(async () => h.close());
  test("one caller provoking empty answers cannot put a provider into outage for everyone", async () => {
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ behaviour: "empty200" }) });
    const attacker = await h.fundedKey(1n);
    for (let i = 0; i < 4; i++) await chat(h, attacker.auth, { provider: { order: ["alpha", "beta"] } });
    expect(h.ctx.health.outage(LLAMA, "alpha")).toBe(false);
    const victim = await h.fundedKey(1n);
    await chat(h, victim.auth, { provider: { order: ["alpha", "beta"] } });
    expect(h.ctx.health.outage(LLAMA, "alpha")).toBe(true); // two independent callers: real outage
  });
  test("an empty answer that ends on the caller's stop sequence is a valid answer", async () => {
    h.ctx.health = new (h.ctx.health.constructor as any)(h.ctx.cfg.routing.outageWindowMs);
    const k = await h.fundedKey(1n);
    const r = await chat(h, k.auth, { stop: ["Hello"], provider: { only: ["alpha"] } });
    expect(r.status).toBe(200);
  });
});
