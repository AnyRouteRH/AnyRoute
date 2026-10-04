import { withHostStatus } from "../webhooks/hosts.ts"; // V86: atomic host status notices.
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import {
  accounts,
  anchors,
  chainCursor,
  chainEvents,
  keys,
  kv,
  models,
  paywithDebts,
  paywithSessions,
  paywithSwaps,
  providers,
  quotes,
  receiptKeys,
  slashes,
  spentRoots,
} from "../db/schema.ts";
import { allocate, usdgToPico } from "../lib/money.ts";
import { balanceOf, ensureAccount, post } from "../ledger/ledger.ts";
import { log } from "../lib/util.ts";
import { withdrawableFor } from "../services/settlement.ts";
import type { DecodedLog } from "./service.ts";

export const idHash = (id: string) => keccak256(toBytes(id));
const jsonArgs = (args: Record<string, unknown>) =>
  JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

/** Store decoded logs (idempotent on tx hash + log index). */
export async function recordEvents(ctx: Ctx, logs: DecodedLog[]) {
  if (!logs.length) return 0;
  const rows = logs.map((l) => ({
    txHash: l.txHash,
    logIndex: l.logIndex,
    contract: l.contract,
    event: l.event,
    blockNumber: l.blockNumber,
    args: jsonArgs(l.args),
  }));
  const inserted = await ctx.db.insert(chainEvents).values(rows).onConflictDoNothing().returning({ tx: chainEvents.txHash });
  return inserted.length;
}

/** Pull new confirmed logs from the chain, then apply them. */
export async function pollChain(ctx: Ctx, maxRange = 2_000n) {
  const anyContract = ["credits", "callPay", "payWithStock", "providerBond", "receiptAnchor", "royalty"].some((n) => ctx.chain.address(n as never));
  if (!anyContract) return { skipped: "no contracts configured" };
  const head = await ctx.chain.blockNumber();
  const safeHead = head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
  const [cur] = await ctx.db.select().from(chainCursor).where(eq(chainCursor.id, "main"));
  let from = cur ? cur.block + 1n : (ctx.cfg.chain.startBlock ?? (safeHead > 5_000n ? safeHead - 5_000n : 0n));
  let total = 0;
  while (from <= safeHead) {
    const to = from + maxRange - 1n < safeHead ? from + maxRange - 1n : safeHead;
    const logs = await ctx.chain.logs(from, to);
    total += await recordEvents(ctx, logs);
    await ctx.db
      .insert(chainCursor)
      .values({ id: "main", block: to })
      .onConflictDoUpdate({ target: chainCursor.id, set: { block: to, updatedAt: new Date() } });
    from = to + 1n;
  }
  const applied = await processEvents(ctx);
  const retried = await processEvents(ctx, { retry: true });
  return { head: head.toString(), recorded: total, applied, retried };
}

type EventRow = typeof chainEvents.$inferSelect;
const ref = (e: EventRow, p: string) => `${p}:${e.txHash}:${e.logIndex}`;

async function keyByChainHash(ctx: Ctx, chainKeyHash: string) {
  const [k] = await ctx.db.select().from(keys).where(eq(keys.chainKeyHash, chainKeyHash));
  return k ?? null;
}

async function setKv(ctx: Ctx, key: string, value: unknown) {
  await ctx.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
}
async function getKv<T>(ctx: Ctx, key: string): Promise<T | null> {
  const [r] = await ctx.db.select().from(kv).where(eq(kv.key, key));
  return (r?.value as T) ?? null;
}

/** Apply unprocessed events in chain order. Returns number applied.
 *  - default pass: fresh events only (no recorded error), drained in batches, so stuck events can
 *    never starve new ones;
 *  - { retry: true }: events that failed before (not unclaimed deposits), bounded;
 *  - { chainKeyHash }: every pending event for one key hash — used when a key first appears, which
 *    is how deposits made before registration ("unclaimed") are credited. */
