import { skipSanctionedPayout } from "../network/sanctions.ts";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, generations, keys, kv, ledger, models, payouts, providers, royalties, settlements, spentRoots } from "../db/schema.ts";
import { mulBps, picoToUsdg, PICO_PER_USDG_UNIT } from "../lib/money.ts";
import { log, uid } from "../lib/util.ts";
import { SpentTree } from "../receipts/merkle.ts";

// settlement (hourly):
//  1. provider invoices from receipts (per provider per hour): upstream cost, 2% provider-side fee
//  2. weekly USDG payouts to providers that opted into on-chain payout
//  3. creator royalty streams per model per hour
//  4. prepaid spent roots: every funded key's cumulative on-chain spend in a tree sorted by key hash,
//     posted to Credits so self-custodial withdrawals are provably bounded. A key the root leaves out
//     withdraws as if it spent nothing, so completeness is the operator's own money, not a trust ask.
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
 *
 * No leaf ever exceeds its key's deposits minus withdrawals (Credits' rule), withdrawals made with an
 * absence proof included. Usage beyond the account's net on-chain funding (a credit line, or spend a
 * root omitted before the key exited) is `uncovered`: the operator's loss unless the account funds it
 * later, and never part of `settledTotal`, the usage settlement may sweep.
 */
export async function computeSpentLeaves(ctx: Ctx, only?: { accountId: string }) {
  const keyHashArg = sql<string>`lower(${chainEvents.args}->>'keyHash')`;
  const deposits = await ctx.db
    .select({ keyHash: keyHashArg, amount: sql<string>`sum((${chainEvents.args}->>'amount')::numeric)`, first: sql<string>`min(${chainEvents.blockNumber})` })
    .from(chainEvents)
    .where(and(eq(chainEvents.contract, "credits"), inArray(chainEvents.event, ["Deposited", "Credited"])))
    .groupBy(keyHashArg);
  const withdrawnRows = await ctx.db
    .select({ keyHash: keyHashArg, amount: sql<string>`sum((${chainEvents.args}->>'amount')::numeric)` })
    .from(chainEvents)
    .where(and(eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Withdrawn")))
    .groupBy(keyHashArg);
  const withdrawn = new Map(withdrawnRows.map((r) => [r.keyHash, BigInt(r.amount)]));
  const keyRows = await ctx.db.select({ chainKeyHash: keys.chainKeyHash, accountId: keys.accountId }).from(keys);
  const accountOf = new Map(keyRows.map((k) => [k.chainKeyHash.toLowerCase(), k.accountId]));
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
  let settledTotal = 0n; // settled on-chain usage that deposits cover: the most settlement may ever sweep
  const uncovered = new Map<string, bigint>(); // account -> settled usage beyond its keys' net funding (USDG)
  const leaves: [string, bigint][] = orphan.map((h) => [h, 0n]); // funded but unclaimed keys: nothing spent
  for (const [acct, list] of byAccount) {
    list.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.keyHash < b.keyHash ? -1 : a.keyHash > b.keyHash ? 1 : 0));
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
    const funded = list.reduce((a, k) => a + (k.deposited - k.withdrawn > 0n ? k.deposited - k.withdrawn : 0n), 0n);
    settledTotal += settledOnchain < funded ? settledOnchain : funded;
    if (settledOnchain > funded) uncovered.set(acct, settledOnchain - funded);
    // Each leaf is capped at its key's deposits minus withdrawals, so every key of an account whose
    // usage outruns its funding is already at zero withdrawable; the excess is on no leaf at all.
    let remaining = onchain;
    for (const k of list) {
      const capacity = k.deposited - k.withdrawn > 0n ? k.deposited - k.withdrawn : 0n;
      const spent = remaining < capacity ? remaining : capacity;
      remaining -= spent;
      leaves.push([k.keyHash, spent]);
    }
  }
  leaves.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
  return { leaves, ratchet, settledTotal, uncovered, capacity: byAccount };
}

/** What `chainKeyHash` could withdraw on-chain right now (USDG base units): its own deposits minus
 *  what it already withdrew minus the usage (incl. open holds) allocated to it. */
export async function withdrawableFor(ctx: Ctx, accountId: string, chainKeyHash: string) {
  const { leaves, capacity } = await computeSpentLeaves(ctx, { accountId });
  const kh = chainKeyHash.toLowerCase();
  const k = capacity.get(accountId)?.find((x) => x.keyHash === kh);
  if (!k) return 0n;
  const spent = leaves.find(([h]) => h === kh)?.[1] ?? 0n;
  const w = k.deposited - k.withdrawn - spent;
  return w > 0n ? w : 0n;
}

