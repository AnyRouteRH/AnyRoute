import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { accounts, batchLines, batches, generations, keys } from "../src/db/schema.ts";
import { balanceOf, verifyInvariants } from "../src/ledger/ledger.ts";
import { batchPrice, batchHold } from "../src/router/pricing.ts";
import { batchStore } from "../src/services/batches.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { usdToPico } from "../src/lib/money.ts";

// The Batch API: OpenAI-shaped batches of chat or embeddings lines, run by the worker at BATCH_DISCOUNT_BPS off, each line
// through the normal handler (lanes, budgets, key limits, holds, receipts), results kept sealed for BATCH_RESULTS_TTL.

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const USAGE = { prompt_tokens: 1000, completion_tokens: 500 };
// 1000 x 0.0000001 + 500 x 0.00000032 on the cheaper provider, prepaid (no margin, no royalty).
const LIST = usdToPico("0.00026");

const chatLine = (custom_id: string, extra: Record<string, unknown> = {}) => ({ custom_id, method: "POST", url: "/v1/chat/completions", body: { model: LLAMA, messages: [{ role: "user", content: `hello ${custom_id}` }], ...extra } });
const jsonl = (text: string) => text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("batch pricing", () => {
  test("a batch line costs the list price less the discount, rounded in the caller's favour, and its hold still covers it", () => {
    const cost = { upstream: 1001n, notional: 1001n, royalty: 0n, margin: 0n, cacheDiscount: 0n, holderDiscount: 0n, total: 1001n };
    expect(batchPrice(cost, 5000)).toMatchObject({ total: 500n, batchDiscount: 501n, upstream: 1001n });
    expect(batchPrice(cost, 0).total).toBe(1001n);
    expect(batchPrice(cost, 10_000).total).toBe(0n);
    expect(batchPrice(cost, 20_000).total).toBe(0n); // never negative
    expect(batchHold(1001n, 5000)).toBe(501n);
    expect(batchHold(1001n, 5000)).toBeGreaterThanOrEqual(batchPrice(cost, 5000).total);
  });
});

