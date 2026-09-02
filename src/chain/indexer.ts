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
  const anyContract = ["credits", "callPay", "payWithStock", "providerBond", "receiptAnchor", "royalty", "staking"].some((n) => ctx.chain.address(n as never));
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
