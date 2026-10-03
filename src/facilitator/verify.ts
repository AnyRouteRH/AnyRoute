import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { facilitatorSellers, facilitatorSettlements, sellerGasFloats } from "./schema.ts";

// x402 `exact` on Robinhood Chain, for any seller: the checks a facilitator runs on a payer's signed USDG EIP-3009
// TransferWithAuthorization before it relays it (settle.ts). x402 v1 and v2 differ only in where the scheme, network
// and amount sit; both are read into one shape here and verified by the same code. The router's own x402 path uses
// checkAuthorization() too, so a payment means the same thing wherever it is checked.

/** EIP-712 type of a USDG authorization (EIP-3009 TransferWithAuthorization). */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** An authorization must stay valid this long after it is checked, so the relay can land it. */
export const RELAY_MARGIN_S = 6n;

export type Authorization = { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
export type SignedAuthorization = { auth: Authorization; signature: Hex };

/** paymentRequirements, v1 or v2, in one shape. */
export type ExactRequirements = {
  x402Version: 1 | 2;
  scheme: string;
  network: string;
  amount: bigint;
  payTo: Hex;
  asset: Hex;
  maxTimeoutSeconds: number;
  resource: string | null;
  /** extra.facilitatorFee: the seller's statement of the fee authorization the payer signs to the treasury. */
  fee: { amount: bigint; payTo: Hex } | null;
};

/** paymentPayload, v1 or v2, in one shape. v2 carries what the payer accepted. */
export type ExactPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  resource: string | null;
  accepted: { amount: bigint | null; payTo: Hex | null; asset: Hex | null } | null;
  main: SignedAuthorization;
  /** payload.facilitatorFee: a second authorization from the payer to the treasury, used only when a fee is charged. */
  fee: SignedAuthorization | null;
};

export type VerifyResult = { isValid: true; payer: Hex; sellerId: string | null; floatSellerId: string | null; feeValue: bigint | null } | { isValid: false; invalidReason: string; payer: Hex | null };

/** A request the facilitator cannot read. `reason` is the x402 invalidReason/errorReason it answers with. */
export class FacilitatorInputError extends Error {
  constructor(readonly reason: "invalid_payload" | "invalid_payment_requirements" | "invalid_x402_version", message: string) {
    super(message);
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;
const isHex = (x: unknown, n: number): x is Hex => typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(x);
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
function uint(x: unknown): bigint | null {
  if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === "string" && /^\d{1,78}$/.test(x) && BigInt(x) <= MAX_UINT256) return BigInt(x);
  return null;
}
const lower = (a: string) => a.toLowerCase() as Hex;
export const caip2 = (chainId: number) => `eip155:${chainId}`;

function parseSigned(x: unknown, what: string): SignedAuthorization {
  const bad = (): never => {
    throw new FacilitatorInputError("invalid_payload", `${what} must be {signature, authorization{from,to,value,validAfter,validBefore,nonce}}.`);
  };
  const o = obj(x) ?? bad();
  const a = obj(o.authorization) ?? bad();
  const sig = o.signature;
  if (!isHex(a.from, 40) || !isHex(a.to, 40) || !isHex(a.nonce, 64)) bad();
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{2,8192}$/.test(sig) || sig.length % 2 !== 0) bad();
  const value = uint(a.value), validAfter = uint(a.validAfter), validBefore = uint(a.validBefore);
  if (value === null || validAfter === null || validBefore === null) bad();
  return { auth: { from: a.from as Hex, to: a.to as Hex, value: value!, validAfter: validAfter!, validBefore: validBefore!, nonce: lower(a.nonce as string) }, signature: sig as Hex };
}

