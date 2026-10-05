import { expect, test } from "bun:test";
import { AnyRoute, DECISION_TAG_HEADER, checkDecisionTag, decisionTag, receiptDecisionTag, withDecisionTag } from "../src/index.js";
import { json, makeRouterKey, signReceipt, stubFetch } from "./helpers.js";

// The known vector shared with the router's tests, integrations/robinhood-agents and the Python SDK.
const order = { symbol: "STOCK_A", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
const TAG = "sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d";

test("decisionTag hashes the order's canonical JSON, whatever its key order", async () => {
  expect(await decisionTag(order)).toBe(TAG);
  expect(await decisionTag({ client_order_id: "7f3c", limit_price: "180.00", quantity: "2", side: "buy", symbol: "STOCK_A" })).toBe(TAG);
  expect(await decisionTag({ ...order, quantity: 2 })).not.toBe(TAG);
});

test("withDecisionTag adds the header and keeps the caller's own options", async () => {
  expect(DECISION_TAG_HEADER).toBe("X-Anyroute-Decision-Tag");
  expect(await withDecisionTag(order)).toEqual({ headers: { "X-Anyroute-Decision-Tag": TAG } });
  expect(await withDecisionTag(order, { lane: "attested" as const, headers: { "x-title": "agent" } })).toEqual({ lane: "attested", headers: { "x-title": "agent", "X-Anyroute-Decision-Tag": TAG } });
});

test("the client sends the tag, and the signed receipt it gets back can be checked against the order", async () => {
  const key = makeRouterKey();
  const jwk = await key.ready;
  const sent: Record<string, string>[] = [];
  const { fetch } = stubFetch({
    "/.well-known/anyroute-receipt-keys.json": () => json({ keys: [jwk] }),
    "POST /api/v1/chat/completions": async ({ init }) => {
      const headers = init!.headers as Record<string, string>;
      sent.push(headers);
      const tag = headers[DECISION_TAG_HEADER];
      const receipt = await signReceipt(key.privateKey, jwk.kid, { v: 1, id: "gen-1", issued: new Date().toISOString(), model: "example/model", provider: "p", ...(tag ? { decision_tag: tag } : {}) });
      return json({ id: "gen-1", choices: [{ message: { role: "assistant", content: "wait" } }], receipt });
    },
  });
  const client = new AnyRoute({ baseUrl: "https://router.test", apiKey: "k", fetch });
  const res = await client.chat.completions.create({ model: "example/model", messages: [{ role: "user", content: "buy or wait?" }] }, await withDecisionTag(order));
  expect(sent[0][DECISION_TAG_HEADER]).toBe(TAG);
  expect(res.anyroute.receiptVerification?.valid).toBe(true);
  expect(receiptDecisionTag(res.receipt)).toBe(TAG);
  expect(await checkDecisionTag(res.receipt, order)).toEqual({ matches: true, tag: TAG, expected: TAG });
  expect((await checkDecisionTag(res.receipt, { ...order, quantity: "20" })).matches).toBe(false);
  // v2 claims count when there is no v1 payload; a receipt with no tag never matches.
  expect(receiptDecisionTag({ v2: { claims: { decision_tag: TAG } } })).toBe(TAG);
  expect(await checkDecisionTag({ payload: { model: "m" } }, order)).toEqual({ matches: false, tag: null, expected: TAG });
});
