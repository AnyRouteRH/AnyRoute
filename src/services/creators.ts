import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { keccak256, toBytes, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { laneClaims, models, modelsLane } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import * as hf from "./hf.ts";

// Creator royalties for open-weights models. The uploader of a model's weights proves who they are with a
// challenge:
//
//   1. POST /api/v1/creators/claims   {model, address}   -> the router issues a challenge string
//   2. the uploader commits a file containing the challenge on its own line to the main branch of the model's
//      Hugging Face repository (the repository the operator recorded as the model's weights source)
//   3. POST /api/v1/creators/claims/{id}/verify          -> the router reads the repository's owner and the file
//      through the Hugging Face API, and on a match records the address as the model's royalty recipient
//
// Recording a recipient is the same step the existing claim flow takes: models.creator and models.royalty_bps
// are set (the price of every later call to the model then includes the royalty, see router/pricing.ts), the
// recipient is registered in Royalty.sol when a royalty contract and a router role are configured, and the hourly
// settlement streams the accrued USDG to it. The default is DEFAULT_ROYALTY_BPS (5%); the contract caps it at 20%.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const MAX_ROYALTY_BPS = 2000;

/** The royalty a new recipient gets, in basis points. */
export const royaltyBps = (ctx: Ctx) => Math.min(MAX_ROYALTY_BPS, Math.max(0, Math.trunc(ctx.cfg.fees.defaultRoyaltyBps)));

/**
 * Record `address` as the royalty recipient of a model: on chain first (when configured), then in the catalog, so a
 * failed registration leaves nothing half done and the claim can be verified again.
 */
export async function recordRoyaltyRecipient(ctx: Ctx, modelId: string, address: string, bps: number): Promise<{ tx: string | null }> {
  let tx: string | null = null;
  if (ctx.chain.address("royalty") && ctx.chain.roleAddress("router")) {
    try {
      tx = (await ctx.chain.registerRoyalty(keccak256(toBytes(modelId)), address as Hex, bps)).hash;
    } catch (e) {
      fail(502, `Verified, but on-chain registration failed: ${(e as Error).message.slice(0, 150)}`, "chain_failed");
    }
  }
  await ctx.db.update(models).set({ creator: address.toLowerCase(), royaltyBps: bps }).where(eq(models.id, modelId));
  await ctx.catalog.refresh();
  return { tx };
}

/** The repository whose owner may claim a model: the weights source an operator recorded for it. */
async function claimableRepo(ctx: Ctx, modelId: string): Promise<{ repo: string; handle: string }> {
  await ctx.catalog.ensureFresh();
  const model = ctx.catalog.models.get(modelId);
  if (!model) fail(404, "Unknown model.", "not_found");
  const source = ctx.catalog.lane.get(modelId)?.weightsSource ?? "";
  const repo = source.startsWith("huggingface:") ? source.slice("huggingface:".length) : "";
  if (!hf.isRepoId(repo))
    fail(409, "This model has no Hugging Face weights source on record, so there is nothing to prove ownership of. Ask the operator to record one.", "not_claimable");
  return { repo, handle: repo.split("/")[0] };
}

const view = (c: typeof laneClaims.$inferSelect, file: string) => ({
  id: c.id,
  model: c.modelId,
  hugging_face_id: c.hfRepo,
  handle: c.handle,
  address: c.address,
  status: c.status,
  challenge: c.challenge,
  file,
  file_content: `${c.challenge}\n`,
  expires_at: c.expiresAt.toISOString(),
  verified_at: c.verifiedAt?.toISOString() ?? null,
  onchain_tx: c.onchainTx,
});

export async function issueClaim(ctx: Ctx, input: { model: string; address: string; handle?: string }, ip: string) {
  const modelId = input.model.toLowerCase();
  if (!ADDRESS.test(input.address) || /^0x0{40}$/.test(input.address)) fail(400, "`address` must be a 0x address.", "invalid_request");
  const lim = await ctx.limiter.take(`claim-issue:${modelId}`, 1, 10, 3_600_000);
  const limIp = await ctx.limiter.take(`claim-issue-ip:${ip}`, 1, 30, 3_600_000);
  if (!lim.ok || !limIp.ok) fail(429, "Too many claim attempts.", "rate_limited");
  const { repo, handle } = await claimableRepo(ctx, modelId);
  if (input.handle && input.handle.toLowerCase() !== handle.toLowerCase()) fail(400, `The weights source of this model belongs to ${handle}, not ${input.handle}.`, "handle_mismatch");
  const row = {
    id: `claim-${randomBytes(9).toString("base64url")}`,
    modelId,
    hfRepo: repo,
    handle,
    address: input.address.toLowerCase(),
    challenge: `anyroute-claim-${randomBytes(24).toString("hex")}`,
    status: "pending",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + ctx.cfg.lane.claim.ttlS * 1000),
    verifiedAt: null,
    onchainTx: null,
  };
  await ctx.db.insert(laneClaims).values(row);
  return { ...view(row, ctx.cfg.lane.claim.file), royalty_bps: royaltyBps(ctx) };
}