export async function processEvents(ctx: Ctx, filter: { chainKeyHash?: string; retry?: boolean } = {}) {
  const pageSize = filter.retry ? 500 : 5_000;
  const where = filter.chainKeyHash
    ? and(eq(chainEvents.processed, false), sql`${chainEvents.args}->>'keyHash' = ${filter.chainKeyHash}`)
    : filter.retry
      ? and(eq(chainEvents.processed, false), isNotNull(chainEvents.error), sql`${chainEvents.error} NOT LIKE 'unclaimed%'`)
      : and(eq(chainEvents.processed, false), isNull(chainEvents.error));
  let applied = 0;
  for (let page = 0; page < (filter.retry || filter.chainKeyHash ? 1 : 100); page++) {
    const rows = await ctx.db.select().from(chainEvents).where(where).orderBy(asc(chainEvents.blockNumber), asc(chainEvents.logIndex)).limit(pageSize);
    let progressed = 0;
    for (const e of rows) {
      try {
        const done = await applyEvent(ctx, e);
        if (done) {
          await ctx.db
            .update(chainEvents)
            .set({ processed: true, processedAt: new Date(), error: null })
            .where(and(eq(chainEvents.txHash, e.txHash), eq(chainEvents.logIndex, e.logIndex)));
          applied++;
        }
        progressed++;
      } catch (err) {
        log.error("chain event failed", { event: e.event, tx: e.txHash, error: (err as Error).message });
        await ctx.db
          .update(chainEvents)
          .set({ error: ("failed: " + (err as Error).message).slice(0, 500) })
          .where(and(eq(chainEvents.txHash, e.txHash), eq(chainEvents.logIndex, e.logIndex)));
        progressed++;
      }
    }
    if (rows.length < pageSize || !progressed) break;
  }
  return applied;
}

async function unclaimed(ctx: Ctx, e: EventRow) {
  await ctx.db.update(chainEvents).set({ error: "unclaimed: no key registered for this hash yet" }).where(and(eq(chainEvents.txHash, e.txHash), eq(chainEvents.logIndex, e.logIndex)));
  return false;
}