/** Read paymentRequirements (v1: maxAmountRequired and resource; v2: amount). Either amount field is accepted in either version. */
export function parseRequirements(x: unknown, version: 1 | 2): ExactRequirements {
  const bad = (m: string): never => {
    throw new FacilitatorInputError("invalid_payment_requirements", m);
  };
  const r = obj(x) ?? bad("paymentRequirements must be an object.");
  const amount = uint(version === 2 ? (r.amount ?? r.maxAmountRequired) : (r.maxAmountRequired ?? r.amount));
  if (amount === null) bad(version === 2 ? "paymentRequirements.amount must be an integer string." : "paymentRequirements.maxAmountRequired must be an integer string.");
  if (typeof r.scheme !== "string" || typeof r.network !== "string" || r.network.length > 64) bad("paymentRequirements needs scheme and network.");
  if (!isHex(r.payTo, 40) || !isHex(r.asset, 40)) bad("paymentRequirements needs payTo and asset addresses.");
  const timeout = r.maxTimeoutSeconds === undefined ? 300 : Number(r.maxTimeoutSeconds);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) bad("paymentRequirements.maxTimeoutSeconds must be a positive integer.");
  if (r.resource !== undefined && (typeof r.resource !== "string" || r.resource.length > 2048)) bad("paymentRequirements.resource must be a URL.");
  let fee: ExactRequirements["fee"] = null;
  const f = obj(obj(r.extra)?.facilitatorFee);
  if (f) {
    const feeAmount = uint(f.amount);
    if (feeAmount === null || !isHex(f.payTo, 40)) bad("paymentRequirements.extra.facilitatorFee must be {amount, payTo}.");
    fee = { amount: feeAmount!, payTo: lower(f.payTo as string) };
  }
  return { x402Version: version, scheme: r.scheme as string, network: r.network as string, amount: amount!, payTo: lower(r.payTo as string), asset: lower(r.asset as string), maxTimeoutSeconds: timeout, resource: typeof r.resource === "string" ? r.resource : null, fee };
}

/** Read paymentPayload: v1 {x402Version, scheme, network, payload}, v2 {x402Version, resource?, accepted, payload}. */
export function parsePayload(x: unknown): ExactPayload {
  const bad = (m: string): never => {
    throw new FacilitatorInputError("invalid_payload", m);
  };
  const p = obj(x) ?? bad("paymentPayload must be an object.");
  const version = Number(p.x402Version);
  if (version !== 1 && version !== 2) throw new FacilitatorInputError("invalid_x402_version", "paymentPayload.x402Version must be 1 or 2.");
  const inner = obj(p.payload) ?? bad("paymentPayload.payload is missing.");
  const accepted = obj(p.accepted);
  const scheme = accepted?.scheme ?? p.scheme;
  const network = accepted?.network ?? p.network;
  if (typeof scheme !== "string" || typeof network !== "string") bad(version === 2 ? "paymentPayload.accepted needs scheme and network." : "paymentPayload needs scheme and network.");
  const resource = obj(p.resource)?.url ?? (typeof p.resource === "string" ? p.resource : null);
  return {
    x402Version: version,
    scheme: scheme as string,
    network: network as string,
    resource: typeof resource === "string" ? resource.slice(0, 2048) : null,
    accepted: accepted ? { amount: uint(accepted.amount ?? accepted.maxAmountRequired), payTo: isHex(accepted.payTo, 40) ? lower(accepted.payTo) : null, asset: isHex(accepted.asset, 40) ? lower(accepted.asset) : null } : null,
    main: parseSigned(inner, "paymentPayload.payload"),
    fee: inner.facilitatorFee === undefined ? null : parseSigned(inner.facilitatorFee, "paymentPayload.payload.facilitatorFee"),
  };
}

/** A facilitator /verify or /settle body: {x402Version?, paymentPayload, paymentRequirements}. */
export function parseFacilitatorRequest(body: unknown): { payload: ExactPayload; requirements: ExactRequirements } {
  const b = obj(body);
  if (!b) throw new FacilitatorInputError("invalid_payload", "The body must be {paymentPayload, paymentRequirements}.");
  const payload = parsePayload(b.paymentPayload);
  const requirements = parseRequirements(b.paymentRequirements, payload.x402Version as 1 | 2);
  return { payload, requirements };
}

