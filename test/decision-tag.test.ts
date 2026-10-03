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

const intent = { symbol: "NVDA", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
const chat = (extra: Record<string, unknown> = {}) => ({ model: MODELS.llama.slug, messages: [{ role: "user", content: "buy or wait?" }], max_tokens: 32, ...extra });

test("the helper's intent hash is canonical, has a fixed known vector shared with the Python helper, and parses as a tag", () => {
  expect(orderIntentHash(intent)).toBe("sha256:16dc5789390743edeeec90c686873ddfd5cc435514b4bf0550490af74033e22a");
  expect(orderIntentHash({ client_order_id: "7f3c", limit_price: "180.00", quantity: "2", side: "buy", symbol: "NVDA" })).toBe(orderIntentHash(intent));
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
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...key.auth, [DECISION_TAG_HEADER]: "buy NVDA" }, json: chat() });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("invalid_decision_tag");
    expect(await balanceOf(h.ctx.db, account)).toEqual(before);
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