async function applyEvent(ctx: Ctx, e: EventRow): Promise<boolean> {
  const a = e.args as Record<string, string>;
  switch (`${e.contract}.${e.event}`) {
    case "credits.Deposited":
    case "credits.Credited": {
      const key = await keyByChainHash(ctx, a.keyHash);
      if (!key) return unclaimed(ctx, e);
      const fromPayWith = e.event === "Credited" && ctx.chain.address("payWithStock")?.toLowerCase() === String(a.source).toLowerCase();
      await ctx.db.transaction(async (tx) => {
        await ensureAccount(tx, key.accountId);
        await post(tx, {
          accountId: key.accountId,
          keyHash: key.keyHash,
          amount: usdgToPico(BigInt(a.amount)),
          kind: e.event === "Deposited" ? "deposit" : fromPayWith ? "paywith" : "credit",
          ref: ref(e, e.event === "Deposited" ? "dep" : "cred"),
          description: e.event === "Deposited" ? `USDG deposit ${e.txHash}` : `USDG credit ${e.txHash}`,
        });
      });
      return true;
    }
    case "credits.WithdrawalRequested": {
      const key = await keyByChainHash(ctx, a.keyHash);
      if (!key) return unclaimed(ctx, e); // replayed in chain order if the key ever appears
      // Lock only what this key hash could really withdraw on-chain (its own deposits, net of its
      // allocated usage and open holds) and never more than is spendable now.
      const { available } = await balanceOf(ctx.db, key.accountId);
      const own = usdgToPico(await withdrawableFor(ctx, key.accountId, a.keyHash));
      const want = usdgToPico(BigInt(a.amount));
      const cap = own < available ? own : available;
      const lock = want < cap ? want : cap > 0n ? cap : 0n;
      if (lock > 0n)
        await post(ctx.db, { accountId: key.accountId, keyHash: key.keyHash, amount: -lock, kind: "withdrawal_lock", ref: ref(e, "wreq"), description: `Withdrawal requested to ${a.to}` });
      await setKv(ctx, `wlock:${a.keyHash}`, { lock: lock.toString(), accountId: key.accountId, keyHash: key.keyHash, ref: ref(e, "wreq") });
      return true;
    }
    case "credits.WithdrawalCancelled": {
      if (!(await keyByChainHash(ctx, a.keyHash))) return unclaimed(ctx, e);
      const lock = await getKv<{ lock: string; accountId: string; keyHash: string }>(ctx, `wlock:${a.keyHash}`);
      if (lock && BigInt(lock.lock) > 0n)
        await post(ctx.db, { accountId: lock.accountId, keyHash: lock.keyHash, amount: BigInt(lock.lock), kind: "withdrawal_release", ref: ref(e, "wcancel"), description: "Withdrawal cancelled" });
      await setKv(ctx, `wlock:${a.keyHash}`, { lock: "0" });
      return true;
    }
    case "credits.Withdrawn": {
      const key = await keyByChainHash(ctx, a.keyHash);
      if (!key) return unclaimed(ctx, e);
      const lock = await getKv<{ lock: string; accountId: string; keyHash: string }>(ctx, `wlock:${a.keyHash}`);
      const locked = lock?.accountId ? BigInt(lock.lock) : 0n;
      const paid = usdgToPico(BigInt(a.amount));
      const accountId = lock?.accountId ?? key?.accountId;
      if (accountId && paid !== locked)
        await post(ctx.db, {
          accountId,
          keyHash: key?.keyHash ?? null,
          amount: locked - paid,
          kind: locked > paid ? "withdrawal_release" : "withdrawal",
          ref: ref(e, "wdone"),
          description: `Withdrawal of ${a.amount} USDG base units finalized`,
        });
      const totals = (await getKv<Record<string, string>>(ctx, "withdrawn")) ?? {};
      totals[a.keyHash] = (BigInt(totals[a.keyHash] ?? "0") + BigInt(a.amount)).toString();
      await setKv(ctx, "withdrawn", totals);
      await setKv(ctx, `wlock:${a.keyHash}`, { lock: "0" });
      return true;
    }
    case "credits.SpentRootPosted": {
      await ctx.db.update(spentRoots).set({ status: "confirmed", txHash: e.txHash }).where(eq(spentRoots.root, a.root));
      return true;
    }
    case "callPay.Paid": {
      // A payment the caller never redeemed still belongs to them: credit the payer's wallet
      // account. The X-Payment path uses the same ledger ref, so it can never double-credit.
      const [q] = await ctx.db.select().from(quotes).where(eq(quotes.nonce, a.nonce));
      const accountId = `w_${String(a.payer).toLowerCase().slice(2)}`;
      await ctx.db.transaction(async (tx) => {
        await ensureAccount(tx, accountId, "wallet", String(a.payer).toLowerCase());
        await post(tx, { accountId, amount: usdgToPico(BigInt(a.amount)), kind: "per_call_payment", ref: `callpay:${e.txHash.toLowerCase()}:${e.logIndex}`, description: `Per-call payment ${e.txHash}` });
      });
      if (q && q.status === "open")
        await ctx.db.update(quotes).set({ status: "paid", payer: String(a.payer).toLowerCase(), txHash: e.txHash.toLowerCase(), accountId }).where(eq(quotes.nonce, a.nonce));
      return true;
    }
    case "payWithStock.SessionOpened": {
      const token = ctx.cfg.paywith.tokens.find((t) => t.address.toLowerCase() === String(a.token).toLowerCase());
      const wallet = String(a.wallet).toLowerCase();
      // Only sessions from a wallet the key holder registered (POST /api/v1/paywith/open) are honoured.
      const intent = await getKv<{ wallet: string; token: string }>(ctx, `paywith-intent:${a.keyHash}`);
      const trusted = !!intent && intent.wallet === wallet && intent.token === String(a.token).toLowerCase();
      const row = { wallet, token: String(a.token).toLowerCase(), symbol: token?.symbol ?? "?", capRawDay: BigInt(a.capRawPerDay), active: trusted, openedTx: e.txHash };
      await ctx.db
        .insert(paywithSessions)
        .values({ keyHash: a.keyHash, ...row })
        .onConflictDoUpdate({ target: paywithSessions.keyHash, set: { ...row, updatedAt: new Date() } });
      if (!trusted) log.warn("ignoring pay-with session from an unregistered wallet", { keyHash: a.keyHash, wallet });
      return true;
    }
    case "payWithStock.SessionClosed": {
      await ctx.db.update(paywithSessions).set({ active: false, updatedAt: new Date() }).where(eq(paywithSessions.keyHash, a.keyHash));
      return true;
    }
    case "payWithStock.PaidWithStock": {
      await allocateSwap(ctx, { keyHash: a.keyHash, token: a.token, rawSpent: BigInt(a.rawSpent), fairPrice18: a.fairPrice18, usdgOwed: BigInt(a.usdgOwed), tx: e.txHash, usageCommitment: a.usageCommitment ?? undefined });
      return true;
    }
    case "receiptAnchor.Anchored": {
      await ctx.db.update(anchors).set({ status: "confirmed", txHash: e.txHash }).where(eq(anchors.root, a.root));
      return true;
    }
    case "receiptAnchor.SigningKeyRegistered": {
      await ctx.db.update(receiptKeys).set({ onchainTx: e.txHash }).where(eq(receiptKeys.id, String(a.keyId).slice(2)));
      return true;
    }
    case "providerBond.Bonded": {
      const all = await ctx.db.select({ id: providers.id }).from(providers);
      const p = all.find((x) => idHash(x.id) === a.providerId);
      if (p) await ctx.db.update(providers).set({ bondUsdg: BigInt(a.total), operator: String(a.operator).toLowerCase(), updatedAt: new Date() }).where(eq(providers.id, p.id));
      return true;
    }
    case "providerBond.SlashProposed": {
      await ctx.db.update(slashes).set({ onchainId: a.slashId }).where(and(eq(slashes.evidenceRoot, a.evidenceRoot), isNull(slashes.onchainId)));
      return true;
    }
    case "providerBond.SlashDisputed": {
      await ctx.db.update(slashes).set({ status: "disputed", disputeHash: a.disputeHash, disputedAt: new Date() }).where(eq(slashes.onchainId, a.slashId));
      return true;
    }
    case "providerBond.SlashCancelled": {
      await ctx.db.update(slashes).set({ status: "cancelled" }).where(eq(slashes.onchainId, a.slashId));
      return true;
    }
    case "providerBond.SlashExecuted": {
      await ctx.db.update(slashes).set({ status: "executed", executedAt: new Date(), txHash: e.txHash }).where(eq(slashes.onchainId, a.slashId));
      const all = await ctx.db.select({ id: providers.id, bond: providers.bondUsdg }).from(providers);
      const p = all.find((x) => idHash(x.id) === a.providerId);
      if (p) await withHostStatus(ctx, p.id, db => db.update(providers).set({ bondUsdg: p.bond - BigInt(a.amount) > 0n ? p.bond - BigInt(a.amount) : 0n, ...(a.delisted ? { status: "delisted" } : {}), updatedAt: new Date() }).where(eq(providers.id, p.id)));
      return true;
    }
    case "providerBond.Delisted": {
      const all = await ctx.db.select({ id: providers.id }).from(providers);
      const p = all.find((x) => idHash(x.id) === a.providerId);
      if (p) await withHostStatus(ctx, p.id, db => db.update(providers).set({ status: "delisted", updatedAt: new Date() }).where(eq(providers.id, p.id)));
      return true;
    }
    case "royalty.Registered":
    case "royalty.CreatorUpdated": {
      const all = await ctx.db.select({ id: models.id }).from(models);
      const m = all.find((x) => idHash(x.id) === a.modelId);
      if (m) await ctx.db.update(models).set({ creator: String(a.creator).toLowerCase(), ...(a.bps != null ? { royaltyBps: Number(a.bps) } : {}) }).where(eq(models.id, m.id));
      return true;
    }
    default:
      return true; // informational events (Paid to treasury, Staked, etc.) need no ledger action
  }
}

