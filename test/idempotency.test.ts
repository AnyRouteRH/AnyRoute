import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { keys, generations } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { uid } from "../src/lib/util.ts";
import { idempotencyMiddleware } from "../src/idempotency/middleware.ts";
import { IDEMPOTENCY_TTL_MS, IdempotencyStore, idempotencyStore } from "../src/idempotency/store.ts";
import { privacyLabel } from "../src/privacy/label.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

describe("D145 encrypted retry store", () => {
  test("atomically claims once, seals replies, expires and fences a late completion", async () => {
    let now = 0;
    const store = new IdempotencyStore("fixture-secret", undefined, () => now);
    const ref = store.ref("sample-account", "sample-key", "sample-retry");
    const claims = await Promise.all([store.claim(ref, "body-hash"), store.claim(ref, "body-hash")]);
    expect(claims.map(c => c.first)).toEqual([true, false]);
    const result = { status: 201, headers: { "x-receipt-id": "sample-receipt" }, body: '{"answer":"sensitive reply"}' };
    await store.finish(ref, claims[0], result);
    expect(await store.sealedAt(ref)).not.toContain("sensitive reply");
    expect((await store.claim(ref, "body-hash")).entry.result).toEqual(result);
    now = IDEMPOTENCY_TTL_MS;
    expect(await store.sealedAt(ref)).toBeNull();
    const next = await store.claim(ref, "new-body");
    expect(next.first).toBe(true);
    await store.finish(ref, claims[0], result);
    expect((await store.claim(ref, "new-body")).entry.result).toBeUndefined();
  });
  test("scopes account and API key independently and never evicts a live guard", async () => {
    const store = new IdempotencyStore("fixture-secret", undefined, Date.now, 1);
    expect(store.ref("a", "k", "i")).not.toBe(store.ref("b", "k", "i"));
    expect(store.ref("a", "k", "i")).not.toBe(store.ref("a", "l", "i"));
    const ref = store.ref("a", "k", "i");
    await store.claim(ref, "h");
    await expect(store.claim(store.ref("b", "k", "i"), "h")).rejects.toThrow("full");
    expect((await store.claim(ref, "h")).first).toBe(false);
  });
});