describe("Batch API over HTTP", () => {
  let h: Harness;
  let k: Awaited<ReturnType<Harness["fundedKey"]>>;
  const submit = (json: Record<string, unknown>, auth = k.auth) => h.request("/api/v1/batches", { method: "POST", headers: auth, json });
  const get = async (id: string, auth = k.auth) => (await h.request(`/api/v1/batches/${id}`, { headers: auth })).json();
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      const r = (await h.ctx.jobs.run("batches")) as { ran?: number };
      if (!r?.ran) return;
    }
  };
  const available = async () => (await balanceOf(h.ctx.db, (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash)))[0].accountId)).available;

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.embed], usage: USAGE },
        { id: "beta", name: "Beta", models: [MODELS.llamaPricey], usage: USAGE },
      ],
      env: { BATCH_MAX_LINES: "6", BATCH_MAX_BYTES: "20000", BATCH_MAX_ACTIVE: "2", BATCH_LINE_MAX_ATTEMPTS: "1" },
      rand: () => 0,
    });
    k = await h.fundedKey(10n);
  });
  afterAll(async () => {
    await h.close();
  });

  test("validation: the key is required, the lines are checked before anything is queued, and the limits hold", async () => {
    expect((await h.request("/api/v1/batches", { method: "POST", json: { requests: [chatLine("a")] } })).status).toBe(401);
    const cases: [Record<string, unknown>, number, string][] = [
      [{}, 400, "requests"],
      [{ input_file_id: "file-abc", endpoint: "/v1/chat/completions", completion_window: "24h" }, 400, "no files endpoint"],
      [{ requests: [chatLine("a")], completion_window: "1h" }, 400, "24h"],
      [{ requests: [chatLine("a")], endpoint: "/v1/images" }, 400, "endpoint"],
      [{ requests: Array.from({ length: 7 }, (_, i) => chatLine(`r${i}`)) }, 413, "at most 6 lines"],
      [{ requests: [chatLine("a", { messages: [{ role: "user", content: "x".repeat(30_000) }] })] }, 413, "bytes"],
    ];
    for (const [json, status, text] of cases) {
      const r = await submit(json);
      expect(r.status, JSON.stringify(json).slice(0, 80)).toBe(status);
      expect((await r.json()).error.message).toContain(text);
    }
    const bad = await submit({
      requests: [
        chatLine("dup"),
        chatLine("dup"),
        { ...chatLine("s", { stream: true }) },
        { custom_id: "u", method: "POST", url: "/v1/responses", body: { model: LLAMA } },
        { custom_id: "g", method: "GET", url: "/v1/chat/completions", body: { model: LLAMA, messages: [] } },
        { custom_id: "e", url: "/v1/embeddings", body: { model: MODELS.embed.slug, input: "x" } },
      ],
    });
    expect(bad.status).toBe(400);
    const errors = (await bad.json()).error.metadata.errors as { line: number; code: string }[];
    expect(errors.map((e) => [e.line, e.code])).toEqual([[2, "duplicate_custom_id"], [3, "invalid_body"], [4, "invalid_url"], [5, "invalid_method"], [6, "mismatched_url"]]);
    const badJsonl = await submit({ input_jsonl: `${JSON.stringify(chatLine("a"))}\nnot json\n` });
    expect((await badJsonl.json()).error.metadata.errors).toEqual([{ line: 2, code: "invalid_json_line", message: "This line is not valid JSON." }]);
    expect(await h.ctx.db.select().from(batches)).toEqual([]); // nothing was queued
  });

  test("a batch runs at half price: per-line receipts, the ledger charged exactly the discounted sum, OpenAI output JSONL", async () => {
    const direct = await h.request("/api/v1/chat/completions", { method: "POST", headers: k.auth, json: chatLine("direct").body });
    expect(direct.status).toBe(200);
    const directCost = usdToPico(String((await direct.json()).receipt.payload.cost));
    expect(directCost).toBe(LIST);

    const before = await available();
    const r = await submit({ input_jsonl: [chatLine("one"), chatLine("two"), chatLine("three")].map((l) => JSON.stringify(l)).join("\n"), endpoint: "/v1/chat/completions", completion_window: "24h" });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ object: "batch", endpoint: "/v1/chat/completions", status: "validating", completion_window: "24h", input_file_id: null, request_counts: { total: 3, completed: 0, failed: 0 }, cost: { usd: 0, discount_bps: 5000 } });
    expect(b.id).toMatch(/^batch_[0-9a-f]{24}$/);
    // The lines are sealed outside Postgres: no row holds their text.
    const dump = JSON.stringify(await h.ctx.db.select().from(batchLines).where(eq(batchLines.batchId, b.id)), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump).not.toContain("hello one");

    await drain();
    const done = await get(b.id);
    expect(done).toMatchObject({ status: "completed", request_counts: { total: 3, completed: 3, failed: 0 } });
    expect(done.completed_at).toBeGreaterThan(0);
    expect(done.results_expire_at - done.completed_at).toBe(86_400);
    const half = batchPrice({ upstream: LIST, notional: LIST, royalty: 0n, margin: 0n, cacheDiscount: 0n, holderDiscount: 0n, total: LIST }, 5000).total;
    expect(half * 2n).toBe(LIST);
    expect(usdToPico(String(done.cost.usd))).toBe(half * 3n);
    expect(usdToPico(String(done.cost.list_usd))).toBe(LIST * 3n);
    expect(before - (await available())).toBe(half * 3n); // the ledger took exactly the discounted price
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);

    const out = await h.request(`/api/v1/batches/${b.id}/output`, { headers: k.auth });
    expect(out.headers.get("content-type")).toContain("application/jsonl");
    const lines = jsonl(await out.text());
    expect(lines.map((l) => l.custom_id)).toEqual(["one", "two", "three"]);
    for (const [i, l] of lines.entries()) {
      expect(Object.keys(l).sort()).toEqual(["custom_id", "error", "id", "response"]);
      expect(l.id).toBe(`batch_req_${b.id.slice(6)}_${i}`);
      expect(l.error).toBeNull();
      expect(l.response.status_code).toBe(200);
      expect(l.response.request_id).toBe(l.response.body.id);
      expect(l.response.body.object).toBe("chat.completion");
      expect(l.response.body.usage).toMatchObject({ cost: 0.00013, cost_details: { batch_discount: 0.00013 } });
      expect(l.response.body.receipt.payload).toMatchObject({ batch: { id: b.id, line: i }, cost: "0.00013", cost_details: { batch_discount: "0.00013" } });
    }
    // One generation row, with its own signed receipt, per line.
    const gens = await h.ctx.db.select().from(generations).where(inArray(generations.id, lines.map((l) => l.response.request_id)));
    expect(gens.length).toBe(3);
    for (const g of gens) {
      expect(g.cost).toBe(half);
      expect(g.receiptSig).toBeTruthy();
    }
    expect(jsonl(await (await h.request(`/api/v1/batches/${b.id}/errors`, { headers: k.auth })).text())).toEqual([]);
    // The /v1 alias and the list both show it; another key cannot see it.
    expect((await (await h.request(`/v1/batches/${b.id}`, { headers: k.auth })).json()).id).toBe(b.id);
    const list = await (await h.request("/api/v1/batches?limit=10", { headers: k.auth })).json();
    expect(list).toMatchObject({ object: "list", first_id: b.id, has_more: false });
    const other = await h.fundedKey(1n);
    expect((await h.request(`/api/v1/batches/${b.id}`, { headers: other.auth })).status).toBe(404);
    expect((await h.request(`/api/v1/batches/${b.id}/output`, { headers: other.auth })).status).toBe(404);
  });

  test("embeddings batches get the same discount", async () => {
    const r = await submit({ requests: [{ custom_id: "v1", method: "POST", url: "/v1/embeddings", body: { model: MODELS.embed.slug, input: "vector me" } }] });
    const b = await r.json();
    await drain();
    const [line] = jsonl(await (await h.request(`/api/v1/batches/${b.id}/output`, { headers: k.auth })).text());
    expect(line.response.status_code).toBe(200);
    expect(line.response.body.data.length).toBeGreaterThan(0);
    const p = line.response.body.receipt.payload;
    expect(p.batch).toEqual({ id: b.id, line: 0 });
    expect(usdToPico(p.cost) + usdToPico(p.cost_details.batch_discount)).toBeGreaterThan(usdToPico(p.cost));
  });

  test("partial failures: failed lines are not charged and land in the errors JSONL with their code", async () => {
    const before = await available();
    const r = await submit({ requests: [chatLine("ok"), chatLine("missing", { model: "nobody/no-such-model" }), chatLine("unlinkable", { provider: { lane: "unlinkable" } })] });
    const b = await r.json();
    await drain();
    const done = await get(b.id);
    expect(done).toMatchObject({ status: "completed", request_counts: { total: 3, completed: 1, failed: 2 } });
    const half = LIST / 2n;
    expect(usdToPico(String(done.cost.usd))).toBe(half);
    expect(before - (await available())).toBe(half);
    const errs = jsonl(await (await h.request(`/api/v1/batches/${b.id}/errors`, { headers: k.auth })).text());
    expect(errs.map((e) => e.custom_id)).toEqual(["missing", "unlinkable"]);
    expect(errs[0]).toMatchObject({ response: { status_code: 404, request_id: null }, error: { code: "model_not_found" } });
    expect(errs[1].response.status_code).toBeGreaterThanOrEqual(400);
    expect(errs[1].response.request_id).toBeNull();
    const rows = await h.ctx.db.select().from(batchLines).where(eq(batchLines.batchId, b.id));
    expect(rows.filter((l) => l.status === "failed").every((l) => l.cost === 0n && l.generationId === null)).toBe(true);
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });

  test("the key's budget applies to every line: over budget, the line fails unbilled", async () => {
    const kb = await h.fundedKey(1n);
    await h.ctx.db.update(keys).set({ budget: 1n }).where(eq(keys.keyHash, kb.hash)); // one pico: no line fits
    const b = await (await submit({ requests: [chatLine("b1")] }, kb.auth)).json();
    await drain();
    const [e] = jsonl(await (await h.request(`/api/v1/batches/${b.id}/errors`, { headers: kb.auth })).text());
    expect(e.error.code).toBe("key_budget_exceeded");
    expect((await get(b.id, kb.auth)).cost.usd).toBe(0);
  });

  test("a rate-limited line waits in the queue instead of failing", async () => {
    const kr = await h.fundedKey(1n);
    await h.ctx.db.update(keys).set({ rpm: 1 }).where(eq(keys.keyHash, kr.hash));
    const b = await (await submit({ requests: [chatLine("r1"), chatLine("r2")] }, kr.auth)).json();
    await h.ctx.jobs.run("batches");
    const rows = await h.ctx.db.select().from(batchLines).where(eq(batchLines.batchId, b.id)).orderBy(batchLines.idx);
    // Lines run concurrently, so either one may take the single request the key's rate limit allows.
    expect(rows.map((l) => l.status).sort()).toEqual(["queued", "succeeded"]);
    const waiting = rows.find((l) => l.status === "queued")!;
    expect(waiting.attempts).toBe(0);
    expect(waiting.notBefore.getTime()).toBeGreaterThan(Date.now());
    expect((await get(b.id, kr.auth)).status).toBe("in_progress");
    await h.ctx.db.update(batchLines).set({ notBefore: new Date(0) }).where(eq(batchLines.batchId, b.id));
    await h.ctx.db.update(keys).set({ rpm: 1000 }).where(eq(keys.keyHash, kr.hash));
    await drain();
    expect((await get(b.id, kr.auth)).request_counts).toEqual({ total: 2, completed: 2, failed: 0 });
  });

  test("cancel: queued lines never run and are never billed; a cancelled batch frees its slot", async () => {
    const calls = h.mocks.alpha.stats.requests;
    const before = await available();
    const b = await (await submit({ requests: [chatLine("c1"), chatLine("c2"), chatLine("c3")] })).json();
    const c = await h.request(`/api/v1/batches/${b.id}/cancel`, { method: "POST", headers: k.auth });
    expect(c.status).toBe(200);
    const cancelled = await c.json();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelling_at).toBeGreaterThan(0);
    expect(cancelled.cancelled_at).toBeGreaterThan(0);
    await drain();
    expect(h.mocks.alpha.stats.requests).toBe(calls);
    expect(await available()).toBe(before);
    const errs = jsonl(await (await h.request(`/api/v1/batches/${b.id}/errors`, { headers: k.auth })).text());
    expect(errs.map((e) => [e.custom_id, e.error.code, e.response])).toEqual([["c1", "batch_cancelled", null], ["c2", "batch_cancelled", null], ["c3", "batch_cancelled", null]]);
    // Cancelling again is a no-op.
    expect((await (await h.request(`/api/v1/batches/${b.id}/cancel`, { method: "POST", headers: k.auth })).json()).status).toBe("cancelled");
  });

  test("per-key concurrency: at most BATCH_MAX_ACTIVE unfinished batches", async () => {
    const kc = await h.fundedKey(1n);
    for (let i = 0; i < 2; i++) expect((await submit({ requests: [chatLine(`a${i}`)] }, kc.auth)).status).toBe(200);
    const third = await submit({ requests: [chatLine("a3")] }, kc.auth);
    expect(third.status).toBe(429);
    expect((await third.json()).error.type).toBe("batch_limit");
    await drain();
    expect((await submit({ requests: [chatLine("a4")] }, kc.auth)).status).toBe(200);
    await drain();
  });

  test("expiry: lines left when the 24h window closes expire unbilled; results are deleted after BATCH_RESULTS_TTL", async () => {
    const before = await available();
    const b = await (await submit({ requests: [chatLine("x1"), chatLine("x2")] })).json();
    await h.ctx.db.update(batches).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(batches.id, b.id));
    await drain();
    const expired = await get(b.id);
    expect(expired).toMatchObject({ status: "expired", request_counts: { total: 2, completed: 0, failed: 0 } });
    expect(expired.expired_at).toBeGreaterThan(0);
    expect(await available()).toBe(before);
    expect(jsonl(await (await h.request(`/api/v1/batches/${b.id}/errors`, { headers: k.auth })).text()).map((e) => e.error.code)).toEqual(["batch_expired", "batch_expired"]);

    // Past its results time-to-live the sealed answers and the line rows go; the batch row keeps its totals.
    const [done] = await h.ctx.db.select().from(batches).where(sql`${batches.status} = 'completed'`).limit(1);
    await h.ctx.db.update(batches).set({ resultsExpireAt: new Date(Date.now() - 1000) }).where(inArray(batches.id, [done.id, b.id]));
    await h.ctx.jobs.run("batches");
    for (const id of [done.id, b.id]) {
      const out = await h.request(`/api/v1/batches/${id}/output`, { headers: k.auth });
      expect(out.status).toBe(410);
      expect((await out.json()).error.type).toBe("batch_results_expired");
      expect(await h.ctx.db.select().from(batchLines).where(eq(batchLines.batchId, id))).toEqual([]);
      const [row] = await h.ctx.db.select().from(batches).where(eq(batches.id, id));
      expect(row.purgedAt).not.toBeNull();
      expect((await batchStore(h.ctx).results(row)).size).toBe(0);
    }
    expect((await get(done.id)).request_counts.total).toBeGreaterThan(0);
  });

  test("a network request cannot pose as a batch line: the marker only exists in process", async () => {
    const r = await h.request("/api/v1/chat/completions", { method: "POST", json: chatLine("x").body });
    expect(r.status).not.toBe(200); // no key, no payment: the normal 402, never a batch-priced call
    const [acct] = await h.ctx.db.select().from(accounts).limit(1);
    expect(acct).toBeTruthy();
  });
});

