import { getAddress, type Hex } from "viem";
import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";

// x402, `exact` scheme on Robinhood Chain: the payer signs a USDG EIP-3009 TransferWithAuthorization
// to X402_PAY_TO and sends it as `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2); the router verifies it, relays it
// (paying the gas) and serves the call. No contract sits in between: USDG moves from the payer straight to payTo.
//
// Both versions are read. A 402 carries the v1 JSON body and, beside it, the same requirement as a v2
// PaymentRequired in the `PAYMENT-REQUIRED` header; a settled call carries the same settlement in
// `X-PAYMENT-RESPONSE` (v1) and `PAYMENT-RESPONSE` (v2).
//
// Network naming: x402 v1 names chains with lowercase hyphenated strings ("base", "base-sepolia") from a fixed
// list that has no Robinhood Chain, while x402 v2 uses CAIP-2 ("eip155:4663"). The v1 body advertises
// X402_NETWORK (default "robinhood-chain"), the v2 header "eip155:<chain id>", and a payment may name either.
// `extra.chainId` carries the numeric chain id for clients that map a custom name to a chain themselves.

export const X402_VERSION = 1;
/** The x402 versions a payment may carry: v1 (`scheme`, `network` at the top) and v2 (`accepted` holds them). */
export const X402_VERSIONS: readonly number[] = [1, 2];

/** The payment a request carries: `X-PAYMENT` (x402 v1, and the CallPay retry) or `PAYMENT-SIGNATURE` (x402 v2). */
export const paymentHeaderOf = (c: Context) => c.req.header("x-payment") ?? c.req.header("payment-signature");

