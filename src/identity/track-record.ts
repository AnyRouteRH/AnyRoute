import { and, desc, eq, gt } from "drizzle-orm";
import type { Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { agentProfiles } from "../agents/profile-schema.ts";
import { trackRecordLeaves, trackRecordPayload } from "../agents/record-certificate.ts";
import { verifyTrackRecord, type TrackRecordCertificate } from "../agents/track-record-shared.ts";
import { anchorProof } from "../api/generation.ts";
import { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { MerkleTree } from "../receipts/merkle.ts";
import { receiptKeyEntry } from "../tlog/entries.ts";
import { agentRegistryId, documentHash, TRACK_RECORD_TAG, validationRequestCall, validationResponseCall } from "./erc8004.ts";
import { identityRow, optedOut } from "./identity.ts";
import { agentTrackRecords } from "./schema.ts";
import { signDocument } from "./signed.ts";

export const trackRecordUrl = (ctx: Ctx, id: string) => `${ctx.cfg.publicUrl}/api/v1/agents/track-records/${id}`;
export const trackRecordIdPattern = /^tr_[0-9a-f]{24}$/;

/** The signing key must be in the public key log before a certificate that names it is handed out (as for record certificates). */
async function publishSigningKey(ctx: Ctx, keyId: string) {
  if (!ctx.tlog) fail(503, "Track records require the signing key log (TLOG_ENABLED).", "record_key_log_unavailable");
  const signingKey = await ctx.signer.publicKey(keyId);
  if (!signingKey) fail(503, "Signing key unavailable.", "record_key_log_unavailable");
  const entry = receiptKeyEntry({ id: signingKey.id, publicKey: signingKey.publicKeyHex, validFrom: signingKey.validFrom });
  await ctx.tlog.append([entry]);
  if (!await ctx.tlog.lookup("receipt_key", entry.sha256)) fail(503, "Signing key publication unavailable.", "record_key_log_unavailable");
}

/**
 * The ERC-8004 validation entry this certificate is the payload of: requestHash commits to the signed payload at
 * requestURI, responseHash to the whole signed certificate. Calldata is prepared only when a validation registry,
 * a validator address and the agent's ERC-8004 id are all known; the router never sends it.
 */
export function validationEntry(ctx: Ctx, id: string, certificate: TrackRecordCertificate) {
  const registry = ctx.cfg.identity.registries.validation ?? null, validator = ctx.cfg.identity.validator ?? null;
  const agentId = certificate.payload.agent.erc8004?.agent_id ?? null;
  const requestUri = trackRecordUrl(ctx, id), requestHash = documentHash(certificate.payload), responseHash = documentHash(certificate);
  const status = !registry ? "registry_not_deployed" : !agentId ? "agent_not_registered" : !validator ? "validator_not_configured" : "ready";
  return {
    status,
    registry: registry ? agentRegistryId(ctx.cfg.chain.id, registry) : null,
    validator,
    agent_id: agentId,
    request_uri: requestUri,
    request_hash: requestHash,
    response: 100,
    response_uri: requestUri,
    response_hash: responseHash,
    tag: TRACK_RECORD_TAG,
    calldata: status === "ready" ? {
      request: { from: "the agent's owner", to: registry, data: validationRequestCall({ validator: validator as Hex, agentId: BigInt(agentId!), requestURI: requestUri, requestHash }) },
      response: { from: validator, to: registry, data: validationResponseCall({ requestHash, response: 100, responseURI: requestUri, responseHash, tag: TRACK_RECORD_TAG }) },
    } : null,
  };
}

export async function issueTrackRecord(ctx: Ctx, key: KeyRow, publish: boolean) {
  if (!ctx.tlog) fail(503, "Track records require the signing key log (TLOG_ENABLED).", "record_key_log_unavailable");
  if (!(await ctx.limiter.take(`agent-certificate:${key.accountId}`, 1, 5, 60_000)).ok) fail(429, "Too many certificate requests.", "rate_limited");
  const [profile] = await ctx.db.select({ slug: agentProfiles.slug }).from(agentProfiles).where(eq(agentProfiles.keyHash, key.keyHash));
  const identity = await identityRow(ctx, key.keyHash);
  const linked = !(await optedOut(ctx, key.keyHash, identity)) && identity?.status === "registered" && identity.agentId && identity.registry;
  const payload = await trackRecordPayload(ctx.db, ctx.cfg, key, { profile: profile?.slug ?? null, erc8004: linked ? { registry: identity!.registry!, agent_id: identity!.agentId! } : null });
  const certificate = signDocument(ctx, payload);
  await publishSigningKey(ctx, certificate.key_id);
  if (!verifyTrackRecord(certificate, { keys: await ctx.signer.jwks() })) fail(503, "Signing key is outside its issuance window; refresh the receipt signer.", "record_signing_key_unavailable");
  const id = uid("tr_");
  await ctx.db.insert(agentTrackRecords).values({ id, keyHash: key.keyHash, certificate, published: publish && !!profile, expiresAt: new Date(payload.expires_at) });
  return { id, url: trackRecordUrl(ctx, id), published: publish && !!profile, certificate, validation: validationEntry(ctx, id, certificate), proof_url: `${trackRecordUrl(ctx, id)}/proof?index=0` };
}

export async function trackRecordById(ctx: Ctx, id: string) {
  if (!trackRecordIdPattern.test(id)) return null;
  const [row] = await ctx.db.select().from(agentTrackRecords).where(eq(agentTrackRecords.id, id));
  return row ?? null;
}

/** The newest published, unexpired track record for a key (shown on its card). */
export async function publishedTrackRecord(ctx: Ctx, keyHash: string, now = new Date()) {
  const [row] = await ctx.db.select().from(agentTrackRecords).where(and(eq(agentTrackRecords.keyHash, keyHash), eq(agentTrackRecords.published, true), gt(agentTrackRecords.expiresAt, now))).orderBy(desc(agentTrackRecords.createdAt)).limit(1);
  return row ?? null;
}

const trees = new Map<string, { leaves: Hex[]; tree: MerkleTree | null; ids: Map<string, string> }>();
/** Rebuild the certificate's tree from the router's records; refuses when they no longer give the signed root. */
export async function trackRecordProof(ctx: Ctx, row: typeof agentTrackRecords.$inferSelect, index: number) {
  const payload = (row.certificate as TrackRecordCertificate).payload;
  let cached = trees.get(row.id);
  if (!cached) {
    const counted = payload.merkle.max_anchor_index == null ? { leaves: [] as Hex[], byLeaf: new Map() } : await trackRecordLeaves(ctx.db, row.keyHash, payload.merkle.max_anchor_index);
    cached = { leaves: counted.leaves, tree: counted.leaves.length ? new MerkleTree(counted.leaves) : null, ids: new Map([...counted.byLeaf].map(([leaf, g]) => [leaf, g.id])) };
    if (trees.size >= 32) trees.delete(trees.keys().next().value!);
    trees.set(row.id, cached);
  }
  if ((cached.tree?.root.toLowerCase() ?? null) !== payload.merkle.root || cached.leaves.length !== payload.merkle.leaf_count) fail(410, "The receipts behind this certificate are no longer all retained.", "track_record_receipts_changed");
  if (!Number.isInteger(index) || index < 0 || index >= cached.leaves.length) fail(404, "No counted receipt at that index.", "not_found");
  const leaf = cached.leaves[index];
  const [g] = await ctx.db.select({ anchorIndex: generations.anchorIndex, leafIndex: generations.leafIndex }).from(generations).where(eq(generations.id, cached.ids.get(leaf)!));
  return { index, leaf, root: payload.merkle.root, proof: cached.tree!.proof(index), anchor: g ? await anchorProof(ctx, g) : null };
}
