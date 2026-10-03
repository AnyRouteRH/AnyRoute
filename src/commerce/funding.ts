import { eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { chainCursor } from "../db/schema.ts";
import { commerceTransfers } from "./schema.ts";
import type { FundingView } from "./ledger.ts";

// Funding-source links for the commerce ledger, from public USDG transfers only.
//
// A funding edge is a USDG Transfer from one wallet to another of at least COMMERCE_FUNDING_MIN_UNITS that is not
// itself a settlement: not one of the settlements being counted, and not any EIP-3009 authorized transfer to the x402
// payTo or relayed by the router or a COMMERCE_RELAYER_ADDRESSES wallet, at any time (so a customer who paid last
// year never counts as funding the seller). Walking edges backwards from a wallet gives its funders, their funders, and
// so on. Payer P and payee Q are linked within N hops when one of them is among the other's funders within N transfers,
// or when a wallet funded both and the two paths add up to at most N transfers. Hubs (the zero address that mints, the
// USDG contract, the router's contracts, configured hubs and any wallet that funded more than COMMERCE_HUB_FANOUT
// distinct wallets) never link two wallets as a shared funder or as a stop on a path; they can still be P or Q
// themselves. integrations/dune/commerce.sql applies the same rules to the chain's own logs.

export const COMMERCE_CURSOR = "commerce-usdg";
const ZERO = "0x0000000000000000000000000000000000000000";

/** Funders of `start` up to `hops` transfers back, with their distance. Paths never pass through a hub. */
export function ancestors(start: string, hops: number, fundersOf: (a: string) => Iterable<string>, isHub: (a: string) => boolean): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier = [start];
  for (let d = 1; d <= hops && frontier.length; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      if (node !== start && isHub(node)) continue;
      for (const f of fundersOf(node)) {
        if (f === start || dist.has(f)) continue;
        dist.set(f, d);
        next.push(f);
      }
    }
    frontier = next;
  }
  return dist;
}

/** Linked within `hops`: either side funded the other, or a non-hub wallet funded both within `hops` transfers in total. */
export function linkedWithin(a: string, b: string, hops: number, fundersOf: (a: string) => Iterable<string>, isHub: (a: string) => boolean): boolean {
  if (a === b) return true;
  const A = ancestors(a, hops, fundersOf, isHub);
  if (A.has(b)) return true;
  const B = ancestors(b, hops, fundersOf, isHub);
  if (B.has(a)) return true;
  for (const [x, da] of A) {
    const db = B.get(x);
    if (db !== undefined && !isHub(x) && da + db <= hops) return true;
  }
  return false;
}

export type FundingData = {
  /** Funding edges as to -> set of from. */
  funders: Map<string, Set<string>>;
  hubs: Set<string>;
  /** Plain transfers (any positive value, settlements excluded) payee -> payer, with their times. */
  returns: { from: string; to: string; at: number }[];
};

export function fundingView(data: FundingData, hops: number): FundingView {
  const fundersOf = (a: string) => data.funders.get(a) ?? [];
  const isHub = (a: string) => data.hubs.has(a);
  const memo = new Map<string, boolean>();
  return {
    linked(a, b) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      let v = memo.get(k);
      if (v === undefined) memo.set(k, (v = linkedWithin(a, b, hops, fundersOf, isHub)));
      return v;
    },
    returned: (from, to, at, withinMs) => data.returns.some((r) => r.from === from && r.to === to && Math.abs(r.at - at.getTime()) <= withinMs),
  };
}

const list = (values: Iterable<string>) => sql`(select jsonb_array_elements_text(${JSON.stringify([...values])}::jsonb))`;

export type FundingState = { view: FundingView; indexedBlock: bigint; indexedAt: Date } | null;

/**
 * Read the funding edges around these wallets from the transfer index. Null when the index is off or has not read a
 * block yet, so the caller can say the filter is unavailable instead of claiming it found nothing.
 */