/** EIP-712 type of the USDG authorization (EIP-3009 TransferWithAuthorization). */
export const X402_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type X402Requirement = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Hex;
  maxTimeoutSeconds: number;
  asset: Hex;
  extra: { name: string; version: string; chainId: number };
};
export type X402Authorization = { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
export type X402Payment = { version: number; scheme: string; network: string; signature: Hex; auth: X402Authorization };

/** x402 is on when a payTo address is configured and the router role can relay (pay gas). */
export const x402Enabled = (ctx: Ctx) => !!ctx.cfg.x402.payTo && !!ctx.chain.roleAddress("router");

export async function x402Requirement(ctx: Ctx, o: { priceUsdg: bigint; resource: string; description: string }): Promise<X402Requirement> {
  const domain = await ctx.chain.usdgDomain();
  return {
    scheme: "exact",
    network: ctx.cfg.x402.network,
    maxAmountRequired: o.priceUsdg.toString(),
    resource: o.resource,
    description: o.description,
    mimeType: "application/json",
    payTo: getAddress(ctx.cfg.x402.payTo!),
    maxTimeoutSeconds: ctx.cfg.fees.quoteTtlS,
    asset: getAddress(ctx.cfg.chain.usdg),
    extra: { name: domain.name, version: domain.version, chainId: ctx.cfg.chain.id },
  };
}

/** The x402 PaymentRequirementsResponse body. `error` is a string, as x402 clients expect. */
export const x402Body = (error: string, accepts: X402Requirement[], extra: Record<string, unknown> = {}) => ({ x402Version: X402_VERSION, error, accepts, ...extra });

const base64Json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** The same requirements as an x402 v2 PaymentRequired: `amount` for maxAmountRequired, the resource apart, the CAIP-2 network. */
export function x402RequiredV2(error: string, accepts: X402Requirement[]) {
  const first = accepts[0];
  return {
    x402Version: 2,
    error,
    resource: { url: first.resource, description: first.description, mimeType: first.mimeType },
    accepts: accepts.map((r) => ({ scheme: r.scheme, network: `eip155:${r.extra.chainId}`, amount: r.maxAmountRequired, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra })),
  };
}

/** Headers of a 402 that asks for an x402 payment: `PAYMENT-REQUIRED` (base64 JSON, v2) beside the v1 JSON body. */
export const x402RequiredHeaders = (error: string, accepts: X402Requirement[]): Record<string, string> => (accepts.length ? { "payment-required": base64Json(x402RequiredV2(error, accepts)) } : {});

/** Value of the settlement headers: base64 JSON {success, transaction, network, payer}. */
export const x402ResponseHeader = (r: { transaction: string; network: string; payer: string }) => base64Json({ success: true, ...r });

/** A settled call carries the same settlement in `X-PAYMENT-RESPONSE` (v1) and `PAYMENT-RESPONSE` (v2). */
export const x402ResponseHeaders = (value: string): Record<string, string> => ({ "x-payment-response": value, "payment-response": value });

/** A failed settlement, as x402 v2 reports it in `PAYMENT-RESPONSE` on the 402. */
export const x402FailureHeader = (r: { errorReason: string; network: string; payer: string }): Record<string, string> => ({ "payment-response": base64Json({ success: false, transaction: "", ...r }) });

const MAX_UINT256 = (1n << 256n) - 1n;

/** Read the decoded X-PAYMENT or PAYMENT-SIGNATURE JSON (v1, or v2 with `accepted`). Malformed payloads are a 400. */
export function parseX402(j: any): X402Payment {
  const bad = (): never => fail(400, "The payment is not a valid x402 `exact` payload (payload.signature and payload.authorization{from,to,value,validAfter,validBefore,nonce}).", "invalid_payment");
  const a = j?.payload?.authorization;
  const sig = j?.payload?.signature;
  const isHex = (x: unknown, n: number) => typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(x);
  const uint = (x: unknown): bigint => {
    if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
    if (typeof x === "string" && /^\d{1,78}$/.test(x) && BigInt(x) <= MAX_UINT256) return BigInt(x);
    return bad();
  };
  if (!a || typeof a !== "object" || !isHex(a.from, 40) || !isHex(a.to, 40) || !isHex(a.nonce, 64)) bad();
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{2,8192}$/.test(sig) || sig.length % 2 !== 0) bad();
  // v2 moves scheme and network into `accepted`, the requirement the payer chose.
  const chosen = j.accepted && typeof j.accepted === "object" ? j.accepted : j;
  return {
    version: Number(j.x402Version),
    scheme: String(chosen.scheme),
    network: String(chosen.network),
    signature: sig as Hex,
    auth: { from: a.from, to: a.to, value: uint(a.value), validAfter: uint(a.validAfter), validBefore: uint(a.validBefore), nonce: a.nonce },
  };
}

/** Verify a payment against the requirement without moving funds. Returns an x402 error reason, or null when valid. */
export async function verifyX402(ctx: Ctx, p: X402Payment, req: X402Requirement): Promise<string | null> {
  const a = p.auth;
  if (!X402_VERSIONS.includes(p.version)) return "invalid_x402_version";
  if (p.scheme !== req.scheme) return "unsupported_scheme";
  if (p.network !== req.network && p.network.toLowerCase() !== `eip155:${ctx.cfg.chain.id}`) return "invalid_network";
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return "invalid_exact_evm_payload_recipient_mismatch";
  if (a.value < BigInt(req.maxAmountRequired)) return "invalid_exact_evm_payload_authorization_value";
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (a.validBefore < now + 6n) return "invalid_exact_evm_payload_authorization_valid_before"; // must outlive the relay
  if (a.validAfter > now) return "invalid_exact_evm_payload_authorization_valid_after";
  const typed = {
    domain: { name: req.extra.name, version: req.extra.version, chainId: ctx.cfg.chain.id, verifyingContract: ctx.cfg.chain.usdg },
    types: X402_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: a,
  };
  if (!(await ctx.chain.verifyWalletSignature(a.from, typed, p.signature))) return "invalid_exact_evm_payload_signature";
  if (await ctx.chain.authorizationUsed(a.from, a.nonce)) return "invalid_exact_evm_payload_authorization_nonce_used";
  if ((await ctx.chain.usdgBalance(a.from)) < a.value) return "insufficient_funds";
  return null;
}
