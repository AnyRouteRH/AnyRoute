import { and, eq, sql } from "drizzle-orm";
import { getAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { log, uid } from "../lib/util.ts";
import type { KindClaims } from "../receipts/v2.ts";
import { facilitatorSettlements, sellerGasFloats } from "./schema.ts";
import { caip2, gasCostUnits, verifyExact, type ExactPayload, type ExactRequirements, type SignedAuthorization } from "./verify.ts";

// Settlement: relay the payer's authorization with transferWithAuthorization, so USDG moves straight from the payer to the
// seller's payTo. The facilitator never holds seller funds; its relay key (FACILITATOR_RELAY_PRIVATE_KEY, no other role)
// only pays gas. Every settle that passed verification leaves a row whose (payer, nonce) is the durable claim, and every
// settled one a COSE receipt of kind "facilitator.settle" that joins the hourly anchor (services/anchor.ts).

export type SettleResult = {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer: string;
  receipt?: { id: string; url: string };
  /** HTTP status the route answers with: 200 for an x402 outcome, 503 when the relay refuses. */
  http: 200 | 503;
};

/** Relay one signed authorization with the given role's key. The relayer pays gas; the value goes from `from` to `to`. */
export function relayExact(ctx: Pick<Ctx, "chain">, s: SignedAuthorization, role: "router" | "facilitator") {
  return ctx.chain.transferWithAuthorization({ ...s.auth, signature: s.signature }, role);
}

// The last relay balance reading per router, for /api/v1/status: whether it was above the floor and when it was taken.
const relayChecks = new WeakMap<object, { ok: boolean; at: Date }>();
export const lastRelayCheck = (ctx: Pick<Ctx, "chain">) => relayChecks.get(ctx.chain) ?? null;

/** Whether the relay key holds at least its balance floor of native gas. Below it the facilitator refuses; it never queues. */
export async function relayReady(ctx: Ctx): Promise<boolean> {
  const relay = ctx.chain.roleAddress("facilitator");
  if (!relay) return false;
  let ok = false;
  try {
    ok = (await ctx.chain.nativeBalance(relay)) >= ctx.cfg.facilitator.relayFloorWei;
  } catch {
    ok = false; // an unreadable balance is not a ready relay
  }
  const before = relayChecks.get(ctx.chain);
  relayChecks.set(ctx.chain, { ok, at: new Date() });
  // Logged when the state changes, not on every refused request.
  if (!ok && before?.ok !== false) log.warn("facilitator relay below its balance floor; refusing settlements", { floor_wei: ctx.cfg.facilitator.relayFloorWei });
  if (ok && before?.ok === false) log.info("facilitator relay back above its balance floor");
  return ok;
}

/** Claim (payer, nonce): a fresh row, or a failed attempt whose authorization the chain still shows unused. */
async function claim(ctx: Ctx, row: typeof facilitatorSettlements.$inferInsert): Promise<string | null> {
  const inserted = await ctx.db.insert(facilitatorSettlements).values(row).onConflictDoNothing().returning({ id: facilitatorSettlements.id });
  if (inserted.length) return inserted[0].id;
  const [prior] = await ctx.db.select().from(facilitatorSettlements).where(and(eq(facilitatorSettlements.payer, row.payer), eq(facilitatorSettlements.nonce, row.nonce)));
  if (!prior || prior.status !== "failed") return null;
  if (await ctx.chain.authorizationUsed(row.payer as Hex, row.nonce as Hex)) return null;
  const retried = await ctx.db
    .update(facilitatorSettlements)
    .set({ status: "verified", error: null, kind: row.kind, payTo: row.payTo, value: row.value, sellerId: row.sellerId, x402Version: row.x402Version, feeValue: row.feeValue })
    .where(and(eq(facilitatorSettlements.id, prior.id), eq(facilitatorSettlements.status, "failed")))
    .returning({ id: facilitatorSettlements.id });
  return retried[0]?.id ?? null;
}

/**
 * Verify, claim, relay and record one payment. `kind` "gas_float" is a seller's top-up of its gas float (payTo is the
 * treasury, `floatSellerId` the listing credited). A refused or failed settle moves nothing twice: the claim is durable.
 */
export async function settleExact(ctx: Ctx, p: ExactPayload, r: ExactRequirements, o: { kind?: "payment" | "gas_float"; floatSellerId?: string } = {}): Promise<SettleResult> {
  const kind = o.kind ?? "payment";
  const payer = getAddress(p.main.auth.from);
  const out = (errorReason: string, http: 200 | 503 = 200): SettleResult => ({ success: false, errorReason, transaction: "", network: r.network, payer, http });
  const v = await verifyExact(ctx, p, r, { kind, relayReady: () => relayReady(ctx) });
  if (!v.isValid) return out(v.invalidReason, v.invalidReason === "facilitator_unavailable" ? 503 : 200);
  const a = p.main.auth;
  const id = await claim(ctx, {
    id: uid("fst_"),
    kind,
    payer: v.payer,
    payTo: a.to.toLowerCase(),
    value: a.value,
    nonce: a.nonce,
    status: "verified",
    sellerId: kind === "gas_float" ? (o.floatSellerId ?? null) : v.sellerId,
    x402Version: r.x402Version,
    feeValue: v.feeValue,
  });
  if (!id) return out("invalid_exact_evm_payload_authorization_nonce_used");

  let main: Awaited<ReturnType<typeof relayExact>>;
  try {
    main = await relayExact(ctx, p.main, "facilitator");
  } catch (e) {
    await ctx.db.update(facilitatorSettlements).set({ status: "failed", error: "relay_failed" }).where(eq(facilitatorSettlements.id, id));
    log.warn("facilitator settlement failed", { settlement: id, error: (e as Error).message.split("\n")[0].slice(0, 200) });
    return out("unexpected_settle_error");
  }
  const tx = main.hash.toLowerCase() as Hex;
  let gasWei = (main.gasUsed ?? 0n) * (main.effectiveGasPrice ?? 0n);
  // The fee is a second, separate authorization to the treasury. The seller is paid either way; a failed fee is logged.
  let feeTx: Hex | null = null;
  if (v.feeValue !== null && p.fee) {
    try {
      const f = await relayExact(ctx, p.fee, "facilitator");
      feeTx = f.hash.toLowerCase() as Hex;
      gasWei += (f.gasUsed ?? 0n) * (f.effectiveGasPrice ?? 0n);
    } catch (e) {
      log.warn("facilitator fee relay failed after the payment settled", { settlement: id, error: (e as Error).message.split("\n")[0].slice(0, 200) });
    }
  }
  const gf = ctx.cfg.facilitator.gasFloat;
  if (gf && v.floatSellerId && gasWei === 0n) gasWei = gf.settleGas * (await ctx.chain.gasPrice().catch(() => 0n)); // no measurement: the estimate
  const debit = v.floatSellerId ? gasCostUnits(ctx, gasWei) : null;

  const settledAt = new Date();
  const claims: KindClaims = {
    v: 2,
    kind: "facilitator.settle",
    rid: id,
    iat: Math.floor(settledAt.getTime() / 1000),
    iss: ctx.cfg.publicUrl,
    network: caip2(ctx.cfg.chain.id),
    asset: ctx.cfg.chain.usdg.toLowerCase(),
    tx,
    value: a.value.toString(),
    pay_to: a.to.toLowerCase(),
    purpose: kind,
    x402_version: r.x402Version,
    ...(feeTx && v.feeValue !== null ? { fee: { value: v.feeValue.toString(), tx: feeTx } } : {}),
  };
  try {
    const signed = ctx.signer.signCose(claims);
    await ctx.db.transaction(async (t) => {
      let charged: bigint | null = null;
      if (v.floatSellerId && debit !== null) {
        // Measured gas x buffer, never more than the float holds.
        const [f] = await t.select({ balance: sellerGasFloats.balance, debited: sellerGasFloats.debited }).from(sellerGasFloats).where(eq(sellerGasFloats.sellerId, v.floatSellerId)).for("update");
        if (f) {
          charged = f.balance < debit ? f.balance : debit;
          await t.update(sellerGasFloats).set({ balance: f.balance - charged, debited: f.debited + charged, updatedAt: settledAt }).where(eq(sellerGasFloats.sellerId, v.floatSellerId));
        }
      }
      if (kind === "gas_float" && o.floatSellerId) {
        await t
          .insert(sellerGasFloats)
          .values({ sellerId: o.floatSellerId, balance: a.value, funded: a.value, updatedAt: settledAt })
          .onConflictDoUpdate({ target: sellerGasFloats.sellerId, set: { balance: sql`${sellerGasFloats.balance} + ${a.value.toString()}::numeric`, funded: sql`${sellerGasFloats.funded} + ${a.value.toString()}::numeric`, updatedAt: settledAt } });
      }
      await t
        .update(facilitatorSettlements)
        .set({ status: "settled", txHash: tx, feeTxHash: feeTx, gasDebit: charged, settledAt, receiptCose: signed.cose.toString("base64"), receiptLeaf: signed.leaf, receiptKeyId: signed.keyId })
        .where(eq(facilitatorSettlements.id, id));
    });
  } catch (e) {
    // The transfer is final on chain; keep what is needed to repair the record by hand.
    log.error("facilitator settlement relayed but not recorded", { settlement: id, tx, error: (e as Error).message });
  }
  return { success: true, transaction: tx, network: r.network, payer, receipt: { id, url: `${ctx.cfg.publicUrl}/facilitator/receipts/${id}` }, http: 200 };
}