describe("batch lines respect lanes", () => {
  let h: Harness;
  let k: Awaited<ReturnType<Harness["fundedKey"]>>;
  const claim = { source: "https://provider.example/terms", as_of: "2025-01-15" };

  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "vendor", name: "Vendor", models: [MODELS.llama] },
        { id: "enclave", name: "Enclave", models: [MODELS.llamaPricey], tee: "dev" },
      ],
      env: { BATCH_LINE_MAX_ATTEMPTS: "1" },
    });
    k = await h.fundedKey(10n);
  });
  afterAll(async () => {
    await h.close();
  });

  test("an attested-lane line reaches only the attested enclave, and is refused unbilled when none is attested", async () => {
    const lines = [chatLine("att", { provider: { lane: "attested" } }), chatLine("pub")];
    const first = await (await h.request("/api/v1/batches", { method: "POST", headers: k.auth, json: { requests: lines } })).json();
    for (let i = 0; i < 5; i++) await h.ctx.jobs.run("batches");
    const [refused] = jsonl(await (await h.request(`/api/v1/batches/${first.id}/errors`, { headers: k.auth })).text());
    expect(refused).toMatchObject({ custom_id: "att", response: { status_code: 503 }, error: { code: "no_attested_endpoint" } });

    expect((await h.request("/api/v1/disclosure/enclave", { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } })).status).toBe(200);
    await runAttestor(h.ctx);
    const vendorBefore = h.mocks.vendor.stats.requests;
    const enclaveBefore = h.mocks.enclave.stats.requests;
    const second = await (await h.request("/api/v1/batches", { method: "POST", headers: k.auth, json: { requests: [chatLine("a1", { provider: { lane: "attested" } }), chatLine("a2", { provider: { lane: "attested" } })] } })).json();
    for (let i = 0; i < 5; i++) await h.ctx.jobs.run("batches");
    const out = jsonl(await (await h.request(`/api/v1/batches/${second.id}/output`, { headers: k.auth })).text());
    expect(out.length).toBe(2);
    for (const l of out) expect(l.response.body.receipt.payload).toMatchObject({ lane: "attested", disclosure: "attested", provider: "enclave", batch: { id: second.id } });
    expect(h.mocks.vendor.stats.requests).toBe(vendorBefore);
    expect(h.mocks.enclave.stats.requests).toBe(enclaveBefore + 2);
  });
});
