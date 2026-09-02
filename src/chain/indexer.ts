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
