import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generations } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { decodeClaims, decodeCoseSign1 } from "../src/receipts/v2.ts";
import { decisionTagOf, parseDecisionTag } from "../src/receipts/decision-tag.ts";
import { DECISION_TAG_HEADER, decisionHeaders, orderIntentHash, verifyDecisionReceipt } from "../integrations/robinhood-agents/decision-receipt.ts";
import { startRouter, sse, MODELS, type Harness } from "./helpers.ts";

// B: X-Anyroute-Decision-Tag. The digest of an order intent, signed into the v1 and v2 receipts of the model call that
// informed it, verifiable later with the integration helper against the router's published keys.

const intent = { symbol: "STOCK_A", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
const chat = (extra: Record<string, unknown> = {}) => ({ model: MODELS.llama.slug, messages: [{ role: "user", content: "buy or wait?" }], max_tokens: 32, ...extra });

test("the helper's intent hash is canonical, has a fixed known vector shared with the Python helper, and parses as a tag", () => {
  expect(orderIntentHash(intent)).toBe("sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d");
  expect(orderIntentHash({ client_order_id: "7f3c", limit_price: "180.00", quantity: "2", side: "buy", symbol: "STOCK_A" })).toBe(orderIntentHash(intent));
  expect(decisionHeaders(intent)).toEqual({ [DECISION_TAG_HEADER]: orderIntentHash(intent) });
  expect(parseDecisionTag(orderIntentHash(intent))).toBe(orderIntentHash(intent));
  expect(parseDecisionTag(orderIntentHash(intent).slice(7).toUpperCase())).toBe(orderIntentHash(intent));
  expect(parseDecisionTag(undefined)).toBeNull();
  for (const bad of ["", "sha256:", "sha256:xyz", "sha512:" + "a".repeat(64), "a".repeat(63), "a".repeat(65)]) expect(() => parseDecisionTag(bad)).toThrow(/X-Anyroute-Decision-Tag/);
});

test("the unlinkable lane refuses a tag; off means the header is never read", () => {
  const c = { req: { header: (n: string) => (n === "x-anyroute-decision-tag" ? orderIntentHash(intent) : undefined) } } as never;
  expect(() => decisionTagOf(true, c, "unlinkable")).toThrow(/unlinkable lane/);
  expect(decisionTagOf(true, c, "attested")).toBe(orderIntentHash(intent));
  expect(decisionTagOf(false, { req: { header: () => "not a tag" } } as never, "public")).toBeNull();
});

describe("DECISION_TAGS_ENABLED=true", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { DECISION_TAGS_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });

  test("the tag round-trips into the signed v1 and v2 receipts and verifies with the helper; a changed intent does not", async () => {
    const key = await h.fundedKey();
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(intent) }, json: chat() });
    expect(r.status).toBe(200);
    const receipt = (await r.json()).receipt;
    expect(receipt.payload.decision_tag).toBe(orderIntentHash(intent));
    expect(receipt.v2.claims.decision_tag).toBe(orderIntentHash(intent));
    // The COSE bytes carry it too (the JSON claims are only a view of them).
    expect(decodeClaims(decodeCoseSign1(Buffer.from(receipt.v2.cose, "base64")).payload).decision_tag).toBe(orderIntentHash(intent));
    const keys = await (await h.request("/.well-known/anyroute-receipt-keys.json")).json();
    const ok = await verifyDecisionReceipt(receipt, intent, { keys });
    expect(ok).toMatchObject({ ok: true, checks: { key_found: true, signature: true, decision_tag: true }, model: MODELS.llama.slug });
    expect((await verifyDecisionReceipt(receipt, { ...intent, quantity: "20" }, { keys })).checks).toEqual({ key_found: true, signature: true, decision_tag: false });
    // Editing the tag in a stored receipt breaks the router's signature.
    const forged = { ...receipt, payload: { ...receipt.payload, decision_tag: orderIntentHash({ ...intent, quantity: "20" }) } };
    expect((await verifyDecisionReceipt(forged, { ...intent, quantity: "20" }, { keys })).checks.signature).toBe(false);
    // The router's own verifier agrees, and the stored generation keeps the same signed payload.
    expect((await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id } })).json()).data.valid).toBe(true);
    const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, receipt.id));
    expect((row.receipt as { decision_tag?: string }).decision_tag).toBe(orderIntentHash(intent));
    expect((row.receiptV2 as { decision_tag?: string }).decision_tag).toBe(orderIntentHash(intent));
  });

  test("streamed calls carry the tag in the closing receipt; untagged calls are unchanged", async () => {
    const key = await h.fundedKey();
    const s = await sse(await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, ...decisionHeaders(intent) }, json: chat({ stream: true }) }));
    const final = s.events.find((e) => e.receipt);
    expect(final.receipt.payload.decision_tag).toBe(orderIntentHash(intent));
    expect(final.receipt.v2.claims.decision_tag).toBe(orderIntentHash(intent));
    const plain = (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: chat() })).json()).receipt;
    expect("decision_tag" in plain.payload).toBe(false);
    expect("decision_tag" in plain.v2.claims).toBe(false);
  });

  test("a malformed tag is refused before anything is held or charged", async () => {
    const key = await h.fundedKey();
    const account = (await h.ctx.db.query.keys.findFirst({ where: (k, { eq }) => eq(k.keyHash, key.hash) }))!.accountId;
    const before = await balanceOf(h.ctx.db, account);
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, [DECISION_TAG_HEADER]: "buy STOCK_A" }, json: chat() });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("invalid_decision_tag");
    expect(await balanceOf(h.ctx.db, account)).toEqual(before);
  });

  test("the Responses, Anthropic and Ollama adapters pass the tag through, and a browser may send it", async () => {
    const key = await h.fundedKey();
    const tagged = { ...decisionHeaders(intent) };
    const calls = [
      await h.request("/v1/responses", { method: "POST", headers: { ...key.auth, ...tagged }, json: { model: MODELS.llama.slug, input: "buy or wait?" } }),
      await h.request("/v1/messages", { method: "POST", headers: { "x-api-key": key.secret, ...tagged }, json: { model: MODELS.llama.slug, max_tokens: 32, messages: [{ role: "user", content: "buy or wait?" }] } }),
      await h.request("/ollama/api/chat", { method: "POST", headers: { ...key.auth, ...tagged }, json: { model: MODELS.llama.slug, stream: false, messages: [{ role: "user", content: "buy or wait?" }] } }),
    ];
    for (const res of calls) {
      expect(res.status).toBe(200);
      const id = res.headers.get("x-receipt-id");
      expect(id).toBeTruthy();
      expect((await (await h.request(`/api/v1/receipts/${id}`)).json()).data.payload.decision_tag).toBe(orderIntentHash(intent));
    }
    const preflight = await h.request("/api/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-anyroute-decision-tag" } });
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-anyroute-decision-tag");
  });

  test("/api/v1/status says decision tags are on", async () => {
    expect((await (await h.request("/api/v1/status")).json()).data.decision_tags).toEqual({ enabled: true, header: "X-Anyroute-Decision-Tag" });
  });
});

