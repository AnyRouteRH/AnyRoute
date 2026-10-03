import { sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import type { Settlement } from "./ledger.ts";

// Where settlements come from, one source per receipt kind. "model.call" (x402 per-call payments for model calls) is
// built in. Other kinds plug in by registering a source that reads their own records:
//
//   registerCommerceSource({ kind: "tool.call", read: async (ctx, since, until) => [...settlements] });
//
// A source reports each settlement in (since, until] with its payer, payee, USDG amount, time, whether every receipt for
// it is in a root confirmed on ReceiptAnchor, whether it was refunded, the owner key behind each side when known, and its
// transaction hash when it moved on chain. Rows never leave the router: the ledger publishes only aggregates.

export type CommerceSource = { kind: string; read(ctx: Ctx, since: Date, until: Date): Promise<Settlement[]> };

const registry = new Map<string, CommerceSource>();

/** Add (or replace) the source for a receipt kind. Returns a function that removes it again. */
export function registerCommerceSource(source: CommerceSource): () => void {
  registry.set(source.kind, source);
  return () => {
    if (registry.get(source.kind) === source) registry.delete(source.kind);
  };
}

/** Every source: the registered ones, and the built-in model-call source unless one replaced it. */
export const commerceSources = (): CommerceSource[] => [...(registry.has(modelCallSource.kind) ? [] : [modelCallSource]), ...registry.values()];

/** Wallets the operator controls: x402 payTo, the router's signing roles, treasuries and COMMERCE_OPERATOR_ADDRESSES. */
export function operatorAddresses(ctx: Ctx): Set<string> {
  const roles = ["router", "settlement", "anchorer", "slasher", "keeper", "ipx"] as const;
  const out = [ctx.cfg.x402.payTo, ctx.cfg.chain.callPayTreasury, ctx.cfg.escrow.address, ...roles.map((r) => ctx.chain.roleAddress(r as never)), ...ctx.cfg.commerce.operators];
  return new Set(out.filter((a): a is `0x${string}` => !!a).map((a) => a.toLowerCase()));
}

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? r) as T[];

/**
 * model.call: x402 payments the router settled for model calls (quotes "x402:<payer>:<nonce>", status used). The amount
 * is the authorization's full value as credited (what moved on chain), the payee is X402_PAY_TO. Anchored means the call
 * produced at least one receipt and every receipt it produced is in a confirmed ReceiptAnchor root; a payment whose call
 * failed before any receipt is unanchored. Refunded means a refund ledger entry names one of its generations.
 */
export const modelCallSource: CommerceSource = {
  kind: "model.call",
  async read(ctx, since, until) {
    const slack = 3_600_000;
    const lo = new Date(since.getTime() - slack).toISOString();
    const hi = new Date(until.getTime() + slack).toISOString();
    const result = await ctx.db.execute(sql`
      with s as (
        select q.payer, q.tx_hash, q.created_at, q.price_usdg from quotes q
        where q.status = 'used' and q.nonce like 'x402:%' and q.tx_hash is not null and q.payer is not null
          and q.created_at > ${since.toISOString()} and q.created_at <= ${until.toISOString()}
      ), g as (
        select g.id, g.payment_tx, g.receipt_leaf, a.status as anchor_status
        from generations g left join anchors a on a.index = g.anchor_index
        where g.mode = 'per_call' and g.payment_tx in (select tx_hash from s) and g.ts > ${lo} and g.ts <= ${hi}
      ), r as (
        select distinct l.generation_id from ledger l where l.kind = 'refund' and l.generation_id in (select id from g)
      )
      select s.payer, s.tx_hash,
        (extract(epoch from s.created_at) * 1000)::bigint::text as at_ms,
        coalesce((select (l.amount / 1000000)::text from ledger l where l.ref = 'x402:' || s.tx_hash), s.price_usdg::text) as amount,
        (select count(*) from g where g.payment_tx = s.tx_hash)::int as receipts,
        (select count(*) from g where g.payment_tx = s.tx_hash and g.receipt_leaf is not null and g.anchor_status = 'confirmed')::int as anchored,
        exists (select 1 from g join r on r.generation_id = g.id where g.payment_tx = s.tx_hash) as refunded
      from s`);
    const payee = ctx.cfg.x402.payTo?.toLowerCase() ?? "x402:pay-to";
    return rowsOf<{ payer: string; tx_hash: string; at_ms: string; amount: string; receipts: number; anchored: number; refunded: boolean }>(result).map((r) => {
      const payer = r.payer.toLowerCase();
      return {
        kind: "model.call",
        payer,
        payee,
        amountUsdg: BigInt(r.amount),
        at: new Date(Number(r.at_ms)),
        anchored: Number(r.receipts) > 0 && Number(r.anchored) === Number(r.receipts),
        refunded: r.refunded === true || (r.refunded as unknown) === "t",
        payerOwner: null,
        payeeOwner: null,
        txHash: r.tx_hash.toLowerCase(),
      };
    });
  },
};
