import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { anchors, generations, receiptKeys } from "../db/schema.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { log } from "../lib/util.ts";

// Hourly: build a merkle tree over every receipt issued since the last anchor, store the proof
// positions, and post the root to ReceiptAnchor on Robinhood Chain (status "local" when no chain
// is configured, so proofs still work and can be anchored later).

export async function runAnchor(ctx: Ctx, upTo?: Date) {
  const pending = await ctx.db
    .select({ id: generations.id, leaf: generations.receiptLeaf, ts: generations.ts })
    .from(generations)
    .where(and(isNull(generations.anchorIndex), ...(upTo ? [lte(generations.ts, upTo)] : []), sql`${generations.receiptLeaf} IS NOT NULL`))
    .orderBy(asc(generations.ts), asc(generations.id))
    .limit(200_000);
  if (!pending.length) return { anchored: 0 };
  const [last] = await ctx.db.select().from(anchors).orderBy(desc(anchors.index)).limit(1);
  const index = last ? last.index + 1 : 0;
  const tree = new MerkleTree(pending.map((p) => p.leaf as Hex));
  const fromTs = last ? new Date(Math.max(last.toTs.getTime(), pending[0].ts.getTime())) : pending[0].ts;
  const toTs = new Date(Math.max(pending[pending.length - 1].ts.getTime(), fromTs.getTime()));
  await ctx.db.transaction(async (tx) => {
    await tx.insert(anchors).values({ index, root: tree.root, fromTs, toTs, count: pending.length, status: "pending" });
    for (let i = 0; i < pending.length; i++) await tx.update(generations).set({ anchorIndex: index, leafIndex: i }).where(eq(generations.id, pending[i].id));
  });
  let status = "local";
  let txHash: string | null = null;
  if (ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer")) {
    try {
      const r = await ctx.chain.anchor(tree.root, Math.floor(fromTs.getTime() / 1000), Math.floor(toTs.getTime() / 1000), pending.length);
      status = "confirmed";
      txHash = r.hash;
      if (r.index != null && Number(r.index) !== index) log.warn("on-chain anchor index differs from local index", { local: index, chain: String(r.index) });
    } catch (e) {
      status = "pending";
      log.error("anchor submission failed; will retry", { index, error: (e as Error).message });
    }
  }
  await ctx.db.update(anchors).set({ status, txHash }).where(eq(anchors.index, index));
  return { anchored: pending.length, index, root: tree.root, status, tx: txHash };
}

/** Retry anchors that were built but not yet submitted (chain was down / not configured then). */
export async function retryAnchors(ctx: Ctx) {
  if (!ctx.chain.address("receiptAnchor") || !ctx.chain.roleAddress("anchorer")) return { retried: 0 };
  const rows = await ctx.db.select().from(anchors).where(eq(anchors.status, "pending")).orderBy(asc(anchors.index));
  let n = 0;
  for (const a of rows) {
    try {
      const r = await ctx.chain.anchor(a.root as Hex, Math.floor(a.fromTs.getTime() / 1000), Math.floor(a.toTs.getTime() / 1000), a.count);
      await ctx.db.update(anchors).set({ status: "confirmed", txHash: r.hash }).where(eq(anchors.index, a.index));
      n++;
    } catch (e) {
      log.warn("anchor retry failed", { index: a.index, error: (e as Error).message });
      break; // anchors must land in order
    }
  }
  return { retried: n };
}

/** Weekly signing-key rotation; publish every key's public half on-chain. */
export async function runKeyRotation(ctx: Ctx) {
  const r = await ctx.signer.rotateIfDue();
  let published = 0;
  if (ctx.chain.address("receiptAnchor") && ctx.chain.roleAddress("anchorer")) {
    const unpublished = await ctx.db.select().from(receiptKeys).where(isNull(receiptKeys.onchainTx));
    for (const k of unpublished) {
      try {
        const { hash } = await ctx.chain.registerSigningKey(k.id, k.publicKey, k.validFrom);
        await ctx.db.update(receiptKeys).set({ onchainTx: hash }).where(eq(receiptKeys.id, k.id));
        published++;
      } catch (e) {
        log.warn("signing key publication failed", { key: k.id, error: (e as Error).message });
      }
    }
  }
  return { rotated: r.rotated, key: r.key.id, published };
}
