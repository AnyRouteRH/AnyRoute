import type { Hono } from "hono";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { anchors, generations, paywithDebts, paywithSwaps } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { MerkleTree, receiptLeaf } from "../receipts/merkle.ts";
import { canonicalBytes, verifyWithRawKey } from "../receipts/signer.ts";
import { bearer, resolveKey, walletAuth } from "./auth.ts";

export async function anchorProof(ctx: Ctx, g: { anchorIndex: number | null; leafIndex: number | null }) {
  if (g.anchorIndex == null || g.leafIndex == null) return null;
  const [a] = await ctx.db.select().from(anchors).where(eq(anchors.index, g.anchorIndex));
  if (!a) return null;
  const leaves = await ctx.db
    .select({ leaf: generations.receiptLeaf })
    .from(generations)
    .where(eq(generations.anchorIndex, g.anchorIndex))
    .orderBy(asc(generations.leafIndex));
  const tree = new MerkleTree(leaves.map((l) => l.leaf as Hex));
  return {
    root: a.root,
    index: a.index,
    leaf_index: g.leafIndex,
    proof: tree.proof(g.leafIndex),
    from: a.fromTs.toISOString(),
    to: a.toTs.toISOString(),
    tx: a.txHash,
    status: a.status,
    chain: ctx.cfg.chain.id,
    contract: ctx.cfg.chain.receiptAnchor ?? null,
  };
}

export function generationSummary(g: typeof generations.$inferSelect) {
  return {
    id: g.id,
    created_at: g.ts.toISOString(),
    model: g.modelId,
    provider_name: g.providerId,
    tokens_prompt: g.tokensIn,
    tokens_completion: g.tokensOut,
    tokens_reasoning: g.reasoningTokens,
    total_cost: picoToUsd(g.cost),
    upstream_inference_cost: picoToUsd(g.upstreamCost),
    royalty: picoToUsd(g.royalty),
    margin: picoToUsd(g.margin),
    mode: g.mode,
    private: g.private,
    latency: g.latencyMs,
    quantization: g.quant,
    finish_reason: g.finishReason,
    streamed: g.streamed,
    cancelled: g.cancelled,
    paid_with: g.paidWith,
    receipt_key_id: g.receiptKeyId,
    anchored: g.anchorIndex != null,
    key_hash: g.keyHash,
  };
}
