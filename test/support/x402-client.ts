import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { X402_TYPES } from "../../src/pay/x402.ts";

// What x402 clients send: a v1 X-PAYMENT and a v2 PAYMENT-SIGNATURE, each a base64 JSON payment for one requirement.

export type Req = { scheme: string; network: string; maxAmountRequired: string; resource: string; description: string; mimeType: string; payTo: Hex; maxTimeoutSeconds: number; asset: Hex; extra: { name: string; version: string; chainId: number } };

/** What an x402 client does: sign the requirement's EIP-3009 authorization and base64 it into X-PAYMENT. */
export async function xPayment(req: Req, o: { signer?: PrivateKeyAccount; from?: Hex; to?: Hex; value?: bigint; validAfter?: bigint; validBefore?: bigint; nonce?: Hex; network?: string; version?: number } = {}) {
  const signer = o.signer ?? privateKeyToAccount(generatePrivateKey());
  const authorization = {
    from: o.from ?? signer.address,
    to: o.to ?? req.payTo,
    value: o.value ?? BigInt(req.maxAmountRequired),
    validAfter: o.validAfter ?? 0n,
    validBefore: o.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
    nonce: o.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex),
  };
  const signature = await signer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: req.extra.chainId, verifyingContract: req.asset },
    types: X402_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const payload = { x402Version: o.version ?? 1, scheme: "exact", network: o.network ?? req.network, payload: { signature, authorization: { ...authorization, value: String(authorization.value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore) } } };
  return { header: Buffer.from(JSON.stringify(payload)).toString("base64"), signer, authorization };
}

export type V2Req = { scheme: string; network: string; amount: string; asset: Hex; payTo: Hex; maxTimeoutSeconds: number; extra: { name: string; version: string; chainId: number } };
export type V2Required = { x402Version: number; error: string; resource: { url: string; description: string; mimeType: string }; accepts: V2Req[] };
export const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const unb64 = (v: string | null) => JSON.parse(Buffer.from(v!, "base64").toString("utf8"));

/**
 * The v2 fixture: what an x402 v2 client sends in PAYMENT-SIGNATURE, a PaymentPayload with the resource, the requirement it
 * accepted (CAIP-2 network, `amount`) and the same EIP-3009 authorization as v1.
 */
export async function v2Payment(required: V2Required, o: { signer?: PrivateKeyAccount; value?: bigint; nonce?: Hex; network?: string } = {}) {
  const accepted = required.accepts[0];
  const signer = o.signer ?? privateKeyToAccount(generatePrivateKey());
  const authorization = {
    from: signer.address,
    to: accepted.payTo,
    value: o.value ?? BigInt(accepted.amount),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds),
    nonce: o.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex),
  };
  const signature = await signer.signTypedData({
    domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: accepted.extra.chainId, verifyingContract: accepted.asset },
    types: X402_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: { ...accepted, network: o.network ?? accepted.network },
    payload: { signature, authorization: { ...authorization, value: String(authorization.value), validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore) } },
    extensions: {},
  };
  return { header: b64(payload), signer, authorization };
}