describe("D145 inference retries", () => {
  let h: Harness;
  let key: Awaited<ReturnType<Harness["fundedKey"]>>;
  let account: string;
  const chat = { model: MODELS.llama.slug, messages: [{ role: "user", content: "Say hello" }], max_tokens: 32 };
  const post = (path: string, json: Record<string, unknown>, id?: string, auth = key.auth) => h.request(path, { method: "POST", json, headers: { ...auth, ...(id !== undefined ? { "idempotency-key": id } : {}) } });
  const balance = async () => (await balanceOf(h.ctx.db, account)).balance;
  beforeAll(async () => {
    h = await startRouter({ providers: [{ id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.embed, { id: "rerank-small", slug: "sample/rerank", prompt: "0.00000002", completion: "0", output: ["rerank"] }] }] });
    key = await h.fundedKey();
    [account] = (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash))).map(k => k.accountId);
  });
  afterAll(() => h?.close());

  test("replays all six final formats with no charge, provider call or new receipt", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["chat/completions", chat],
      ["completions", { model: MODELS.llama.slug, prompt: "Say hello", max_tokens: 32 }],
      ["messages", chat],
      ["responses", { model: MODELS.llama.slug, input: "Say hello", max_output_tokens: 32 }],
      ["embeddings", { model: MODELS.embed.slug, input: "hello" }],
      ["rerank", { model: "sample/rerank", query: "hello", documents: ["hello world", "goodbye"] }],
    ];
    for (const [path, body] of cases) {
      const id = uid();
      const auth = path === "messages" ? { "x-api-key": key.secret } : key.auth;
      const before = await balance();
      const first = await post(`/api/v1/${path}`, body, id, auth);
      expect(first.status, await first.clone().text()).toBe(200);
      const bytes = await first.text();
      const receipt = first.headers.get("x-receipt-id");
      expect(receipt).toBeTruthy();
      const charged = await balance();
      expect(charged).toBeLessThan(before);
      const providerCalls = h.mocks.alpha.stats.requests;
      const totalRows = (await h.ctx.db.select({ id: generations.id }).from(generations)).length;
      const replay = await post(`/v1/${path}`, body, id, auth);
      expect(replay.status).toBe(first.status);
      expect(await replay.text()).toBe(bytes);
      expect(replay.headers.get("idempotent-replay")).toBe("true");
      for (const header of ["x-receipt-id", "x-generation-id", "inference-id", "x-anyroute-lane", "x-anyroute-policy-hash"]) expect(replay.headers.get(header)).toBe(first.headers.get(header));
      expect(await balance()).toBe(charged);
      expect(h.mocks.alpha.stats.requests).toBe(providerCalls);
      expect((await h.ctx.db.select({ id: generations.id }).from(generations)).length).toBe(totalRows);
      const rows = await h.ctx.db.select().from(generations).where(eq(generations.id, receipt!));
      expect(rows).toHaveLength(1);
      expect(rows[0].keyHash).toBe(key.hash);
    }
  });
  test("rejects a changed body or endpoint; canonical object order does not matter", async () => {
    const id = uid();
    const first = await post("/api/v1/chat/completions", chat, id);
    const body = await first.text();
    const replay = await post("/api/v1/chat/completions", { max_tokens: 32, messages: chat.messages, model: chat.model }, id);
    expect(await replay.text()).toBe(body);
    for (const [path, changed] of [["chat/completions", { ...chat, max_tokens: 33 }], ["completions", chat]] as const) {
      const res = await post(`/api/v1/${path}`, changed, id);
      expect(res.status).toBe(422);
      expect((await res.json()).error.type).toBe("idempotency_key_reused");
    }
  });
  test("in-progress retry cannot charge or issue a receipt", async () => {
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ delayMs: 150 }) });
    const id = uid();
    const pending = post("/api/v1/chat/completions", chat, id);
    const store = idempotencyStore(h.ctx);
    const ref = store.ref(account, key.hash, id);
    for (let i = 0; i < 100 && !(await store.sealedAt(ref)); i++) await Bun.sleep(5);
    expect(await store.sealedAt(ref)).toBeTruthy();
    const retry = await post("/api/v1/chat/completions", chat, id);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.type).toBe("idempotency_in_progress");
    expect(retry.headers.get("x-receipt-id")).toBeNull();
    expect((await pending).status).toBe(200);
    await fetch(h.mocks.alpha.url + "/_control", { method: "POST", body: JSON.stringify({ delayMs: 0 }) });
  });
  test("stream retry returns 409 with the original receipt without charging", async () => {
    for (const path of ["chat/completions", "completions", "responses", "messages"]) {
      const id = uid();
      const body = path === "responses" ? { model: chat.model, input: "Say hello", max_output_tokens: 32, stream: true } : path === "completions" ? { model: chat.model, prompt: "Say hello", max_tokens: 32, stream: true } : { ...chat, stream: true };
      const first = await post(`/api/v1/${path}`, body, id);
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("data:");
      const charged = await balance();
      const replay = await post(`/api/v1/${path}`, body, id);
      expect(replay.status).toBe(409);
      expect((await replay.json()).error).toMatchObject({ type: "idempotency_result_not_kept", metadata: { receipt_id: first.headers.get("x-receipt-id") } });
      expect(replay.headers.get("x-receipt-id")).toBe(first.headers.get("x-receipt-id"));
      expect(await balance()).toBe(charged);
    }
  });
  test("same retry key stays isolated between accounts and keys within an account", async () => {
    const other = await h.fundedKey();
    const sibling = await h.newKey();
    await h.ctx.db.update(keys).set({ accountId: account }).where(eq(keys.keyHash, sibling.hash));
    const id = uid();
    const receipts = [];
    for (const auth of [key.auth, other.auth, sibling.auth]) {
      const res = await post("/api/v1/chat/completions", chat, id, auth);
      expect(res.status).toBe(200);
      expect(res.headers.get("idempotent-replay")).toBeNull();
      receipts.push(res.headers.get("x-receipt-id"));
      await res.text();
    }
    expect(new Set(receipts).size).toBe(3);
  });
  test("missing, invalid and disabled credentials cannot read a replay", async () => {
    const other = await h.fundedKey();
    const id = uid();
    await (await post("/api/v1/chat/completions", chat, id, other.auth)).text();
    await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, other.hash));
    for (const auth of [{}, { authorization: "Bearer invalid" }, other.auth]) expect((await post("/api/v1/chat/completions", chat, id, auth)).status).toBe(401);
  });
  test("visible ASCII validation; 128 characters accepted; headerless calls bill normally", async () => {
    for (const id of ["", "two words", "é", "x".repeat(129)]) {
      const res = await post("/api/v1/chat/completions", chat, id);
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_idempotency_key");
    }
    expect((await post("/api/v1/chat/completions", chat, "x".repeat(128))).status).toBe(200);
    const receipts = [];
    for (let i = 0; i < 2; i++) {
      const before = await balance();
      const res = await post("/api/v1/chat/completions", chat);
      expect(res.headers.get("idempotent-replay")).toBeNull();
      receipts.push(res.headers.get("x-receipt-id"));
      await res.text();
      expect(await balance()).toBeLessThan(before);
    }
    expect(receipts[0]).not.toBe(receipts[1]);
  });
  test("headerless middleware leaves body, status and headers unchanged; opted-in errors replay", async () => {
    const app = new Hono();
    idempotencyMiddleware(app, h.ctx);
    app.post("/api/v1/completions", () => new Response('{"error":"sample"}', { status: 418, headers: { "content-type": "application/json", "x-receipt-id": "sample-receipt" } }));
    const plain = await app.request("/api/v1/completions", { method: "POST" });
    expect(plain.status).toBe(418);
    expect(await plain.text()).toBe('{"error":"sample"}');
    expect([...plain.headers]).toEqual([["content-type", "application/json"], ["x-receipt-id", "sample-receipt"]]);
    const init = { method: "POST", headers: { ...key.auth, "idempotency-key": uid() }, body: "{}" };
    const first = await app.request("/api/v1/completions", init);
    const second = await app.request("/api/v1/completions", init);
    expect(second.status).toBe(418);
    expect(await second.text()).toBe(await first.text());
    expect(second.headers.get("idempotent-replay")).toBe("true");
  });
  test("keeps a large final JSON reply rather than charging and dropping retry recovery", async () => {
    const app = new Hono();
    idempotencyMiddleware(app, h.ctx);
    const reply = JSON.stringify({ answer: "a".repeat(9 * 1024 * 1024) });
    app.post("/api/v1/completions", () => new Response(reply, { headers: { "content-type": "application/json", "x-receipt-id": "sample-large-receipt" } }));
    const init = { method: "POST", headers: { ...key.auth, "idempotency-key": uid() }, body: "{}" };
    expect(await (await app.request("/api/v1/completions", init)).text()).toBe(reply);
    const replay = await app.request("/api/v1/completions", init);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.headers.get("x-receipt-id")).toBe("sample-large-receipt");
    expect(await replay.text()).toBe(reply);
  });
  test("browser preflight allows retry header and exposes replay header only when opted in", async () => {
    const res = await h.request("/api/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://sample.invalid", "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key" } });
    expect(res.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    const first = await post("/api/v1/chat/completions", chat, uid());
    expect(first.headers.get("access-control-expose-headers")).toContain("idempotent-replay");
    await first.text();
  });
  test("privacy label says retention is opt-in and the router can read it", () => {
    const label = privacyLabel({ id: "sample-receipt", payload: { lane: "public", provider: "alpha", mode: "prepaid" } });
    expect(label.label.stored.text).toContain("Idempotency-Key");
    expect(label.label.stored.text).toContain("24 hours");
    expect(label.label.stored.text).toContain("The router can read this content");
  });
  test.skipIf(!process.env.TEST_REDIS_URL)("Redis shares claims, encrypts at rest and expires without extending retention", async () => {
    const redis = h.ctx.cache.redis!;
    const a = new IdempotencyStore(h.ctx.cfg.appSecret, redis);
    const b = new IdempotencyStore(h.ctx.cfg.appSecret, redis);
    const ref = a.ref("sample-account", "sample-key", uid());
    const claim = await a.claim(ref, "hash");
    expect((await b.claim(ref, "hash")).first).toBe(false);
    await redis.pexpire(ref, 5000);
    await a.finish(ref, claim, { status: 200, headers: {}, body: "sensitive reply" });
    expect(await redis.pttl(ref)).toBeLessThanOrEqual(5000);
    expect(await b.sealedAt(ref)).not.toContain("sensitive reply");
    expect((await b.claim(ref, "hash")).entry.result?.body).toBe("sensitive reply");
    await redis.pexpire(ref, 1);
    await Bun.sleep(5);
    expect((await b.claim(ref, "new-hash")).first).toBe(true);
    await a.finish(ref, claim, { status: 200, headers: {}, body: "late reply" });
    expect((await b.claim(ref, "new-hash")).entry.result).toBeUndefined();
    await redis.del(ref);
  });
});