/** Retain the exact candidate while governance reviews it; retries never silently replace its leaves. */
async function submitSpentRoot(ctx: Ctx, row: typeof spentRoots.$inferSelect) {
  const asOf = Math.floor(row.asOf.getTime() / 1000);
  const approval = ctx.chain.spentRootApproval(row.epoch, row.root as Hex, asOf, row.totalSpentUsdg);
  if (!await ctx.chain.isSpentRootApproved(row.root as Hex, asOf, row.totalSpentUsdg)) {
    await ctx.db.update(spentRoots).set({ status: "awaiting_approval" }).where(eq(spentRoots.epoch, row.epoch));
    return { posted: false, reason: "awaiting independent approval", epoch: row.epoch, root: row.root, approval };
  }
  await ctx.db.update(spentRoots).set({ status: "pending" }).where(eq(spentRoots.epoch, row.epoch));
  try {
    const r = await ctx.chain.postSpentRoot(row.root as Hex, asOf, row.totalSpentUsdg);
    await ctx.db.update(spentRoots).set({ status: "confirmed", txHash: r.hash }).where(eq(spentRoots.epoch, row.epoch));
    return { posted: true, epoch: row.epoch, root: row.root, total_spent_usdg: row.totalSpentUsdg.toString(), tx: r.hash };
  } catch (e) {
    log.error("postSpentRoot failed", { epoch: row.epoch, error: (e as Error).message });
    return { posted: false, reason: "submission failed; candidate retained", epoch: row.epoch, root: row.root, tx: null };
  }
}

export async function postSpentRoot(ctx: Ctx) {
  const onChain = !!(ctx.chain.address("credits") && ctx.chain.roleAddress("settlement"));
  let [last] = await ctx.db.select().from(spentRoots).orderBy(desc(spentRoots.epoch)).limit(1);
  if (onChain) {
    // An RPC failure must never delete a candidate or masquerade as an unposted root.
    const landed = await ctx.chain.latestSpentRoot();
    if (last && ["pending", "awaiting_approval"].includes(last.status)) {
      if (landed.epoch === BigInt(last.epoch) && landed.root === last.root && landed.totalSpent === last.totalSpentUsdg && landed.asOf === Math.floor(last.asOf.getTime() / 1000)) {
        await ctx.db.update(spentRoots).set({ status: "confirmed" }).where(eq(spentRoots.epoch, last.epoch));
        last = { ...last, status: "confirmed" };
      } else if (landed.epoch === BigInt(last.epoch - 1)) return submitSpentRoot(ctx, last);
      else throw new Error("Spent-root chain/database mismatch; reconcile before proposing another root");
    }
    if (landed.epoch !== BigInt(last?.epoch ?? 0) || (last && (landed.root !== last.root || landed.totalSpent !== last.totalSpentUsdg || landed.asOf !== Math.floor(last.asOf.getTime() / 1000))))
      throw new Error("Spent-root chain/database mismatch; reconcile before proposing another root");
  }
  const { leaves, ratchet, settledTotal, uncovered } = await computeSpentLeaves(ctx);
  if (!leaves.length) return { posted: false, reason: "no funded keys" };
  const tree = new SpentTree(leaves);
  const lastTotal = last ? last.totalSpentUsdg : 0n;
  const total = leaves.reduce((a, [, s]) => a + s, 0n);
  const totalSpent = total > lastTotal ? total : lastTotal;
  if (last && last.root === tree.root) return { posted: false, reason: "unchanged", epoch: last.epoch };
  const epoch = (last?.epoch ?? 0) + 1;
  let asOfSec = Math.floor(Date.now() / 1000);
  if (onChain) asOfSec = Math.min(asOfSec, await ctx.chain.latestBlockTime());
  if (last && asOfSec <= Math.floor(last.asOf.getTime() / 1000)) return { posted: false, reason: "chain time has not advanced past the last root", epoch: last.epoch };
  const [row] = await ctx.db.insert(spentRoots).values({ epoch, root: tree.root, asOf: new Date(asOfSec * 1000), totalSpentUsdg: totalSpent, leaves: tree.entries().map(([h, s]) => [h, s.toString()]), status: "pending" }).returning();
  await setKv(ctx, "spent_ratchet", ratchet);
  // Holds can be included in the root. Approvers must cap transfers at independently verified settled
  // usage that deposits cover; usage beyond them is the operator's loss, recorded per root.
  await setKv(ctx, `spent_settled:${epoch}`, settledTotal.toString());
  const uncoveredTotal = [...uncovered.values()].reduce((a, b) => a + b, 0n);
  await setKv(ctx, `spent_uncovered:${epoch}`, uncoveredTotal.toString());
  if (uncoveredTotal > 0n) log.warn("usage exceeds on-chain funds; uncovered amount absorbed by operator unless the accounts fund it", { epoch, accounts: uncovered.size, uncovered_usdg: uncoveredTotal.toString() });
  if (onChain) return submitSpentRoot(ctx, row);
  await ctx.db.update(spentRoots).set({ status: "local" }).where(eq(spentRoots.epoch, epoch));
  return { posted: true, epoch, root: tree.root, keys: leaves.length, total_spent_usdg: totalSpent.toString(), tx: null };
}