export async function readClaim(ctx: Ctx, id: string) {
  const [row] = await ctx.db.select().from(laneClaims).where(eq(laneClaims.id, id));
  if (!row) fail(404, "Unknown claim.", "not_found");
  return { ...view(row, ctx.cfg.lane.claim.file), expired: row.status === "pending" && row.expiresAt.getTime() <= Date.now() };
}

export async function verifyClaim(ctx: Ctx, id: string, ip: string, deps: { fetch?: typeof fetch } = {}) {
  const f = deps.fetch ?? ctx.hfFetch ?? fetch;
  const lim = await ctx.limiter.take(`claim-verify:${id}`, 1, 20, 3_600_000);
  const limIp = await ctx.limiter.take(`claim-verify-ip:${ip}`, 1, 60, 3_600_000);
  if (!lim.ok || !limIp.ok) fail(429, "Too many verification attempts.", "rate_limited");
  const [claim] = await ctx.db.select().from(laneClaims).where(eq(laneClaims.id, id));
  if (!claim) fail(404, "Unknown claim.", "not_found");
  const file = ctx.cfg.lane.claim.file;
  if (claim.status === "verified") return { ...view(claim, file), royalty_bps: royaltyBps(ctx), already_verified: true };
  if (claim.expiresAt.getTime() <= Date.now()) fail(410, "This claim has expired. Start a new one.", "claim_expired");

  // The claim is checked against the record as it is now, not as it was when the challenge was issued.
  const { repo, handle } = await claimableRepo(ctx, claim.modelId);
  if (repo.toLowerCase() !== claim.hfRepo.toLowerCase()) fail(409, "The weights source of this model changed since the claim was issued. Start a new one.", "claim_stale");

  let info: hf.HfModel | null;
  let text: string | null;
  try {
    info = await hf.modelInfo(f, ctx.cfg.hfBaseUrl, claim.hfRepo);
    if (info && !info.private && !info.disabled) text = await hf.repoFile(f, ctx.cfg.hfBaseUrl, claim.hfRepo, "main", file);
    else text = null;
  } catch (e) {
    fail(502, `Could not read the repository from Hugging Face (${(e as Error).message}). Try again shortly.`, "hf_unavailable");
  }
  if (!info || info.private || info.disabled) fail(400, `The repository ${claim.hfRepo} was not found or is not public.`, "claim_unverified");
  // The repository must still belong to the handle the challenge was issued to (a transferred or renamed repository does not carry a claim over).
  if (info.owner.toLowerCase() !== handle.toLowerCase()) fail(403, `The repository is now owned by ${info.owner}, not ${handle}.`, "claim_mismatch");
  if (text == null) fail(400, `Could not find ${file} on the main branch of ${claim.hfRepo}. Commit a file with that name containing the challenge on its own line.`, "claim_unverified");
  if (!text.split(/\r?\n/).some((line) => line.trim() === claim.challenge)) fail(403, `${file} does not contain the challenge issued for this claim.`, "claim_mismatch");

  const bps = royaltyBps(ctx);
  const { tx } = await recordRoyaltyRecipient(ctx, claim.modelId, claim.address, bps);
  const now = new Date();
  await ctx.db.update(laneClaims).set({ status: "verified", verifiedAt: now, onchainTx: tx }).where(eq(laneClaims.id, claim.id));
  await ctx.db.update(modelsLane).set({ creatorHandle: handle, updatedAt: now }).where(eq(modelsLane.modelId, claim.modelId));
  await ctx.catalog.refresh();
  const [done] = await ctx.db.select().from(laneClaims).where(eq(laneClaims.id, claim.id));
  return { ...view(done, file), royalty_bps: bps };
}
