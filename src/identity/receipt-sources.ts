import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { generations, ledger, providers } from "../db/schema.ts";
import { agreementProjection } from "../agreements/schema.ts";
import { agreementScope, type Agreement } from "../agreements/state.ts";
import { walletAccountId } from "../api/auth.ts";
import { usdgToPico } from "../lib/money.ts";

// Paid receipts that can back feedback. A source turns a receipt id of its kind into who paid, who was paid or served,
// how much and when. Feedback is accepted only when the reviewer's account is the payer and the subject agent is a
// payee or the agent served. Other features register their own kinds (for example tool calls or job releases) with
// registerReceiptSource; an unknown kind is refused, never guessed.

export type PaidReceipt = {
  kind: string;
  id: string;
  /** The paying account; null when the receipt names no linkable payer (blind tokens, the unlinkable lane). */
  payerAccountId: string | null;
  /** Accounts and keys that were paid or served under this receipt. */
  payee: { accountIds: string[]; keyHashes: string[] };
  /** What the payer paid, net of refunds recorded against this receipt. */
  paidPico: bigint;
  at: Date;
};

export type ReceiptSource = { kind: string; resolve(ctx: Ctx, id: string): Promise<PaidReceipt | null> };

const sources = new Map<string, ReceiptSource>();
export function registerReceiptSource(source: ReceiptSource) {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(source.kind)) throw new Error(`Receipt kind ${source.kind} must look like "noun.verb".`);
  sources.set(source.kind, source);
}
export const receiptKinds = () => [...sources.keys()].sort();

/** The receipt of that kind, or (without a kind) the first registered kind that knows the id. */
export async function resolvePaidReceipt(ctx: Ctx, id: string, kind?: string): Promise<PaidReceipt | null> {
  if (kind) {
    const source = sources.get(kind);
    return source ? source.resolve(ctx, id) : null;
  }
  for (const name of receiptKinds()) {
    const found = await sources.get(name)!.resolve(ctx, id);
    if (found) return found;
  }
  return null;
}
export const knownReceiptKind = (kind: string) => sources.has(kind);

/** Refunds the ledger records against one generation (positive amounts credited back to the payer). */
async function refundedPico(ctx: Ctx, generationId: string) {
  const [row] = await ctx.db.select({ n: sql<string>`coalesce(sum(${ledger.amount}), 0)` }).from(ledger).where(and(eq(ledger.generationId, generationId), eq(ledger.kind, "refund")));
  const n = BigInt(row?.n ?? 0);
  return n > 0n ? n : 0n;
}

// A model call through the router: the calling account paid; the payee is the operator of the network host that
// served it. Calls answered by the router's own upstream providers have no agent payee and back no feedback.
registerReceiptSource({
  kind: "model.call",
  async resolve(ctx, id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const [g] = await ctx.db.select({ id: generations.id, accountId: generations.accountId, cost: generations.cost, ts: generations.ts, providerId: generations.providerId, mode: generations.mode, receiptId: generations.receiptId })
      .from(generations).where(eq(generations.id, id));
    if (!g || !g.receiptId) return null;
    const [host] = await ctx.db.select({ operator: providers.operator, networkHost: providers.networkHost }).from(providers).where(eq(providers.id, g.providerId));
    const operator = host?.networkHost && host.operator && /^0x[0-9a-fA-F]{40}$/.test(host.operator) ? host.operator : null;
    const paid = g.cost - await refundedPico(ctx, g.id);
    return { kind: "model.call", id: g.id, payerAccountId: g.mode === "blind" ? null : g.accountId, payee: { accountIds: operator ? [walletAccountId(operator)] : [], keyHashes: [] }, paidPico: paid > 0n ? paid : 0n, at: g.ts };
  },
});

// A milestone of an indexed USDG agreement that settled with a payment to the payee: <agreement id>.<milestone>.
registerReceiptSource({
  kind: "agreement.release",
  async resolve(ctx, id) {
    if (!ctx.cfg.agreements.enabled || !/^\d{1,78}\.\d{1,3}$/.test(id)) return null;
    const [row] = await ctx.db.select({ data: agreementProjection.data }).from(agreementProjection)
      .where(and(eq(agreementProjection.scope, agreementScope(ctx.cfg)), eq(agreementProjection.kind, "agreement"), eq(agreementProjection.id, id)));
    const a = row?.data as Agreement | undefined;
    if (!a || !a.payer || !a.payee || !a.payeeAmount || !a.resolvedAt || (a.state !== "released" && a.state !== "resolved")) return null;
    const paid = usdgToPico(BigInt(a.payeeAmount));
    if (paid <= 0n) return null;
    return { kind: "agreement.release", id, payerAccountId: walletAccountId(a.payer), payee: { accountIds: [walletAccountId(a.payee)], keyHashes: [] }, paidPico: paid, at: new Date(a.resolvedAt * 1000) };
  },
});
