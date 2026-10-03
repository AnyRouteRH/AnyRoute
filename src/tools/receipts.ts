import type { Ctx } from "../context.ts";
import { picoToUsdString } from "../lib/money.ts";
import type { ClaimsV2 } from "../receipts/v2.ts";

// A tool.call receipt: the same COSE_Sign1 envelope and Ed25519 key as receipt v2 (src/receipts/v2.ts), over a claim
// set for a paid tool call. Like a generation receipt it carries hashes and amounts only: no key, account or content.
// req.h and resp.h sit where receipt v2 keeps them, so POST /api/v1/receipts/verify checks the signature and, given
// response_sha256, the answer's hash.

export type ToolClaims = {
  v: 2;
  kind: "tool.call";
  rid: string;
  iat: number;
  iss: string;
  req: { h: string };
  resp: { h: string; status: number; bytes: number; type: string };
  tool: { resource: string; seller: string; seller_id?: string; network: string; scheme: "exact"; x402: number };
  price: { units: string; usd: string; take_usd: string; charged_usd: string };
  settle: { tx: string | null; network: string | null };
};

export function signToolReceipt(ctx: Ctx, i: {
  id: string; issuedAt: Date; requestSha256: string; responseSha256: string; status: number; bytes: number; contentType: string;
  resource: string; payTo: string; sellerId: string | null; network: string; x402Version: number;
  priceUnits: bigint; pricePico: bigint; takePico: bigint; settleTx: string | null; settleNetwork: string | null;
}) {
  const claims: ToolClaims = {
    v: 2,
    kind: "tool.call",
    rid: i.id,
    iat: Math.floor(i.issuedAt.getTime() / 1000),
    iss: ctx.cfg.publicUrl,
    req: { h: `sha256:${i.requestSha256}` },
    resp: { h: `sha256:${i.responseSha256}`, status: i.status, bytes: i.bytes, type: i.contentType },
    tool: { resource: i.resource, seller: i.payTo.toLowerCase(), ...(i.sellerId ? { seller_id: i.sellerId } : {}), network: i.network, scheme: "exact", x402: i.x402Version },
    price: { units: i.priceUnits.toString(), usd: picoToUsdString(i.pricePico), take_usd: picoToUsdString(i.takePico), charged_usd: picoToUsdString(i.pricePico + i.takePico) },
    settle: { tx: i.settleTx, network: i.settleNetwork },
  };
  // signCose encodes whatever claim map it is given; the tool claims are a sibling of the generation claims.
  const signed = ctx.signer.signCose(claims as unknown as ClaimsV2);
  return { id: i.id, kind: "tool.call" as const, key_id: signed.keyId, cose: signed.cose.toString("base64"), leaf: signed.leaf, claims, verify: "/api/v1/receipts/verify" };
}
