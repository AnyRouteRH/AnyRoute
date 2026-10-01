import { and, asc, eq, gt } from "drizzle-orm";
import { decodeEventLog, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { canonical } from "../lib/util.ts";
import { agreementEscrowAbi, disputeOracleAbi } from "./abi.ts";
import { agreementCursor, agreementEvents, agreementProjection } from "./schema.ts";
import { applyAgreementEvent, agreementScope, type AgreementState } from "./state.ts";
export type IndexedAgreementLog = { event: string; args: Record<string, unknown>; txHash: Hex; logIndex: number; block: bigint; blockHash: Hex };
export type AgreementIndexChain = {
  tip(): Promise<{ head: bigint; final: bigint }>;
  hash(block: bigint): Promise<string | null>;
  logs(from: bigint, to: bigint): Promise<IndexedAgreementLog[]>;
};
export function agreementIndexChain(ctx: Ctx): AgreementIndexChain {
  return {
    tip: () => ctx.chain.escrowFinality(ctx.cfg.agreements.finality),
    hash: block => ctx.chain.blockHashAt(block),
    logs: async (fromBlock, toBlock) => {
      const sources = [{ address: ctx.cfg.agreements.escrow!, abi: agreementEscrowAbi, names: null }, { address: ctx.cfg.agreements.oracle!, abi: disputeOracleAbi, names: ["TallyRecorded", "PanelRequired", "RulingPosted"] }];
      const batches = await Promise.all(sources.map(async source => {
        const events = source.abi.filter(e => e.type === "event" && (!source.names || source.names.includes(e.name)));
        const logs = await ctx.chain.client.getLogs({ address: source.address, events, fromBlock, toBlock });
        return Promise.all(logs.map(async l => {
          const d = decodeEventLog({ abi: source.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
          if (l.removed || l.blockNumber === null || !l.blockHash || !l.transactionHash || l.logIndex === null) throw new Error("Incomplete Agreement log from RPC.");
          return { event: d.eventName, args: { ...canonical(d.args) as Record<string, unknown>, indexedEscrow: ctx.cfg.agreements.escrow!, indexedOracle: ctx.cfg.agreements.oracle!, indexedAt: Number((await ctx.chain.client.getBlock({ blockNumber: l.blockNumber! })).timestamp) }, txHash: l.transactionHash.toLowerCase() as Hex, logIndex: l.logIndex, block: l.blockNumber, blockHash: l.blockHash.toLowerCase() as Hex };
        }));
      }));
      return batches.flat();
    },
  };
}
export async function loadAgreementState(db: Db | Tx, scope: string): Promise<AgreementState> {
  const rows = await db.select().from(agreementProjection).where(eq(agreementProjection.scope, scope));
  return new Map(rows.map(r => [`${r.kind}:${r.id}`, r.data as AgreementState extends Map<string, infer V> ? V : never]));
}
async function saveProjection(tx: Tx, scope: string, state: AgreementState, keys: Set<string>) {
  for (const key of keys) {
    const [kind, id] = key.split(":");
    const data = canonical(state.get(key));
    await tx.insert(agreementProjection).values({ scope, kind, id, data }).onConflictDoUpdate({ target: [agreementProjection.scope, agreementProjection.kind, agreementProjection.id], set: { data } });
  }
}
/** Same lock serializes index passes and slash intents across replicas; persisted cursor resumes after restart. */
export async function lockAgreementCursor(tx: Tx, scope: string, start: bigint) {
  await tx.insert(agreementCursor).values({ scope, block: start - 1n, checkpoints: [] }).onConflictDoNothing();
  const [cursor] = await tx.select().from(agreementCursor).where(eq(agreementCursor.scope, scope)).for("update");
  return cursor;
}
export async function pollAgreements(ctx: Ctx, chain = agreementIndexChain(ctx), maxRange = 2_000n, maxBatches = 10) {
  if (!ctx.cfg.agreements.enabled) return { skipped: "disabled" };
  if (maxRange < 1n) throw new Error("Agreement scan range must be positive.");
  const scope = agreementScope(ctx.cfg), start = ctx.cfg.agreements.startBlock;
  return ctx.db.transaction(async tx => {
    const cursor = await lockAgreementCursor(tx, scope, start);
    const tip = await chain.tip();
    const confirmed = tip.head - BigInt(Math.max(0, ctx.cfg.chain.confirmations - 1));
    const safe = tip.final < confirmed ? tip.final : confirmed;
    let block = cursor.block;
    let points = cursor.checkpoints as { block: string; hash: string }[];
    let state = await loadAgreementState(tx, scope);
    const changed = new Set<string>();
    let reorg = false;
    if (block >= start && (!cursor.blockHash || (await chain.hash(block))?.toLowerCase() !== cursor.blockHash)) {
      reorg = true;
      block = start - 1n;
      for (const point of [...points].reverse()) if ((await chain.hash(BigInt(point.block)))?.toLowerCase() === point.hash) { block = BigInt(point.block); break; }
      points = points.filter(p => BigInt(p.block) <= block);
      await tx.delete(agreementEvents).where(and(eq(agreementEvents.scope, scope), gt(agreementEvents.block, block)));
      await tx.delete(agreementProjection).where(eq(agreementProjection.scope, scope));
      state = new Map();
      const retained = await tx.select().from(agreementEvents).where(eq(agreementEvents.scope, scope)).orderBy(asc(agreementEvents.block), asc(agreementEvents.logIndex));
      for (const e of retained) for (const key of applyAgreementEvent(state, { ...e, args: e.args as Record<string, unknown> })) changed.add(key);
    }
    if (block > safe) {
      await saveProjection(tx, scope, state, changed);
      await tx.update(agreementCursor).set({ block, blockHash: block >= start ? await chain.hash(block) : null, checkpoints: points, checkedAt: new Date(0) }).where(eq(agreementCursor.scope, scope));
      return { recorded: 0, reorg, block: block.toString(), caught_up: false };
    }
    let recorded = 0;
    let hash = block >= start ? await chain.hash(block) : null;
    for (let batch = 0; block < safe && batch < maxBatches; batch++) {
      const from = block + 1n;
      const to = block + maxRange < safe ? block + maxRange : safe;
      const before = await chain.hash(to);
      if (!before) throw new Error("Agreement scan block is unavailable.");
      const logs = (await chain.logs(from, to)).sort((a, b) => a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
      const blockHashes = new Map<bigint, string>();
      for (const e of logs) {
        if (e.block < from || e.block > to) throw new Error("Agreement RPC returned a log outside the scan range.");
        if (!blockHashes.has(e.block)) blockHashes.set(e.block, (await chain.hash(e.block))?.toLowerCase() ?? "");
        if (blockHashes.get(e.block) !== e.blockHash.toLowerCase()) throw new Error("Agreement RPC returned a noncanonical log.");
        const inserted = await tx.insert(agreementEvents).values({ ...e, scope }).onConflictDoNothing().returning();
        if (inserted.length) { recorded++; for (const key of applyAgreementEvent(state, e)) changed.add(key); }
      }
      if ((await chain.hash(to)) !== before) throw new Error("Agreement chain changed during scan; retry.");
      block = to; hash = before.toLowerCase(); points.push({ block: block.toString(), hash }); points = points.slice(-128);
    }
    await saveProjection(tx, scope, state, changed);
    // Never give old/backfilling data a fresh timestamp. A reorg and its replacement projection commit together.
    await tx.update(agreementCursor).set({ block, blockHash: hash, checkpoints: points, checkedAt: block >= safe ? new Date() : new Date(0) }).where(eq(agreementCursor.scope, scope));
    return { recorded, reorg, block: block.toString(), caught_up: block >= safe };
  });
}
