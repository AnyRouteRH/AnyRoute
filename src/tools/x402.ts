import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { X402_TYPES } from "../pay/x402.ts";
import type { ToolsBuyer } from "./config.ts";

// The buyer side of x402: read a seller's 402, pick an offer this router can pay (scheme exact, USDG on this chain),
// sign the EIP-3009 TransferWithAuthorization from the buyer wallet to the seller's payTo, and read the seller's
// settlement answer. Both wire versions are spoken:
//   v1  402 JSON body { x402Version: 1, accepts: [{ maxAmountRequired, payTo, asset, network, ... }] }
//       paid retry carries X-PAYMENT, the answer carries X-PAYMENT-RESPONSE
//   v2  402 PAYMENT-REQUIRED header (base64 JSON { x402Version: 2, resource, accepts: [{ amount, ... }] })
//       paid retry carries PAYMENT-SIGNATURE, the answer carries PAYMENT-RESPONSE
// The buyer never needs the seller's facilitator: the seller settles with whichever facilitator it uses.

const MAX_HEADER = 64 * 1024;
const MAX_UINT = (1n << 256n) - 1n;

export type Offer = {
  version: 1 | 2;
  network: string;
  amount: bigint; // USDG base units
  asset: Hex;
  payTo: Hex;
  maxTimeoutSeconds: number;
  mimeType: string | null;
  /** The requirement exactly as the seller sent it (echoed back as `accepted` in a v2 payment). */
  raw: Record<string, unknown>;
  /** v2 resource info, echoed back in the payment. */
  resource: Record<string, unknown> | null;
};
export type PaymentRequired = { version: 1 | 2; accepts: unknown[]; resource: Record<string, unknown> | null };

const decodeHeader = (value: string | null): unknown => {
  if (!value || value.length > MAX_HEADER) return null;
  try {
    return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The seller's payment requirements: the v2 PAYMENT-REQUIRED header first, then a v1 (or v2) JSON body. */
export function readPaymentRequired(headers: Headers, body: string | null): PaymentRequired | null {
  const fromHeader = obj(decodeHeader(headers.get("payment-required")));
  let doc = fromHeader;
  if (!doc && body) {
    try {
      doc = obj(JSON.parse(body));
    } catch {
      doc = null;
    }
  }
  if (!doc || !Array.isArray(doc.accepts)) return null;
  const version = Number(doc.x402Version) === 2 || fromHeader ? 2 : Number(doc.x402Version) === 1 ? 1 : null;
  if (!version) return null;
  return { version, accepts: doc.accepts.slice(0, 32), resource: obj(doc.resource) };
}

/** True when `network` names this router's chain, in v1 naming (X402_NETWORK) or CAIP-2 (eip155:<chain id>). */
export const ourNetwork = (ctx: Ctx, network: unknown) => typeof network === "string" && (network === ctx.cfg.x402.network || network.toLowerCase() === `eip155:${ctx.cfg.chain.id}`);

/**
 * The first offer the router can pay: scheme exact, this chain, USDG, a real payTo and a positive whole amount.
 * Returns the reason none fits otherwise (a fixed code).
 */
export function chooseOffer(ctx: Ctx, pr: PaymentRequired): { offer: Offer } | { problem: string } {
  let problem = "no_offer";
  for (const raw of pr.accepts) {
    const a = obj(raw);
    if (!a) continue;
    if (a.scheme !== "exact") { problem = "unsupported_scheme"; continue; }
    if (!ourNetwork(ctx, a.network)) { problem = "unsupported_network"; continue; }
    if (typeof a.asset !== "string" || a.asset.toLowerCase() !== ctx.cfg.chain.usdg.toLowerCase()) { problem = "unsupported_asset"; continue; }
    if (typeof a.payTo !== "string" || !isAddress(a.payTo, { strict: false }) || /^0x0{40}$/i.test(a.payTo)) { problem = "invalid_pay_to"; continue; }
    const amountRaw = pr.version === 2 ? a.amount : a.maxAmountRequired;
    if (typeof amountRaw !== "string" || !/^\d{1,30}$/.test(amountRaw) || BigInt(amountRaw) <= 0n || BigInt(amountRaw) > MAX_UINT) { problem = "invalid_amount"; continue; }
    const timeout = Number(a.maxTimeoutSeconds);
    const mime = pr.version === 2 ? pr.resource?.mimeType : a.mimeType;
    return {
      offer: {
        version: pr.version,
        network: String(a.network),
        amount: BigInt(amountRaw),
        asset: getAddress(a.asset),
        payTo: getAddress(a.payTo),
        maxTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 120,
        mimeType: typeof mime === "string" && mime.trim() ? mime.trim().toLowerCase() : null,
        raw: a,
        resource: pr.resource,
      },
    };
  }
  return { problem };
}

export type SignedPayment = { header: [string, string]; nonce: Hex; validBefore: Date; from: Hex };

/** Sign the authorization for one offer. Valid for at most two minutes (or the seller's shorter timeout). */
export async function signPayment(ctx: Ctx, buyer: ToolsBuyer, offer: Offer, now = Date.now()): Promise<SignedPayment> {
  const nowS = BigInt(Math.floor(now / 1000));
  const ttl = BigInt(Math.max(10, Math.min(offer.maxTimeoutSeconds, 120)));
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const authorization = { from: buyer.address, to: offer.payTo, value: offer.amount, validAfter: nowS - 60n, validBefore: nowS + ttl, nonce };
  const domain = { name: ctx.cfg.chain.usdgDomain.name, version: ctx.cfg.chain.usdgDomain.version, chainId: ctx.cfg.chain.id, verifyingContract: getAddress(ctx.cfg.chain.usdg) };
  const signature = await buyer.signTypedData({ domain, types: X402_TYPES, primaryType: "TransferWithAuthorization", message: authorization } as never);
  const wire = { from: authorization.from, to: authorization.to, value: authorization.value.toString(), validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(), nonce };
  const payload = { signature, authorization: wire };
  const doc = offer.version === 2
    ? { x402Version: 2, ...(offer.resource ? { resource: offer.resource } : {}), accepted: offer.raw, payload }
    : { x402Version: 1, scheme: "exact", network: offer.network, payload };
  const value = Buffer.from(JSON.stringify(doc)).toString("base64");
  return { header: [offer.version === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT", value], nonce, validBefore: new Date(Number(authorization.validBefore) * 1000), from: buyer.address };
}

/** The seller's settlement answer (PAYMENT-RESPONSE or X-PAYMENT-RESPONSE). Only a well-formed transaction hash is kept. */
export function readPaymentResponse(headers: Headers): { success: boolean; transaction: Hex | null; network: string | null } | null {
  const doc = obj(decodeHeader(headers.get("payment-response") ?? headers.get("x-payment-response")));
  if (!doc) return null;
  const tx = typeof doc.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(doc.transaction) ? (doc.transaction.toLowerCase() as Hex) : null;
  return { success: doc.success === true, transaction: tx, network: typeof doc.network === "string" ? doc.network.slice(0, 64) : null };
}