/** Allocate a confirmed stock swap across the key's open pay-with debts, proportionally, so
 *  per-call raw allocations sum exactly to rawSpent. */
export async function allocateSwap(ctx: Ctx, s: { keyHash: string; token: string; rawSpent: bigint; fairPrice18: string; usdgOwed: bigint; tx: string; usageCommitment?: string }) {
  await ctx.db.transaction(async (tx) => {
    let [swap] = await tx.select().from(paywithSwaps).where(eq(paywithSwaps.tx, s.tx));
    if (!swap && s.usageCommitment) {
      // A charge the aggregator claimed debts for but never saw land (e.g. its send timed out): its usage
      // commitment names the claiming swap.
      const [hit] = await tx.select().from(kv).where(eq(kv.key, `paywith-commitment:${s.usageCommitment.toLowerCase()}`));
      const claimedBy = (hit?.value as { swapId?: string } | undefined)?.swapId;
      if (claimedBy) [swap] = await tx.update(paywithSwaps).set({ tx: s.tx }).where(and(eq(paywithSwaps.id, claimedBy), eq(paywithSwaps.keyHash, s.keyHash), isNull(paywithSwaps.tx))).returning();
    }
    if (!swap) {
      [swap] = await tx
        .insert(paywithSwaps)
        .values({ id: `swap_${s.tx.slice(2, 18)}`, keyHash: s.keyHash, token: String(s.token).toLowerCase(), usdgOut: s.usdgOwed, tx: s.tx, status: "confirmed" })
        .onConflictDoNothing()
        .returning();
      if (!swap) [swap] = await tx.select().from(paywithSwaps).where(eq(paywithSwaps.tx, s.tx));
    }
    // Debts claimed by this swap (the aggregator claims them before sending it). If the swap row was
    // never claimed (e.g. recovered from chain after a crash), cover only whole open debts that fit.
    let covered = await tx.select().from(paywithDebts).where(eq(paywithDebts.swapId, swap.id)).orderBy(asc(paywithDebts.createdAt));
    if (!covered.length) {
      const open = await tx.select().from(paywithDebts).where(and(eq(paywithDebts.chainKeyHash, s.keyHash), isNull(paywithDebts.swapId))).orderBy(asc(paywithDebts.createdAt));
      let remaining = usdgToPico(s.usdgOwed);
      covered = [];
      for (const d of open) {
        if (d.amount > remaining) break;
        covered.push(d);
        remaining -= d.amount;
      }
    }
    const parts = allocate(s.rawSpent, covered.map((d) => d.amount));
    for (let i = 0; i < covered.length; i++)
      await tx.update(paywithDebts).set({ swapId: swap.id, rawAllocated: parts[i] }).where(eq(paywithDebts.id, covered[i].id));
    await tx
      .update(paywithSwaps)
      .set({
        status: "confirmed",
        token: String(s.token).toLowerCase(),
        rawSpent: s.rawSpent,
        fairPrice: s.fairPrice18,
        allocations: covered.map((d, i) => ({ generation_id: d.generationId, usd_pico: d.amount.toString(), raw: parts[i].toString() })),
      })
      .where(eq(paywithSwaps.id, swap.id));
  });
}

export { accounts };
