import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, generations, keys, kv, ledger, models, payouts, providers, royalties, settlements, spentRoots } from "../db/schema.ts";
import { mulBps, picoToUsdg, PICO_PER_USDG_UNIT } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { MerkleTree, spentLeaf } from "../receipts/merkle.ts";

// settlement (hourly):
//  1. provider invoices from receipts (per provider per hour): upstream cost, 2% provider-side fee
//  2. weekly USDG payouts to providers that opted into on-chain payout
//  3. creator royalty streams per model per hour
//  4. prepaid spent roots: every funded key's cumulative on-chain spend, merkle-rooted and posted to
//     Credits so self-custodial withdrawals are provably bounded
//  5. protocol margin -> AnyrStaking.notifyMargin (50% buyback to stakers / 50% attestor+canary ops)

const hourKey = (d: Date) => d.toISOString().slice(0, 13);
const USAGE_KINDS = new Set(["usage"]);

async function getKv<T>(ctx: Ctx, k: string): Promise<T | null> {
  const [r] = await ctx.db.select().from(kv).where(eq(kv.key, k));
  return (r?.value as T) ?? null;
}
async function setKv(ctx: Ctx, k: string, v: unknown) {
  await ctx.db.insert(kv).values({ key: k, value: v }).onConflictDoUpdate({ target: kv.key, set: { value: v, updatedAt: new Date() } });
}

/** 1 + 3: close every complete hour that has unsettled generations. */
export async function settleHours(ctx: Ctx, now = new Date()) {
  const currentHour = hourKey(now);
  const rows = await ctx.db
    .select({ id: generations.id, ts: generations.ts, providerId: generations.providerId, modelId: generations.modelId, tokensIn: generations.tokensIn, tokensOut: generations.tokensOut, upstream: generations.upstreamCost, royalty: generations.royalty, margin: generations.margin, mode: generations.mode })
    .from(generations)
    .where(and(isNull(generations.settledPeriod), lt(generations.ts, new Date(currentHour + ":00:00.000Z"))))
    .orderBy(asc(generations.ts))
    .limit(100_000);
  if (!rows.length) return { periods: 0 };
  const inv = new Map<string, { providerId: string; period: string; tokens: bigint; requests: number; upstream: bigint }>();
  const roy = new Map<string, { modelId: string; period: string; amount: bigint }>();
  let margin = 0n;
  for (const g of rows) {
    const period = hourKey(g.ts);
    if (g.mode !== "cache" && g.mode !== "byok" && g.providerId !== "cache") {
      const k = `${g.providerId}|${period}`;
      const e = inv.get(k) ?? { providerId: g.providerId, period, tokens: 0n, requests: 0, upstream: 0n };
      e.tokens += BigInt(g.tokensIn + g.tokensOut);
      e.requests++;
      e.upstream += g.upstream;
      inv.set(k, e);
    }
    if (g.royalty > 0n) {
      const k = `${g.modelId}|${period}`;
      const e = roy.get(k) ?? { modelId: g.modelId, period, amount: 0n };
      e.amount += g.royalty;
      roy.set(k, e);
    }
    margin += g.margin;
  }
  await ctx.db.transaction(async (tx) => {
    for (const e of inv.values()) {
      const fee = mulBps(e.upstream, ctx.cfg.fees.providerFeeBps, "floor");
      const owed = picoToUsdg(e.upstream - fee, "floor");
      await tx
        .insert(settlements)
        .values({ providerId: e.providerId, period: e.period, tokens: e.tokens, requests: e.requests, upstream: e.upstream, fee, usdgOwed: owed })
        .onConflictDoUpdate({
          target: [settlements.providerId, settlements.period],
          set: {
            tokens: sql`${settlements.tokens} + ${e.tokens}`,
            requests: sql`${settlements.requests} + ${e.requests}`,
            upstream: sql`${settlements.upstream} + ${e.upstream}`,
            fee: sql`${settlements.fee} + ${fee}`,
            usdgOwed: sql`${settlements.usdgOwed} + ${owed}`,
          },
        });
      margin += fee;
    }
    const creators = await tx.select({ id: models.id, creator: models.creator }).from(models);
    const cm = new Map(creators.map((m) => [m.id, m.creator]));
    for (const e of roy.values()) {
      await tx
        .insert(royalties)
        .values({ modelId: e.modelId, period: e.period, amount: e.amount, usdg: picoToUsdg(e.amount, "floor"), creator: cm.get(e.modelId) ?? null })
        .onConflictDoUpdate({ target: [royalties.modelId, royalties.period], set: { amount: sql`${royalties.amount} + ${e.amount}`, usdg: sql`${royalties.usdg} + ${picoToUsdg(e.amount, "floor")}` } });
    }
    for (let i = 0; i < rows.length; i += 1000) {
      const ids = rows.slice(i, i + 1000).map((r) => r.id);
      await tx.update(generations).set({ settledPeriod: sql`to_char(${generations.ts} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24')` }).where(inArray(generations.id, ids));
    }
    const prev = BigInt(((await tx.select().from(kv).where(eq(kv.key, "margin_unsent")))[0]?.value as string) ?? "0");
    await tx.insert(kv).values({ key: "margin_unsent", value: (prev + margin).toString() }).onConflictDoUpdate({ target: kv.key, set: { value: (prev + margin).toString(), updatedAt: new Date() } });
  });
  return { periods: inv.size, royalties: roy.size, generations: rows.length };
}