/**
 * The checks every exact payment passes, whoever relays it: recipient, value, the time window (validBefore must
 * outlive the relay by RELAY_MARGIN_S), the payer's EIP-712 signature (ECDSA or ERC-1271) over USDG's own domain, the
 * nonce still unused on chain, and a balance that covers `needs` (default: the authorization's value).
 * Returns an x402 reason, or null when the authorization is good.
 */
export async function checkAuthorization(ctx: Pick<Ctx, "chain" | "cfg">, s: SignedAuthorization, o: { payTo: Hex; amount: bigint; needs?: bigint; domain?: { name: string; version: string } }): Promise<string | null> {
  const a = s.auth;
  if (a.to.toLowerCase() !== o.payTo.toLowerCase()) return "invalid_exact_evm_payload_recipient_mismatch";
  if (a.value < o.amount) return "invalid_exact_evm_payload_authorization_value";
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (a.validBefore < now + RELAY_MARGIN_S) return "invalid_exact_evm_payload_authorization_valid_before"; // must outlive the relay
  if (a.validAfter > now) return "invalid_exact_evm_payload_authorization_valid_after";
  const domain = o.domain ?? (await ctx.chain.usdgDomain());
  const typed = {
    domain: { name: domain.name, version: domain.version, chainId: ctx.cfg.chain.id, verifyingContract: ctx.cfg.chain.usdg },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: a,
  };
  if (!(await ctx.chain.verifyWalletSignature(a.from, typed, s.signature))) return "invalid_exact_evm_payload_signature";
  if (await ctx.chain.authorizationUsed(a.from, a.nonce)) return "invalid_exact_evm_payload_authorization_nonce_used";
  if ((await ctx.chain.usdgBalance(a.from)) < (o.needs ?? a.value)) return "insufficient_funds";
  return null;
}

/** The fee the facilitator charges on a payment of `amount` (rounded up), or 0 during the waiver. */
export const requiredFee = (ctx: Pick<Ctx, "cfg">, amount: bigint) => (ctx.cfg.facilitator.feeBps > 0 ? (amount * BigInt(ctx.cfg.facilitator.feeBps) + 9_999n) / 10_000n : 0n);

/** USDG units a settle's gas costs a seller's float: wei x (USDG per ETH) x buffer, rounded up. */
export function gasCostUnits(ctx: Pick<Ctx, "cfg">, gasWei: bigint): bigint {
  const gf = ctx.cfg.facilitator.gasFloat;
  if (!gf) return 0n;
  const den = 10n ** 18n * 10_000n;
  return (gasWei * gf.ethUsdg * BigInt(gf.bufferBps) + den - 1n) / den;
}

/** The seller listing a payment belongs to (exact resource first, then any listing of that payTo). */
export async function sellerFor(ctx: Pick<Ctx, "db">, payTo: Hex, resource: string | null) {
  const rows = await ctx.db
    .select({ id: facilitatorSellers.id, resource: facilitatorSellers.resource, balance: sellerGasFloats.balance })
    .from(facilitatorSellers)
    .leftJoin(sellerGasFloats, eq(sellerGasFloats.sellerId, facilitatorSellers.id))
    .where(eq(facilitatorSellers.payTo, payTo.toLowerCase()))
    .orderBy(desc(sql`${facilitatorSellers.resource} = ${resource ?? ""}`), desc(sql`coalesce(${sellerGasFloats.balance}, 0)`))
    .limit(1);
  return rows[0] ?? null;
}

/** Whether the network a requirement or payment names is Robinhood Chain: eip155:<id>, or for v1 the router's configured name. */
const networkOk = (ctx: Pick<Ctx, "cfg">, network: string, version: number) => network.toLowerCase() === caip2(ctx.cfg.chain.id) || (version === 1 && network === ctx.cfg.x402.network);

/**
 * Verify a payment for a seller without moving funds. `kind` "gas_float" is a seller topping up its gas float (payTo is
 * the treasury and no float or fee applies). `relayReady` is the caller's check of the relay's balance floor.
 */