/** 2: weekly payouts for providers paid in USDG on-chain. Invoice providers are just marked. */
export async function runPayouts(ctx: Ctx, minAgeMs = 7 * 86_400_000) {
  const cutoff = hourKey(new Date(Date.now() - minAgeMs));
  const due = await ctx.db
    .select({ providerId: settlements.providerId, owed: sql<string>`sum(${settlements.usdgOwed})` })
    .from(settlements)
    .where(and(isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`))
    .groupBy(settlements.providerId);
  const out: unknown[] = [];
  for (const d of due) {
    const [p] = await ctx.db.select().from(providers).where(eq(providers.id, d.providerId));
    if (!p) continue;
    if (await skipSanctionedPayout(ctx, p, out)) continue;
    const id = uid("pay_");
    const amount = BigInt(d.owed);
    const onchain = p.payoutMode === "usdg" && !!p.payoutAddress && ctx.chain.roleAddress("settlement");
    await ctx.db.insert(payouts).values({ id, providerId: p.id, usdg: amount, to: p.payoutAddress, status: onchain ? "pending" : "invoice" });
    await ctx.db.update(settlements).set({ payoutId: id }).where(and(eq(settlements.providerId, p.id), isNull(settlements.payoutId), sql`${settlements.period} <= ${cutoff}`));
    if (onchain && amount > 0n) {
      try {
        const r = await ctx.chain.transferUsdg("settlement", p.payoutAddress as Hex, amount);
        await ctx.db.update(payouts).set({ status: "paid", tx: r.hash }).where(eq(payouts.id, id));
        await ctx.db.update(settlements).set({ paidTx: r.hash }).where(eq(settlements.payoutId, id));
        out.push({ provider: p.id, usdg: amount.toString(), tx: r.hash });
      } catch (e) {
        await ctx.db.update(payouts).set({ status: "pending" }).where(eq(payouts.id, id));
        log.error("provider payout failed", { provider: p.id, error: (e as Error).message });
      }
    } else out.push({ provider: p.id, usdg: amount.toString(), status: "invoice" });
  }
  return { payouts: out };
}

/** 3b: stream accrued royalties on-chain for models with a registered creator. */
export async function streamRoyalties(ctx: Ctx) {
  if (!ctx.chain.address("royalty") || !ctx.chain.roleAddress("settlement")) return { streamed: 0 };
  const due = await ctx.db
    .select({ modelId: royalties.modelId, usdg: sql<string>`sum(${royalties.usdg})` })
    .from(royalties)
    .where(and(isNull(royalties.streamTx), sql`${royalties.creator} IS NOT NULL`))
    .groupBy(royalties.modelId);
  let n = 0;
  for (const d of due) {
    const amount = BigInt(d.usdg);
    if (amount <= 0n) continue;
    try {
      const r = await ctx.chain.streamRoyalty(keccak256(toBytes(d.modelId)), amount);
      await ctx.db.update(royalties).set({ streamTx: r.hash }).where(and(eq(royalties.modelId, d.modelId), isNull(royalties.streamTx)));
      n++;
    } catch (e) {
      log.error("royalty stream failed", { model: d.modelId, error: (e as Error).message });
    }
  }
  return { streamed: n };
}

/** 5: send accrued margin to AnyrStaking (it splits 50% buyback / 50% ops). */
export async function sendMargin(ctx: Ctx) {
  const unsent = BigInt((await getKv<string>(ctx, "margin_unsent")) ?? "0");
  const usdg = picoToUsdg(unsent, "floor");
  if (usdg <= 0n) return { sent: "0" };
  if (!ctx.chain.address("staking") || !ctx.chain.roleAddress("settlement")) return { sent: "0", accrued_usdg: usdg.toString(), reason: "staking not configured" };
  const r = await ctx.chain.notifyMargin(usdg);
  await setKv(ctx, "margin_unsent", (unsent - usdg * PICO_PER_USDG_UNIT).toString());
  return { sent: usdg.toString(), tx: r.hash };
}

export async function runSettlement(ctx: Ctx) {
  const hours = await settleHours(ctx);
  const roots = await postSpentRoot(ctx);
  const royaltiesResult = await streamRoyalties(ctx).catch((e) => ({ error: (e as Error).message }));
  const margin = await sendMargin(ctx).catch((e) => ({ error: (e as Error).message }));
  const weekly = new Date().getUTCDay() === 1 && new Date().getUTCHours() === 0 ? await runPayouts(ctx) : { skipped: "weekly (Mondays 00 UTC)" };
  return { hours, roots, royalties: royaltiesResult, margin, payouts: weekly };
}

export { desc };
