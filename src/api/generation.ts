import type { Hono } from "hono";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { agentSessions, anchors, blindNullifiers, generations, paywithDebts, paywithSwaps } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { MerkleTree, receiptLeaf } from "../receipts/merkle.ts";
import { canonicalBytes, verifyWithRawKey } from "../receipts/signer.ts";
import { bearer, resolveKey, walletAuth } from "./auth.ts";
import { nullifierOf, parsePrivateToken } from "../blind/privacy-token.ts";

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

export function generationRoutes(app: Hono, ctx: Ctx) {
  // The caller's account's generations, newest first (receipt summaries; no content is ever stored).
  app.get("/api/v1/generations", async (c) => {
    const secret = bearer(c.req.header("authorization"));
    const key = secret ? await resolveKey(ctx, secret) : null;
    if (!key) fail(401, "Provide an API key as `Authorization: Bearer sk-ar-v1-...`.", "missing_key");
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const before = c.req.query("before");
    // A session key lists only its own calls, not the whole account's.
    const [session] = await ctx.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.keyHash, key.keyHash));
    const scope = session ? eq(generations.keyHash, key.keyHash) : eq(generations.accountId, key.accountId);
    const rows = await ctx.db
      .select()
      .from(generations)
      .where(and(scope, ...(before ? [lt(generations.ts, new Date(before))] : [])))
      .orderBy(desc(generations.ts))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({ data: page.map(generationSummary), next: rows.length > limit ? page[page.length - 1].ts.toISOString() : null });
  });

  app.get("/api/v1/generation", async (c) => {
    const id = c.req.query("id");
    if (!id) fail(400, "Pass ?id=<generation id>.", "invalid_request");
    const [g] = await ctx.db.select().from(generations).where(eq(generations.id, id));
    if (!g) fail(404, "Generation not found.", "not_found");
    // Owner-only: the key (or any key on the same account) or the paying wallet.
    const secret = bearer(c.req.header("authorization"));
    let allowed = false;
    if (secret) {
      const key = await resolveKey(ctx, secret);
      allowed = !!key && key.accountId === g.accountId;
    } else if (c.req.header("x-wallet-auth")) {
      const w = await walletAuth(ctx, c.req.header("x-wallet-auth")!, (await import("../lib/util.ts")).sha256(""));
      allowed = w.accountId === g.accountId;
    } else if (ctx.blind) {
      // A blind redemption has no account. Whoever holds the spent token owns its receipt: the token hashes to the
      // nullifier recorded against this generation.
      const token = parsePrivateToken(c.req.header("authorization"));
      if (token) {
        const [spent] = await ctx.db.select({ id: blindNullifiers.generationId }).from(blindNullifiers).where(eq(blindNullifiers.nullifier, nullifierOf(token)));
        allowed = !!spent && spent.id === g.id;
      }
    }
    if (!allowed) fail(404, "Generation not found.", "not_found");
    let paidWith = g.paidWith as Record<string, unknown> | null;
    if (paidWith) {
      const [d] = await ctx.db.select().from(paywithDebts).where(eq(paywithDebts.generationId, g.id));
      if (d?.swapId) {
        const [s] = await ctx.db.select().from(paywithSwaps).where(eq(paywithSwaps.id, d.swapId));
        paidWith = { ...paidWith, raw_units: d.rawAllocated?.toString() ?? paidWith.raw_units, fair_price: s?.fairPrice ?? paidWith.fair_price, swap_tx: s?.tx ?? null, status: s?.status === "confirmed" ? "settled" : "accrued" };
      }
    }
    return c.json({
      data: {
        id: g.id,
        model: g.modelId,
        provider_name: g.providerId,
        created_at: g.ts.toISOString(),
        generation_time: g.generationTimeMs,
        latency: g.latencyMs,
        native_tokens_prompt: g.tokensIn,
        native_tokens_completion: g.tokensOut,
        native_tokens_reasoning: g.reasoningTokens,
        native_tokens_cached: g.cachedTokens,
        tokens_prompt: g.tokensIn,
        tokens_completion: g.tokensOut,
        total_cost: picoToUsd(g.cost),
        upstream_inference_cost: picoToUsd(g.upstreamCost),
        royalty: picoToUsd(g.royalty),
        margin: picoToUsd(g.margin),
        cache_discount: picoToUsd(g.cacheDiscount),
        finish_reason: g.finishReason,
        native_finish_reason: g.nativeFinishReason,
        streamed: g.streamed,
        cancelled: g.cancelled,
        quantization: g.quant,
        data_region: g.dataRegion,
        is_byok: g.isByok,
        mode: g.mode,
        private: g.private,
        attestation_hash: g.attestationHash,
        receipt_sig: g.receiptSig,
        receipt_key_id: g.receiptKeyId,
        receipt: g.receipt,
        receipt_leaf: g.receiptLeaf,
        paid_with: paidWith,
        payment_tx: g.paymentTx,
        attempts: g.attempts,
        anchor: await anchorProof(ctx, g),
      },
    });
  });
}

/** Stateless receipt verification (signature + optional anchor inclusion). */
export async function verifyReceipt(ctx: Ctx, r: { payload: unknown; sig: string; key_id: string; anchor?: { root: string; proof: string[]; index?: number } }) {
  const key = await ctx.signer.publicKey(r.key_id);
  const onchainKey = await ctx.chain.signingKeyOnChain(r.key_id).catch(() => null);
  const pubHex = onchainKey ? onchainKey.publicKey.slice(2) : key?.publicKeyHex;
  const signatureValid = !!pubHex && verifyWithRawKey(r.payload, r.sig, pubHex);
  const leaf = receiptLeaf(canonicalBytes(r.payload), Buffer.from(r.sig, "base64"));
  let inclusion: boolean | null = null;
  let onchainRoot: string | null = null;
  if (r.anchor?.root && Array.isArray(r.anchor.proof)) {
    inclusion = MerkleTree.verify(leaf, r.anchor.proof as Hex[], r.anchor.root as Hex);
    if (r.anchor.index != null) {
      const a = await ctx.chain.anchorOnChain(r.anchor.index).catch(() => null);
      onchainRoot = a?.root ?? null;
      if (onchainRoot && onchainRoot.toLowerCase() !== r.anchor.root.toLowerCase()) inclusion = false;
    }
  }
  return {
    signature_valid: signatureValid,
    key_source: onchainKey ? "chain" : key ? "router" : null,
    key_retired_at: key?.retiredAt?.toISOString() ?? null,
    leaf,
    inclusion_valid: inclusion,
    onchain_root: onchainRoot,
    valid: signatureValid && inclusion !== false,
  };
}

export { and };