export async function verifyExact(ctx: Ctx, p: ExactPayload, r: ExactRequirements, o: { kind?: "payment" | "gas_float"; relayReady: () => Promise<boolean> }): Promise<VerifyResult> {
  const payer = lower(p.main.auth.from);
  const no = (invalidReason: string): VerifyResult => ({ isValid: false, invalidReason, payer });
  const kind = o.kind ?? "payment";
  if (p.x402Version !== r.x402Version) return no("invalid_x402_version");
  if (p.scheme !== "exact" || r.scheme !== "exact") return no("unsupported_scheme");
  if (!networkOk(ctx, r.network, r.x402Version) || (p.network !== r.network && !networkOk(ctx, p.network, p.x402Version))) return no("invalid_network");
  if (r.asset !== lower(ctx.cfg.chain.usdg)) return no("invalid_payment_requirements");
  if (p.accepted) {
    if (p.accepted.payTo && p.accepted.payTo !== r.payTo) return no("invalid_exact_evm_payload_recipient_mismatch");
    if ((p.accepted.asset && p.accepted.asset !== r.asset) || (p.accepted.amount !== null && p.accepted.amount !== r.amount)) return no("invalid_payment_requirements");
  }
  if (r.payTo === "0x0000000000000000000000000000000000000000") return no("invalid_payment_requirements");
  // A relay below its gas floor refuses now rather than accept work it may not settle.
  if (!(await o.relayReady())) return no("facilitator_unavailable");

  const value = p.main.auth.value;
  const resource = r.resource ?? p.resource;
  const seller = kind === "payment" ? await sellerFor(ctx, r.payTo, resource) : null;
  // The fee rides as a second authorization to the treasury; with a 0 fee nothing is checked or relayed.
  const fee = kind === "payment" ? requiredFee(ctx, r.amount) : 0n;
  let feeValue: bigint | null = null;
  if (fee > 0n) {
    const treasury = ctx.cfg.facilitator.treasury!;
    if (!r.fee || r.fee.payTo !== treasury || r.fee.amount < fee || !p.fee) return no("facilitator_fee_required");
    const f = p.fee.auth;
    if (lower(f.from) !== payer || f.nonce === p.main.auth.nonce) return no("invalid_facilitator_fee");
    if (await checkAuthorization(ctx, p.fee, { payTo: treasury, amount: fee, needs: 0n })) return no("invalid_facilitator_fee");
    feeValue = f.value;
  }
  const reason = await checkAuthorization(ctx, p.main, { payTo: r.payTo, amount: r.amount, needs: value + (feeValue ?? 0n) });
  if (reason) return no(reason);
  // Durable claim: an authorization in flight or settled here is used, even before the chain shows it.
  const [claimed] = await ctx.db
    .select({ id: facilitatorSettlements.id })
    .from(facilitatorSettlements)
    .where(and(eq(facilitatorSettlements.payer, payer), eq(facilitatorSettlements.nonce, p.main.auth.nonce), inArray(facilitatorSettlements.status, ["verified", "settled"])))
    .limit(1);
  if (claimed) return no("invalid_exact_evm_payload_authorization_nonce_used");
  // Below the minimum, only a seller's prepaid gas float pays for the relay.
  let floatSellerId: string | null = null;
  if (value < ctx.cfg.facilitator.minSettle) {
    const gf = ctx.cfg.facilitator.gasFloat;
    if (kind !== "payment" || !gf || !seller) return no("payment_below_facilitator_minimum");
    const estimate = gasCostUnits(ctx, gf.settleGas * (await ctx.chain.gasPrice()) * (feeValue !== null ? 2n : 1n));
    if ((seller.balance ?? 0n) < estimate || (seller.balance ?? 0n) === 0n) return no("payment_below_facilitator_minimum");
    floatSellerId = seller.id;
  }
  return { isValid: true, payer, sellerId: seller?.id ?? null, floatSellerId, feeValue };
}

/** The address form x402 responses use for a payer. */
export const payerOut = (a: Hex | null) => (a ? getAddress(a) : "");
