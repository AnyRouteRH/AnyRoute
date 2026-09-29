import { getAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";

// x402 v1, `exact` scheme on Robinhood Chain: the payer signs a USDG EIP-3009 TransferWithAuthorization
// to X402_PAY_TO and sends it as `X-PAYMENT`; the router verifies it, relays it (paying the gas) and
// serves the call. No contract sits in between: USDG moves from the payer straight to payTo.
//
// Network naming: x402 v1 names chains with lowercase hyphenated strings ("base", "base-sepolia") from a fixed
// list that has no Robinhood Chain, while x402 v2 uses CAIP-2 ("eip155:4663"). We advertise
// X402_NETWORK (default "robinhood-chain") and accept either that or "eip155:<chain id>" in the payment.
// `extra.chainId` carries the numeric chain id for clients that map a custom name to a chain themselves.

export const X402_VERSION = 1;

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

/** Value of the X-PAYMENT-RESPONSE header: base64 JSON {success, transaction, network, payer}. */
export const x402ResponseHeader = (r: { transaction: string; network: string; payer: string }) => Buffer.from(JSON.stringify({ success: true, ...r })).toString("base64");

const MAX_UINT256 = (1n << 256n) - 1n;

/** Read the decoded X-PAYMENT JSON. Malformed payloads are a 400. */
export function parseX402(j: any): X402Payment {
  const bad = (): never => fail(400, "X-PAYMENT is not a valid x402 `exact` payload (payload.signature and payload.authorization{from,to,value,validAfter,validBefore,nonce}).", "invalid_payment");
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
  return {
    version: Number(j.x402Version),
    scheme: String(j.scheme),
    network: String(j.network),
    signature: sig as Hex,
    auth: { from: a.from, to: a.to, value: uint(a.value), validAfter: uint(a.validAfter), validBefore: uint(a.validBefore), nonce: a.nonce },
  };
}

/** Verify a payment against the requirement without moving funds. Returns an x402 error reason, or null when valid. */
export async function verifyX402(ctx: Ctx, p: X402Payment, req: X402Requirement): Promise<string | null> {
  const a = p.auth;
  if (p.version !== X402_VERSION) return "invalid_x402_version";
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
