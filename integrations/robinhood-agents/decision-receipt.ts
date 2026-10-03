// Decision receipts: tag each model call with the SHA-256 of the order intent it informs, so you can later prove which
// model said what before a trade. Works with any OpenAI-compatible client that can set a request header.
//
// This file only hashes a JSON object you pass it and checks signatures. It never places orders, never talks to a
// brokerage and never sees brokerage credentials. Node 18+, Bun or Deno; no dependencies.
//
//   import OpenAI from "openai";
//   import { decisionHeaders, verifyDecisionReceipt } from "./decision-receipt.ts";
//   const client = new OpenAI({ baseURL: "https://anyroute.tech/api/v1", apiKey: process.env.ANYROUTE_KEY });
//   const intent = { symbol: "NVDA", side: "buy", quantity: "2", limit_price: "180.00", client_order_id: "7f3c" };
//   const reply = await client.chat.completions.create({ model, messages }, { headers: decisionHeaders(intent) });
//   const receipt = (reply as unknown as { receipt: SignedReceipt }).receipt; // keep it next to the intent
//   // later, or in an audit:
//   const check = await verifyDecisionReceipt(receipt, intent, { baseUrl: "https://anyroute.tech" });
import { createHash, createPublicKey, verify } from "node:crypto";

export const DECISION_TAG_HEADER = "X-Anyroute-Decision-Tag";

/** Deterministic JSON: object keys sorted, no whitespace, undefined dropped. The form Anyroute signs receipts in. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) if ((v as Record<string, unknown>)[k] !== undefined) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * `sha256:<hex>` of the canonical JSON of an order intent: whatever your agent decided (symbol, side, quantity, limit price,
 * your own order id, a timestamp). Write prices and quantities as strings so every language hashes the same bytes.
 */
export function orderIntentHash(intent: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

/** The header to send with the model call that informs this intent. */
export const decisionHeaders = (intent: Record<string, unknown>) => ({ [DECISION_TAG_HEADER]: orderIntentHash(intent) });

export type SignedReceipt = { id?: string; sig: string; key_id: string; payload: Record<string, unknown> & { decision_tag?: string } };
export type ReceiptKeys = { keys: { kid: string; x: string; crv?: string }[] };

/**
 * Check a stored receipt: the router's Ed25519 signature over its canonical payload, with the key published at
 * /.well-known/anyroute-receipt-keys.json (or keys you pinned), and that its decision_tag is this intent's hash.
 * A pass shows the router signed that this model and provider answered this request (request_sha256) with this
 * answer (response_sha256) for this intent. Anchoring on chain is a further, separate check (GET /api/v1/receipts/:id/proof).
 */
export async function verifyDecisionReceipt(receipt: SignedReceipt, intent: Record<string, unknown>, opts: { baseUrl?: string; keys?: ReceiptKeys; fetch?: typeof fetch } = {}) {
  const expected = orderIntentHash(intent);
  const keys = opts.keys ?? (await (await (opts.fetch ?? fetch)(`${(opts.baseUrl ?? "https://anyroute.tech").replace(/\/$/, "")}/.well-known/anyroute-receipt-keys.json`)).json() as ReceiptKeys);
  const jwk = keys.keys.find((k) => k.kid === receipt.key_id);
  let signature = false;
  if (jwk) {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    signature = verify(null, Buffer.from(canonicalJson(receipt.payload)), key, Buffer.from(receipt.sig, "base64"));
  }
  const tag = receipt.payload.decision_tag === expected;
  return {
    ok: signature && tag,
    checks: { key_found: !!jwk, signature, decision_tag: tag },
    expected_tag: expected,
    model: receipt.payload.model,
    provider: receipt.payload.provider,
    issued: receipt.payload.issued,
    request_sha256: receipt.payload.request_sha256,
    response_sha256: receipt.payload.response_sha256,
  };
}
