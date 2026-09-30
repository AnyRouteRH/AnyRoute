import { and, asc, eq, gt } from "drizzle-orm";
import { decodeEventLog, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { canonical } from "../lib/util.ts";
import { hostBondAbi } from "./bond-abi.ts";
import { hostBondCursor, hostBondEvents, hostBondProjection } from "./bond-schema.ts";
import { applyBondEvent, bondScope, type BondState } from "./bond-state.ts";
export type IndexedBondLog = { event: string; args: Record<string, unknown>; txHash: Hex; logIndex: number; block: bigint; blockHash: Hex };
export type BondIndexChain = {
  tip(): Promise<{ head: bigint; final: bigint }>;
  hash(block: bigint): Promise<string | null>;
  logs(from: bigint, to: bigint): Promise<IndexedBondLog[]>;
};
export function bondIndexChain(ctx: Ctx): BondIndexChain {
  return {
    tip: () => ctx.chain.escrowFinality(ctx.cfg.hostBonds.finality),
    hash: block => ctx.chain.blockHashAt(block),
    logs: async (fromBlock, toBlock) => {
      const logs = await ctx.chain.client.getLogs({ address: ctx.cfg.hostBonds.address!, fromBlock, toBlock });
      return logs.map(l => {
        const d = decodeEventLog({ abi: hostBondAbi, data: l.data, topics: l.topics });
        if (l.removed || l.blockNumber === null || !l.blockHash || !l.transactionHash || l.logIndex === null) throw new Error("Incomplete HostBond log from RPC.");
        return { event: d.eventName, args: canonical(d.args) as Record<string, unknown>, txHash: l.transactionHash.toLowerCase() as Hex, logIndex: l.logIndex, block: l.blockNumber, blockHash: l.blockHash.toLowerCase() as Hex };
      });
    },
  };
}
export async function loadBondState(db: Db | Tx, scope: string): Promise<BondState> {
  const rows = await db.select().from(hostBondProjection).where(eq(hostBondProjection.scope, scope));
  return new Map(rows.map(r => [`${r.kind}:${r.id}`, r.data as BondState extends Map<string, infer V> ? V : never]));
}
async function saveProjection(tx: Tx, scope: string, state: BondState, keys: Set<string>) {
  for (const key of keys) {
    const [kind, id] = key.split(":");
    const data = canonical(state.get(key));
    await tx.insert(hostBondProjection).values({ scope, kind, id, data }).onConflictDoUpdate({ target: [hostBondProjection.scope, hostBondProjection.kind, hostBondProjection.id], set: { data } });
  }
}
/** Same lock serializes index passes and slash intents across replicas; persisted cursor resumes after restart. */
export async function lockBondCursor(tx: Tx, scope: string, start: bigint) {
  await tx.insert(hostBondCursor).values({ scope, block: start - 1n, checkpoints: [] }).onConflictDoNothing();
  const [cursor] = await tx.select().from(hostBondCursor).where(eq(hostBondCursor.scope, scope)).for("update");
  return cursor;
}
export async function pollHostBonds(ctx: Ctx, chain = bondIndexChain(ctx), maxRange = 2_000n, maxBatches = 10) {
  if (!ctx.cfg.hostBonds.enabled) return { skipped: "disabled" };
  if (maxRange < 1n) throw new Error("HostBond scan range must be positive.");
  const scope = bondScope(ctx.cfg), start = ctx.cfg.hostBonds.startBlock;
  return ctx.db.transaction(async tx => {
    const cursor = await lockBondCursor(tx, scope, start);
    const tip = await chain.tip();
    const confirmed = tip.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
    const safe = tip.final < confirmed ? tip.final : confirmed;
    let block = cursor.block;
    let points = cursor.checkpoints as { block: string; hash: string }[];
    let state = await loadBondState(tx, scope);
    const changed = new Set<string>();
    let reorg = false;
    if (block >= start && (!cursor.blockHash || (await chain.hash(block))?.toLowerCase() !== cursor.blockHash)) {
      reorg = true;
      block = start - 1n;
      for (const point of [...points].reverse()) if ((await chain.hash(BigInt(point.block)))?.toLowerCase() === point.hash) { block = BigInt(point.block); break; }
      points = points.filter(p => BigInt(p.block) <= block);
      await tx.delete(hostBondEvents).where(and(eq(hostBondEvents.scope, scope), gt(hostBondEvents.block, block)));
      await tx.delete(hostBondProjection).where(eq(hostBondProjection.scope, scope));
      state = new Map();
      const retained = await tx.select().from(hostBondEvents).where(eq(hostBondEvents.scope, scope)).orderBy(asc(hostBondEvents.block), asc(hostBondEvents.logIndex));
      for (const e of retained) for (const key of applyBondEvent(state, { ...e, args: e.args as Record<string, unknown> })) changed.add(key);
    }
    if (block > safe) {
      await saveProjection(tx, scope, state, changed);
      await tx.update(hostBondCursor).set({ block, blockHash: block >= start ? await chain.hash(block) : null, checkpoints: points, checkedAt: new Date(0) }).where(eq(hostBondCursor.scope, scope));
      return { recorded: 0, reorg, block: block.toString(), caught_up: false };
    }
    let recorded = 0;
    let hash = block >= start ? await chain.hash(block) : null;
    for (let batch = 0; block < safe && batch < maxBatches; batch++) {
      const from = block + 1n;
      const to = block + maxRange < safe ? block + maxRange : safe;
      const before = await chain.hash(to);
      if (!before) throw new Error("HostBond scan block is unavailable.");
      const logs = (await chain.logs(from, to)).sort((a, b) => a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
      const blockHashes = new Map<bigint, string>();
      for (const e of logs) {
        if (e.block < from || e.block > to) throw new Error("HostBond RPC returned a log outside the scan range.");
        if (!blockHashes.has(e.block)) blockHashes.set(e.block, (await chain.hash(e.block))?.toLowerCase() ?? "");
        if (blockHashes.get(e.block) !== e.blockHash.toLowerCase()) throw new Error("HostBond RPC returned a noncanonical log.");
        const inserted = await tx.insert(hostBondEvents).values({ ...e, scope }).onConflictDoNothing().returning();
        if (inserted.length) { recorded++; for (const key of applyBondEvent(state, e)) changed.add(key); }
      }
      if ((await chain.hash(to)) !== before) throw new Error("HostBond chain changed during scan; retry.");
      block = to; hash = before.toLowerCase(); points.push({ block: block.toString(), hash }); points = points.slice(-128);
    }
    await saveProjection(tx, scope, state, changed);
    // Never give old/backfilling data a fresh timestamp. A reorg and its replacement projection commit together.
    await tx.update(hostBondCursor).set({ block, blockHash: hash, checkpoints: points, checkedAt: block >= safe ? new Date() : new Date(0) }).where(eq(hostBondCursor.scope, scope));
    return { recorded, reorg, block: block.toString(), caught_up: block >= safe };
  });
}