/**
 * 4: Spent-root allocation. On-chain, each key hash k has deposited_k (Deposited + Credited) and
 * withdrawn_k; Credits lets k withdraw deposited_k - spent_k - withdrawn_k. Off-chain an account may
 * own several key hashes and also hold off-chain-only credits (refunds, per-call change) that are not
 * withdrawable. We allocate each account's usage to its key hashes FIFO, after first consuming the
 * off-chain credits, and ratchet the on-chain consumption so it never decreases:
 *   U_on = max(previous U_on, usage - offchainCredits),   spent_k filled in deposit order.
 * Then sum_k(withdrawable_k) = D - W - U_on <= off-chain balance, so withdrawals can never exceed
 * what the account really has, and totalSpent (sum of U_on) is monotonic as Credits requires.
 */
export async function computeSpentLeaves(ctx: Ctx, only?: { accountId: string }) {
  const deposits = await ctx.db
    .select({ keyHash: sql<string>`${chainEvents.args}->>'keyHash'`, amount: sql<string>`sum((${chainEvents.args}->>'amount')::numeric)`, first: sql<string>`min(${chainEvents.blockNumber})` })
    .from(chainEvents)
    .where(and(eq(chainEvents.contract, "credits"), inArray(chainEvents.event, ["Deposited", "Credited"])))
    .groupBy(sql`${chainEvents.args}->>'keyHash'`);
  const withdrawnRows = await ctx.db
    .select({ keyHash: sql<string>`${chainEvents.args}->>'keyHash'`, amount: sql<string>`sum((${chainEvents.args}->>'amount')::numeric)` })
    .from(chainEvents)
    .where(and(eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Withdrawn")))
    .groupBy(sql`${chainEvents.args}->>'keyHash'`);
  const withdrawn = new Map(withdrawnRows.map((r) => [r.keyHash, BigInt(r.amount)]));
  const keyRows = await ctx.db.select({ chainKeyHash: keys.chainKeyHash, accountId: keys.accountId }).from(keys);
  const accountOf = new Map(keyRows.map((k) => [k.chainKeyHash, k.accountId]));
  if (only) for (const [h, a] of accountOf) if (a !== only.accountId) accountOf.delete(h);
  const byAccount = new Map<string, { keyHash: string; deposited: bigint; withdrawn: bigint; first: bigint }[]>();
  const orphan: string[] = [];
  for (const d of deposits) {
    const acct = accountOf.get(d.keyHash);
    if (!acct) {
      if (!only) orphan.push(d.keyHash);
      continue;
    }
    const list = byAccount.get(acct) ?? [];
    list.push({ keyHash: d.keyHash, deposited: BigInt(d.amount), withdrawn: withdrawn.get(d.keyHash) ?? 0n, first: BigInt(d.first) });
    byAccount.set(acct, list);
  }
  const ratchet = (await getKv<Record<string, string>>(ctx, "spent_ratchet")) ?? {};
  let settledTotal = 0n; // settled on-chain usage: the most settlement may ever sweep
  const leaves: [string, bigint][] = orphan.map((h) => [h, 0n]); // funded but unclaimed keys: nothing spent
  for (const [acct, list] of byAccount) {
    list.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.keyHash.localeCompare(b.keyHash)));
    const rows = await ctx.db
      .select({ kind: ledger.kind, pos: sql<string>`coalesce(sum(case when ${ledger.amount} > 0 then ${ledger.amount} else 0 end), 0)`, neg: sql<string>`coalesce(sum(case when ${ledger.amount} < 0 then -${ledger.amount} else 0 end), 0)` })
      .from(ledger)
      .where(eq(ledger.accountId, acct))
      .groupBy(ledger.kind);
    let usage = 0n; // pico
    let offchain = 0n; // pico: credits not backed by this account's on-chain deposits
    for (const r of rows) {
      if (USAGE_KINDS.has(r.kind)) usage += BigInt(r.neg) - BigInt(r.pos);
      else if (!["deposit", "credit", "paywith", "withdrawal_lock", "withdrawal_release", "withdrawal"].includes(r.kind)) offchain += BigInt(r.pos) - BigInt(r.neg);
    }
    const usageUsdg = picoToUsdg(usage - offchain > 0n ? usage - offchain : 0n, "ceil");
    const settledOnchain = BigInt(ratchet[acct] ?? "0") > usageUsdg ? BigInt(ratchet[acct] ?? "0") : usageUsdg;
    ratchet[acct] = settledOnchain.toString();
    // In-flight holds count as spent (worst case) so a withdrawal finalized against this root can
    // never cover money an open request may still charge. Not ratcheted: released holds come back.
    const [{ held }] = await ctx.db.select({ held: accounts.held }).from(accounts).where(eq(accounts.id, acct));
    const onchain = settledOnchain + picoToUsdg(held > 0n ? held : 0n, "ceil");
    settledTotal += settledOnchain;
    let remaining = onchain;
    for (const k of list) {
      const capacity = k.deposited - k.withdrawn > 0n ? k.deposited - k.withdrawn : 0n;
      const spent = remaining < capacity ? remaining : capacity;
      remaining -= spent;
      leaves.push([k.keyHash, spent]);
    }
    if (remaining > 0n && list.length) {
      // Usage beyond on-chain funds (off-chain credit lines): pin it to the first key so it is never withdrawable.
      const i = leaves.findIndex(([h]) => h === list[0].keyHash);
      leaves[i] = [leaves[i][0], leaves[i][1] + remaining];
    }
  }
  leaves.sort((a, b) => a[0].localeCompare(b[0]));
  return { leaves, ratchet, settledTotal, capacity: byAccount };
}

/** What `chainKeyHash` could withdraw on-chain right now (USDG base units): its own deposits minus
 *  what it already withdrew minus the usage (incl. open holds) allocated to it. */
export async function withdrawableFor(ctx: Ctx, accountId: string, chainKeyHash: string) {
  const { leaves, capacity } = await computeSpentLeaves(ctx, { accountId });
  const k = capacity.get(accountId)?.find((x) => x.keyHash === chainKeyHash);
  if (!k) return 0n;
  const spent = leaves.find(([h]) => h === chainKeyHash)?.[1] ?? 0n;
  const w = k.deposited - k.withdrawn - spent;
  return w > 0n ? w : 0n;
}