export async function loadFunding(ctx: Ctx, o: { payers: string[]; payees: string[]; settlementTxs: string[]; since: Date }): Promise<FundingState> {
  const f = ctx.cfg.commerce.funding;
  if (f.fromBlock === null) return null;
  const [cursor] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, COMMERCE_CURSOR));
  if (!cursor) return null;
  const t = commerceTransfers;
  const recipients = ctx.cfg.x402.payTo ? [ctx.cfg.x402.payTo.toLowerCase()] : [];
  const relayers = [ctx.chain.roleAddress("router" as never), ...ctx.cfg.commerce.relayers].flatMap((a) => (a ? [a.toLowerCase()] : []));
  const notSettlement = sql`${t.txHash} not in ${list(o.settlementTxs)} and not (${t.authorized} and (${t.toAddress} in ${list(recipients)} or coalesce(${t.txFrom}, '') in ${list(relayers)}))`;
  const material = sql`${t.valueUsdg} >= ${f.minUnits} and ${t.fromAddress} <> ${t.toAddress} and ${notSettlement}`;
  const contracts = Object.values(ctx.chain.status().contracts).flatMap((a) => (a ? [String(a).toLowerCase()] : []));
  const hubs = new Set([ZERO, ctx.cfg.chain.usdg.toLowerCase(), ...contracts, ...f.hubs]);
  const fanoutKnown = new Set<string>();
  const funders = new Map<string, Set<string>>();
  // Level by level: funders of the frontier, then the fan-out of every new funder, then expand only the non-hubs.
  let frontier = [...new Set([...o.payers, ...o.payees])];
  const seen = new Set(frontier);
  for (let d = 1; d <= f.hops && frontier.length; d++) {
    const rows = await ctx.db.select({ from: t.fromAddress, to: t.toAddress }).from(t).where(sql`${t.toAddress} in ${list(frontier)} and ${material}`);
    const fresh: string[] = [];
    for (const r of rows) {
      let s = funders.get(r.to);
      if (!s) funders.set(r.to, (s = new Set()));
      s.add(r.from);
      if (!seen.has(r.from)) {
        seen.add(r.from);
        fresh.push(r.from);
      }
    }
    const unknown = [...new Set(rows.map((r) => r.from))].filter((a) => !fanoutKnown.has(a));
    if (unknown.length) {
      const fan = await ctx.db
        .select({ from: t.fromAddress, n: sql<number>`count(distinct ${t.toAddress})::int` })
        .from(t)
        .where(sql`${t.fromAddress} in ${list(unknown)} and ${material}`)
        .groupBy(t.fromAddress);
      for (const r of fan) if (r.n > f.hubFanout) hubs.add(r.from);
      for (const a of unknown) fanoutKnown.add(a);
    }
    frontier = fresh.filter((a) => !hubs.has(a));
  }
  const returns = o.payers.length && o.payees.length
    ? await ctx.db
        .select({ from: t.fromAddress, to: t.toAddress, at: t.blockTime })
        .from(t)
        .where(sql`${t.fromAddress} in ${list(o.payees)} and ${t.toAddress} in ${list(o.payers)} and ${t.valueUsdg} > 0 and ${notSettlement} and ${t.blockTime} >= ${new Date(o.since.getTime() - 86_400_000).toISOString()}`)
    : [];
  return {
    view: fundingView({ funders, hubs, returns: returns.map((r) => ({ from: r.from, to: r.to, at: r.at.getTime() })) }, f.hops),
    indexedBlock: cursor.block,
    indexedAt: cursor.updatedAt,
  };
}

/**
 * Worker job "commerce-transfers": copy every confirmed USDG Transfer from COMMERCE_FUNDING_FROM_BLOCK on into
 * commerce_transfers, at most `maxRanges` ranges of `maxRange` blocks per run. Idempotent on (tx hash, log index).
 */
export async function pollCommerceTransfers(ctx: Ctx, maxRange = 2_000n, maxRanges = 25) {
  const fromBlock = ctx.cfg.commerce.funding.fromBlock;
  if (!ctx.cfg.commerce.enabled || fromBlock === null) return { skipped: "not configured" };
  const head = await ctx.chain.blockNumber();
  const safeHead = head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  const [cur] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, COMMERCE_CURSOR));
  let from = cur ? cur.block + 1n : fromBlock;
  let recorded = 0;
  for (let i = 0; i < maxRanges && from <= safeHead; i++) {
    const to = from + maxRange - 1n < safeHead ? from + maxRange - 1n : safeHead;
    const logs = await ctx.chain.usdgTransfers(from, to);
    const MAX = (1n << 63n) - 1n;
    const rows = logs.map((l) => ({ txHash: l.txHash, logIndex: l.logIndex, blockNumber: l.blockNumber, blockTime: new Date(l.blockTime * 1000), fromAddress: l.from, toAddress: l.to, valueUsdg: l.value > MAX ? MAX : l.value, authorized: l.authorized, txFrom: l.txFrom }));
    await ctx.db.transaction(async (tx) => {
      for (let j = 0; j < rows.length; j += 500) recorded += (await tx.insert(commerceTransfers).values(rows.slice(j, j + 500)).onConflictDoNothing().returning({ tx: commerceTransfers.txHash })).length;
      await tx.insert(chainCursor).values({ id: COMMERCE_CURSOR, block: to }).onConflictDoUpdate({ target: chainCursor.id, set: { block: to, updatedAt: new Date() } });
    });
    from = to + 1n;
  }
  return { head: head.toString(), indexed: (from - 1n).toString(), recorded };
}
