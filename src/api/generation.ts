import type { Hono } from "hono";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import { agentSessions, anchors, blindNullifiers, facilitatorSettlements, generations, paywithDebts, paywithSwaps } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { MerkleTree, receiptLeaf } from "../receipts/merkle.ts";
import { canonicalBytes, inspectCose, verifyCoseWithRawKey, verifyWithRawKey } from "../receipts/signer.ts";
import { chainOf, receiptLeafV2 } from "../receipts/v2.ts";
import { bearer, resolveKey, walletAuth } from "./auth.ts";
import { nullifierOf, parsePrivateToken } from "../blind/privacy-token.ts";

/** Rebuild an anchor's tree from the stored leaf positions (v1 leaves, and v2 leaves where a receipt has one). */
async function anchorTree(ctx: Ctx, anchorIndex: number) {
  const rows = await ctx.db
    .select({ leaf: generations.receiptLeaf, leafIndex: generations.leafIndex, leafV2: generations.receiptLeafV2, leafIndexV2: generations.leafIndexV2 })
    .from(generations)
    .where(eq(generations.anchorIndex, anchorIndex))
    .orderBy(asc(generations.leafIndex));
  const leaves: Hex[] = [];
  for (const r of rows) {
    if (r.leafIndex != null) leaves[r.leafIndex] = r.leaf as Hex;
    if (r.leafIndexV2 != null && r.leafV2) leaves[r.leafIndexV2] = r.leafV2 as Hex;
  }
  // v6 F: facilitator settlement receipts rooted in the same anchor.
  const settled = await ctx.db.select({ leaf: facilitatorSettlements.receiptLeaf, leafIndex: facilitatorSettlements.leafIndex }).from(facilitatorSettlements).where(eq(facilitatorSettlements.anchorIndex, anchorIndex));
  for (const s of settled) if (s.leafIndex != null && s.leaf) leaves[s.leafIndex] = s.leaf as Hex;
  return new MerkleTree(leaves);
}

export async function anchorProof(ctx: Ctx, g: { anchorIndex: number | null; leafIndex: number | null; leafIndexV2?: number | null }, version: 1 | 2 = 1) {
  const leafIndex = version === 2 ? (g.leafIndexV2 ?? null) : g.leafIndex;
  if (g.anchorIndex == null || leafIndex == null) return null;
  const [a] = await ctx.db.select().from(anchors).where(eq(anchors.index, g.anchorIndex));
  if (!a) return null;
  const tree = await anchorTree(ctx, g.anchorIndex);
  return {
    root: a.root,
    index: a.index,
    leaf_index: leafIndex,
    proof: tree.proof(leafIndex),
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
    const scope = session || key.scope === "inference" ? /* ZK6: own calls only */ eq(generations.keyHash, key.keyHash) : eq(generations.accountId, key.accountId);
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
      allowed = !!key && key.accountId === g.accountId && (key.scope !== "inference" || key.keyHash === g.keyHash); // ZK6
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
        // v2 buckets the counts above; this owner-only view keeps them exact.
        receipt_v2: g.receiptCose ? { claims: g.receiptV2, cose: g.receiptCose, leaf: g.receiptLeafV2 } : null,
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

/**
 * Stateless v2 verification, in the spec's order: COSE signature, then the hashes the caller supplied, then the
 * chunk chain head (when the caller supplies the streamed event data), then anchor inclusion. Stops at nothing: every
 * step is reported, and `valid` is false when any step that ran failed.
 */
export async function verifyReceiptV2(
  ctx: Ctx,
  r: { cose: string; request_sha256?: string; response_sha256?: string; chunks?: string[]; anchor?: { root: string; proof: string[]; index?: number } },
) {
  const cose = Buffer.from(r.cose, "base64");
  let inspected: ReturnType<typeof inspectCose> | null = null;
  try {
    inspected = inspectCose(cose);
  } catch (e) {
    return { version: 2, valid: false, error: `not a COSE_Sign1 receipt: ${(e as Error).message}`, signature_valid: false, key_id: null, claims: null, leaf: null, hashes_valid: null, chain_valid: null, inclusion_valid: null, onchain_root: null, key_source: null };
  }
  const keyId = inspected.keyId ?? "";
  const key = keyId ? await ctx.signer.publicKey(keyId) : null;
  const onchainKey = keyId ? await ctx.chain.signingKeyOnChain(keyId).catch(() => null) : null;
  const pubHex = onchainKey ? onchainKey.publicKey.slice(2) : key?.publicKeyHex;
  const signatureValid = !!pubHex && verifyCoseWithRawKey(cose, pubHex);
  const claims = inspected.claims;
  const strip = (h: string) => h.replace(/^sha256:/, "").toLowerCase();
  let hashes: boolean | null = null;
  if (r.request_sha256 != null || r.response_sha256 != null) {
    hashes = (r.request_sha256 == null || strip(r.request_sha256) === strip(claims.req?.h ?? "")) && (r.response_sha256 == null || strip(r.response_sha256) === strip(claims.resp?.h ?? ""));
  }
  let chain: boolean | null = null;
  if (Array.isArray(r.chunks)) chain = typeof claims.resp?.chain === "string" && chainOf(claims.rid, r.chunks).head === claims.resp.chain;
  const leaf = receiptLeafV2(cose);
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
    version: 2,
    signature_valid: signatureValid,
    key_id: keyId || null,
    key_source: onchainKey ? "chain" : key ? "router" : null,
    key_retired_at: key?.retiredAt?.toISOString() ?? null,
    claims,
    leaf,
    hashes_valid: hashes,
    chain_valid: chain,
    inclusion_valid: inclusion,
    onchain_root: onchainRoot,
    valid: signatureValid && claims?.v === 2 && hashes !== false && chain !== false && inclusion !== false,
  };
}

export { and };