describe("DECISION_TAGS_ENABLED unset (the default)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h?.close(); });

  test("the header is ignored, the receipt has no tag and status says off", async () => {
    const key = await h.fundedKey();
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, [DECISION_TAG_HEADER]: "not even a hash" }, json: chat() });
    expect(r.status).toBe(200);
    const receipt = (await r.json()).receipt;
    expect("decision_tag" in receipt.payload).toBe(false);
    expect((await (await h.request("/api/v1/status")).json()).data.decision_tags.enabled).toBe(false);
  });
});

describe("decision tags linked to Agent Guard (DECISION_TAGS_ENABLED and AGENT_GUARD_ENABLED)", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { DECISION_TAGS_ENABLED: "true", AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });
  type Auth = { hash?: string; auth: Record<string, string> };
  const rulebook = { version: 1, models: {}, caps: {}, on_breach: "deny", actions: {} };
  const tag = orderIntentHash(intent);
  const decide = async (k: Auth, details?: string) => (await (await h.request("/api/v1/guard/decide", { method: "POST", headers: k.auth, json: { action: "trade.order", target: "STOCK_A", amount_usd: "360.00", ...(details ? { details_sha256: details } : {}) } })).json()).data;
  const ask = async (k: Auth, headers: Record<string, string> = {}) => {
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, ...headers }, json: chat() });
    expect(r.status).toBe(200);
    return (await r.json()).receipt;
  };
  const lookup = async (k: Auth, query: string) => h.request(`/api/v1/guard/decisions?${query}`, { headers: k.auth });

  test("a decision names the calls in the same agent whose receipt carries its order digest, and the reverse lookup finds it", async () => {
    const parent = await h.fundedKey();
    expect((await h.request(`/api/v1/agents/${parent.hash}/policy`, { method: "PUT", headers: parent.auth, json: rulebook })).status).toBe(200);
    const session = (await (await h.request("/api/v1/sessions", { method: "POST", headers: parent.auth, json: { budget_usd: 1 } })).json()).data;
    const agent: Auth = { auth: { authorization: `Bearer ${session.key}` } };
    const informing = await ask(agent, decisionHeaders(intent));
    await ask(agent, decisionHeaders({ ...intent, quantity: "20" }));
    const untagged = await ask(agent);

    const d = await decide(agent, tag);
    expect(d.decision).toBe("allow");
    expect(d.informed_by).toEqual([{ generation_id: informing.id, receipt_id: informing.id, model: informing.payload.model, provider: informing.payload.provider, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), receipt_url: `/api/v1/receipts/${informing.id}`, verify_url: `/verify/?r=${informing.id}` }]);
    // The linked receipt is the signed one, and its tag is the decision's digest.
    expect((await (await h.request(d.informed_by[0].receipt_url)).json()).data.payload.decision_tag).toBe(d.signed.payload.intent.details_sha256);
    // The parent key is the same agent; another key in the account is not; no digest, no link field.
    const parentDecision = await decide(parent, tag);
    expect(parentDecision.informed_by.map((c: { generation_id: string }) => c.generation_id)).toEqual([informing.id]);
    const otherKey = await h.request("/api/v1/keys", { method: "POST", headers: parent.auth, json: { name: "other agent" } });
    const other: Auth = { auth: { authorization: `Bearer ${(await otherKey.json()).key}` } };
    const otherDecision = await decide(other, tag);
    expect(otherDecision.informed_by).toEqual([]);
    expect("informed_by" in (await decide(agent))).toBe(false);

    // The reverse: from a receipt id, or the digest, to the decisions the reader may see, each with its informing calls.
    const byReceipt = (await (await lookup(parent, `receipt=${informing.id}`)).json()).data;
    // The harness's first key manages its account, so it reads every decision in it.
    expect(byReceipt).toMatchObject({ details_sha256: tag, receipt_id: informing.id, scope: "account" });
    expect(byReceipt.decisions.map((x: { decision_id: string }) => x.decision_id).sort()).toEqual([d.decision_id, parentDecision.decision_id, otherDecision.decision_id].sort());
    const mine = byReceipt.decisions.find((x: { decision_id: string }) => x.decision_id === d.decision_id);
    expect(mine).toMatchObject({ action: "trade.order", target: "STOCK_A", amount_pico: "360000000000000", decision: "allow", details_sha256: tag, outcome: null });
    expect(mine.informed_by.map((c: { generation_id: string }) => c.generation_id)).toEqual([informing.id]);
    // A session key reads only its own decisions; another key reads only its own.
    expect((await (await lookup(agent, `details_sha256=${tag}`)).json()).data.decisions.map((x: { decision_id: string }) => x.decision_id)).toEqual([d.decision_id]);
    const theirs = (await (await lookup(other, `receipt=${informing.id}`)).json()).data;
    expect([theirs.scope, theirs.decisions.map((x: { decision_id: string; informed_by: unknown[] }) => [x.decision_id, x.informed_by])]).toEqual(["key", [[otherDecision.decision_id, []]]]);
    // A receipt without a tag links nothing; bad input is refused.
    expect((await (await lookup(parent, `receipt=${untagged.id}`)).json()).data).toMatchObject({ details_sha256: null, decisions: [] });
    expect((await lookup(parent, "receipt=gen-missing")).status).toBe(404);
    for (const q of ["", `details_sha256=${tag.toUpperCase()}`, `details_sha256=${tag}&receipt=${informing.id}`]) expect((await lookup(parent, q)).status).toBe(400);
  });
});

describe("Agent Guard with DECISION_TAGS_ENABLED unset", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", AGENT_GUARD_ENABLED: "true" } }); });
  afterAll(async () => { await h?.close(); });

  test("a decision carries no link field, and the reverse lookup lists decisions without informing calls", async () => {
    const key = await h.fundedKey();
    const d = (await (await h.request("/api/v1/guard/decide", { method: "POST", headers: key.auth, json: { action: "trade.order", amount_usd: "1", details_sha256: orderIntentHash(intent) } })).json()).data;
    expect("informed_by" in d).toBe(false);
    const rev = (await (await h.request(`/api/v1/guard/decisions?details_sha256=${orderIntentHash(intent)}`, { headers: key.auth })).json()).data;
    expect(rev.decisions.map((x: { decision_id: string }) => x.decision_id)).toEqual([d.decision_id]);
    expect("informed_by" in rev.decisions[0]).toBe(false);
  });
});
