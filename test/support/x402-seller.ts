import { randomBytes } from "node:crypto";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { X402_TYPES } from "../../src/pay/x402.ts";

// A fake x402 seller for the paid tool market tests, speaking either wire version:
//   v1: 402 JSON body { x402Version: 1, accepts }, paid with X-PAYMENT, answered with X-PAYMENT-RESPONSE
//   v2: 402 PAYMENT-REQUIRED header, paid with PAYMENT-SIGNATURE, answered with PAYMENT-RESPONSE
// It checks the EIP-3009 signature, recipient and amount like a seller's facilitator would, and records each payment.
// Like the reference middleware it reports a settlement only on a successful answer.

export type SellerMode = {
  version: 1 | 2;
  price: bigint; // USDG base units
  payTo: Hex;
  answer: unknown;
  contentType?: string;
  failAfterPay?: number; // answer this status after a valid payment (no settlement)
  bigBody?: number; // answer this many bytes of text
  free?: boolean; // never ask for payment
  declaredMime?: string;
  network?: string;
  asset?: Hex;
};
export type Payment = { version: number; from: Hex; to: Hex; value: bigint; nonce: Hex; validBefore: bigint; transaction: Hex };

export function startSeller(o: { chainId: number; usdg: Hex; domain?: { name: string; version: string }; mode: SellerMode }) {
  const state = { mode: o.mode, payments: [] as Payment[], unpaid: 0, rejected: 0, lastQuery: "" as string, lastBody: null as unknown };
  const domain = { name: o.domain?.name ?? "Global Dollar", version: o.domain?.version ?? "1", chainId: o.chainId, verifyingContract: getAddress(o.usdg) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const m = state.mode;
      const url = new URL(req.url);
      state.lastQuery = url.search;
      const text = req.method === "POST" ? await req.text() : "";
      state.lastBody = text ? JSON.parse(text) : null;
      const resource = `${url.origin}${url.pathname}`;
      const network = m.network ?? (m.version === 2 ? `eip155:${o.chainId}` : "robinhood-chain");
      const requirement = m.version === 2
        ? { scheme: "exact", network, amount: m.price.toString(), asset: m.asset ?? o.usdg, payTo: m.payTo, maxTimeoutSeconds: 60, extra: { name: domain.name, version: domain.version } }
        : { scheme: "exact", network, maxAmountRequired: m.price.toString(), resource, description: "fake tool", mimeType: m.declaredMime ?? "application/json", payTo: m.payTo, maxTimeoutSeconds: 60, asset: m.asset ?? o.usdg, extra: { name: domain.name, version: domain.version } };
      const ask = () => {
        if (m.version === 2) {
          const doc = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: resource, description: "fake tool", mimeType: m.declaredMime ?? "application/json" }, accepts: [requirement] };
          return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(doc)).toString("base64") } });
        }
        return Response.json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirement] }, { status: 402 });
      };
      if (m.free) return Response.json({ free: true });
      const header = m.version === 2 ? req.headers.get("payment-signature") : req.headers.get("x-payment");
      if (!header) { state.unpaid++; return ask(); }
      let doc: any;
      try { doc = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { state.rejected++; return ask(); }
      const a = doc?.payload?.authorization;
      const auth = a && { from: a.from as Hex, to: a.to as Hex, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex };
      let from: Hex | null = null;
      try { from = auth ? await recoverTypedDataAddress({ domain, types: X402_TYPES, primaryType: "TransferWithAuthorization", message: auth, signature: doc.payload.signature }) : null; } catch { from = null; }
      const v2ok = m.version !== 2 || (doc.x402Version === 2 && doc.accepted?.amount === m.price.toString() && doc.accepted?.payTo === m.payTo);
      if (!auth || !from || from.toLowerCase() !== auth.from.toLowerCase() || auth.to.toLowerCase() !== m.payTo.toLowerCase() || auth.value < m.price || doc.x402Version !== m.version || !v2ok) { state.rejected++; return ask(); }
      if (m.failAfterPay) return Response.json({ error: "tool broke" }, { status: m.failAfterPay });
      const transaction = `0x${randomBytes(32).toString("hex")}` as Hex;
      state.payments.push({ version: m.version, from: auth.from, to: auth.to, value: auth.value, nonce: auth.nonce, validBefore: auth.validBefore, transaction });
      const settled = Buffer.from(JSON.stringify({ success: true, transaction, network, payer: auth.from })).toString("base64");
      const body = m.bigBody ? "x".repeat(m.bigBody) : typeof m.answer === "string" ? m.answer : JSON.stringify(m.answer);
      const type = m.contentType ?? (m.bigBody || typeof m.answer === "string" ? "text/plain; charset=utf-8" : "application/json");
      return new Response(body, { status: 200, headers: { "content-type": type, [m.version === 2 ? "payment-response" : "x-payment-response"]: settled } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) };
}
