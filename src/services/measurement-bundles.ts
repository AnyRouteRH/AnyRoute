import type { KeyObject } from "node:crypto";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { measurementBundles, measurements, providers } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import {
  asBytes32,
  bundleBytes,
  bundleMismatch,
  digestHex,
  keyId,
  parseBundle,
  parsePublicKey,
  sameKey,
  verifyBundleEntry,
  verifySignature,
  type MeasurementBundle,
} from "./measurement-bundle.ts";
import { parseRekorEntry, rekorEntryRaw, rekorSearch, runMeasurements, type FetchFn, type IsAttestedReader, type RawRekorEntry } from "./measurements.ts";

// Measurement bundles in the router (see measurement-bundle.ts for what a bundle is).
//
//   1. An operator hands over a bundle, its signature and (usually) the uuid of its transparency-log entry
//      (submitBundle). The router checks the bundle against the measurement key it is configured with and stores it.
//   2. The watcher fetches the entry from the log (by uuid, or by searching for the bundle digest) and verifies it:
//      the entry is included in the log, holds the bundle's sha256, carries the measurement key and a signature by it
//      over the bundle (verifyBundleEntry). Only then is the bundle "verified".
//   3. A verified bundle is applied to the measurement rows recorded from verified quotes with the same provider and
//      compose hash, provided the quote-committed image and model digests (and MRTD / RTMR3 when the bundle lists them)
//      are the ones the bundle names. The row then carries this entry as its transparency-log entry, which is what the
//      attestation record and the verify page report.
//
// Off unless MEASUREMENT_PUBLIC_KEY is set. Nothing here submits anything to a log.

type BundleRow = typeof measurementBundles.$inferSelect;
export type BundleStatus = "pending" | "verified" | "rejected";

const MAX_ENTRIES_PER_DIGEST = 5;
const UUID = /^(?:[0-9a-f]{16})?[0-9a-f]{64}$/;

/** The measurement key the router trusts, or null when bundle checking is off. */
export function trustedKey(ctx: Ctx): KeyObject | null {
  const pem = ctx.cfg.measurements.publicKey;
  return pem ? parsePublicKey(pem) : null;
}

export const entryUrl = (ctx: Ctx, uuid: string) => `${ctx.cfg.measurements.rekorUrl}/api/v1/log/entries/${uuid}`;

// ---- Intake ------------------------------------------------------------------------------------------------

export type BundleInput = { bundle: unknown; signature: string; rekorUuid?: string | null };

/** Store a bundle an operator publishes, after checking it names and is signed by the trusted key, then check its log
 *  entry right away. Idempotent: the same bundle again returns the existing row (a rejected one becomes pending again). */
export async function submitBundle(ctx: Ctx, input: BundleInput, opts: { fetchImpl?: FetchFn } = {}) {
  const key = trustedKey(ctx);
  if (!key) fail(501, "Measurement bundles are off: MEASUREMENT_PUBLIC_KEY is not set.", "not_configured");
  let bundle: MeasurementBundle;
  try {
    bundle = parseBundle(input.bundle);
  } catch (e) {
    return fail(400, (e as Error).message, "invalid_bundle");
  }
  const uuid = input.rekorUuid ? input.rekorUuid.toLowerCase() : null;
  if (uuid && !UUID.test(uuid)) fail(400, "rekor_uuid must be a Rekor entry uuid (64 or 80 hex).", "invalid_bundle");
  const [provider] = await ctx.db.select({ id: providers.id }).from(providers).where(eq(providers.id, bundle.provider));
  if (!provider) fail(404, "Unknown provider.", "not_found");
  let named: KeyObject;
  try {
    named = parsePublicKey(bundle.signer.public_key_pem);
  } catch {
    return fail(400, "The bundle's signer key is not a P-256 public key.", "untrusted_signer");
  }
  if (bundle.signer.key_id !== keyId(key) || !sameKey(named, key)) fail(400, "The bundle names a different signing key than the one this router trusts.", "untrusted_signer");
  const bytes = bundleBytes(bundle);
  if (!verifySignature(bytes, input.signature, key)) fail(400, "The signature does not verify against the bundle.", "bad_signature");

  const digest = `0x${digestHex(bytes)}`;
  const now = new Date();
  await ctx.db
    .insert(measurementBundles)
    .values({ providerId: bundle.provider, composeHash: asBytes32(bundle.compose_hash), bundleDigest: digest, bundle, signature: input.signature, signerKeyId: keyId(key), rekorUuid: uuid })
    .onConflictDoNothing();
  const [existing] = await ctx.db.select().from(measurementBundles).where(and(eq(measurementBundles.providerId, bundle.provider), eq(measurementBundles.bundleDigest, digest)));
  let row = existing!;
  if (row.status === "rejected" || (uuid && !row.rekorUuid)) {
    [row] = await ctx.db
      .update(measurementBundles)
      .set({ status: row.status === "rejected" ? "pending" : row.status, error: null, rekorUuid: uuid ?? row.rekorUuid, updatedAt: now })
      .where(eq(measurementBundles.id, row.id))
      .returning();
  }
  if (row.status === "pending") {
    try {
      await checkBundle(ctx, row, key, opts.fetchImpl ?? fetch);
    } catch (e) {
      // An unreachable log is not a verdict; the watcher tries again.
      log.warn("checking a submitted measurement bundle failed", { provider: bundle.provider, error: (e as Error).message });
    }
  }
  await applyVerifiedBundles(ctx);
  const [fresh] = await ctx.db.select().from(measurementBundles).where(eq(measurementBundles.id, row.id));
  return bundleView(ctx, fresh!, { entry: false });
}

// ---- Verification ------------------------------------------------------------------------------------------

/** Verify one stored bundle against the log and move it to verified, rejected or leave it pending. Throws only for
 *  transport errors, which the caller records against the row. */
export async function checkBundle(ctx: Ctx, row: BundleRow, key: KeyObject, f: FetchFn): Promise<BundleStatus> {
  const now = new Date();
  const settle = async (status: BundleStatus, error: string | null, extra: Partial<typeof measurementBundles.$inferInsert> = {}) => {
    await ctx.db.update(measurementBundles).set({ status, error, checkedAt: now, updatedAt: now, ...extra }).where(eq(measurementBundles.id, row.id));
    return status;
  };

  // What was stored must still be what was signed, by the key the router trusts now.
  let bundle: MeasurementBundle;
  try {
    bundle = parseBundle(row.bundle);
  } catch (e) {
    return settle("rejected", (e as Error).message.slice(0, 300));
  }
  const bytes = bundleBytes(bundle);
  if (`0x${digestHex(bytes)}` !== row.bundleDigest) return settle("rejected", "the stored bundle does not match its digest");
  if (!verifySignature(bytes, row.signature, key)) return settle("rejected", "the bundle's signature does not verify against the trusted measurement key");

  const base = ctx.cfg.measurements.rekorUrl;
  const explicit = !!row.rekorUuid;
  const uuids = row.rekorUuid ? [row.rekorUuid] : (await rekorSearch(f, base, row.bundleDigest as `0x${string}`)).slice(0, MAX_ENTRIES_PER_DIGEST);
  if (!uuids.length) return settle("pending", "no transparency-log entry for this bundle digest yet");

  const good: { uuid: string; raw: RawRekorEntry; leaf: string; checkpoint: boolean; set: boolean; time: number; index: number }[] = [];
  let failure: { reason: string; retry: boolean } | null = null;
  for (const uuid of uuids) {
    const raw = await rekorEntryRaw(f, base, uuid);
    if (!raw) {
      failure = { reason: `the log has no entry ${uuid}`, retry: true };
      continue;
    }
    const entry = parseRekorEntry(uuid, raw);
    const c = verifyBundleEntry(entry, { bytes, publicKey: key, rekorPublicKey: ctx.cfg.measurements.rekorPublicKey });
    if (c.ok) good.push({ uuid, raw, leaf: c.leafHash, checkpoint: c.checkpointVerified, set: c.setVerified, time: entry.integratedTime ?? Infinity, index: entry.logIndex ?? Infinity });
    else failure = c;
  }
  good.sort((a, b) => a.time - b.time || a.index - b.index);
  const hit = good[0];
  if (!hit) {
    // An entry an operator named that does not verify is a verdict. Entries found by searching may belong to anyone who
    // logged the same hash with another key, so they never reject the bundle.
    const definitive = explicit && !!failure && !failure.retry;
    return settle(definitive ? "rejected" : "pending", (failure?.reason ?? "no verifiable entry").slice(0, 300));
  }
  return settle("verified", null, {
    rekorUuid: hit.uuid,
    rekorEntry: `0x${hit.leaf}`,
    rekorLogIndex: Number.isSafeInteger(hit.raw.logIndex) ? hit.raw.logIndex : null,
    rekorIntegratedAt: Number.isSafeInteger(hit.raw.integratedTime) ? new Date(hit.raw.integratedTime * 1000) : null,
    rekorEntryJson: hit.raw,
    rekorInclusionVerified: true,
    rekorCheckpointVerified: hit.checkpoint,
    rekorSetVerified: hit.set,
    verifiedAt: now,
  });
}

/** Give each measurement row the transparency-log entry of the newest verified bundle for its provider and compose hash,
 *  if the bundle describes what the quote committed to. Rows whose calldata was sent, and registered rows, are left alone. */
export async function applyVerifiedBundles(ctx: Ctx): Promise<{ applied: number; mismatched: number }> {
  const bundles = await ctx.db.select().from(measurementBundles).where(eq(measurementBundles.status, "verified")).orderBy(desc(measurementBundles.verifiedAt), desc(measurementBundles.id));
  const seen = new Set<string>();
  let applied = 0;
  let mismatched = 0;
  for (const b of bundles) {
    const pair = `${b.providerId}|${b.composeHash}`;
    if (seen.has(pair) || !b.rekorUuid) continue;
    seen.add(pair);
    let bundle: MeasurementBundle;
    try {
      bundle = parseBundle(b.bundle);
    } catch {
      continue;
    }
    const rows = await ctx.db.select().from(measurements).where(and(eq(measurements.providerId, b.providerId), eq(measurements.composeHash, b.composeHash), isNull(measurements.revokedAt)));
    for (const row of rows) {
      if (row.rekorUuid === b.rekorUuid && row.rekorInclusionVerified && row.rekorCheckpointVerified === b.rekorCheckpointVerified) continue;
      if (row.txHash || row.status === "registered" || row.status === "revoked") continue;
      const why = bundleMismatch(bundle, row);
      const now = new Date();
      if (why) {
        mismatched++;
        if (!row.rekorInclusionVerified) await ctx.db.update(measurements).set({ rekorCheckedAt: now, rekorError: `measurement bundle ${b.bundleDigest.slice(0, 18)}: ${why}`, updatedAt: now }).where(eq(measurements.id, row.id));
        continue;
      }
      // A new entry replaces calldata built for the old one; the keeper builds it again.
      const changed = row.rekorEntry !== b.rekorEntry;
      const done = await ctx.db
        .update(measurements)
        .set({
          status: row.status === "observed" ? "ready" : row.status,
          rekorUuid: b.rekorUuid,
          rekorEntry: b.rekorEntry,
          rekorLogIndex: b.rekorLogIndex,
          rekorKind: "hashedrekord",
          rekorIntegratedAt: b.rekorIntegratedAt,
          rekorInclusionVerified: true,
          rekorCheckpointVerified: b.rekorCheckpointVerified,
          rekorCheckedAt: now,
          rekorError: null,
          ...(changed ? { calldata: null, calldataTarget: null, calldataBuiltAt: null } : {}),
          updatedAt: now,
        })
        .where(and(eq(measurements.id, row.id), isNull(measurements.txHash), isNull(measurements.revokedAt), ne(measurements.status, "registered")))
        .returning({ id: measurements.id });
      if (done.length) applied++;
    }
  }
  return { applied, mismatched };
}

/** Verify pending bundles, then apply verified ones. */
export async function watchBundles(ctx: Ctx, opts: { fetchImpl?: FetchFn; limit?: number } = {}) {
  const key = trustedKey(ctx);
  if (!key) return { skipped: "no MEASUREMENT_PUBLIC_KEY" };
  const f = opts.fetchImpl ?? fetch;
  const rows = await ctx.db
    .select()
    .from(measurementBundles)
    .where(eq(measurementBundles.status, "pending"))
    .orderBy(sql`${measurementBundles.checkedAt} asc nulls first`, asc(measurementBundles.id))
    .limit(opts.limit ?? 25);
  const tally = { checked: rows.length, verified: 0, pending: 0, rejected: 0, failed: 0 };
  for (const row of rows) {
    try {
      const status = await checkBundle(ctx, row, key, f);
      tally[status === "verified" ? "verified" : status === "rejected" ? "rejected" : "pending"]++;
    } catch (e) {
      tally.failed++;
      log.warn("measurement bundle lookup failed", { provider: row.providerId, error: (e as Error).message });
      const now = new Date();
      await ctx.db.update(measurementBundles).set({ checkedAt: now, error: (e as Error).message.slice(0, 200), updatedAt: now }).where(eq(measurementBundles.id, row.id));
    }
  }
  return { ...tally, ...(await applyVerifiedBundles(ctx)) };
}

/** The measurements job with bundle checking in front: bundles first, so that the keeper's calldata already carries the
 *  bundle's entry. Equal to runMeasurements when no measurement key is configured. */
export async function runMeasurementJob(ctx: Ctx, opts: { fetchImpl?: FetchFn; read?: IsAttestedReader } = {}) {
  if (!ctx.cfg.measurements.enabled) return { skipped: "MEASUREMENTS_ENABLED is false" };
  const bundles = ctx.cfg.measurements.publicKey ? await watchBundles(ctx, { fetchImpl: opts.fetchImpl }) : undefined;
  const base = await runMeasurements(ctx, opts);
  return bundles ? { ...base, bundles } : base;
}

// ---- Public views ------------------------------------------------------------------------------------------

export function bundleView(ctx: Ctx, row: BundleRow, o: { entry?: boolean } = {}) {
  return {
    id: row.id,
    provider: row.providerId,
    status: row.status as BundleStatus,
    compose_hash: row.composeHash,
    bundle_digest: row.bundleDigest,
    signer_key_id: row.signerKeyId,
    created_at: (row.bundle as { created_at?: string }).created_at ?? null,
    transparency_log: {
      uuid: row.rekorUuid,
      entry: row.rekorEntry,
      entry_url: row.rekorUuid ? entryUrl(ctx, row.rekorUuid) : null,
      log_index: row.rekorLogIndex,
      integrated_at: row.rekorIntegratedAt?.toISOString() ?? null,
      inclusion_verified: row.rekorInclusionVerified,
      checkpoint_signature_verified: row.rekorCheckpointVerified,
      signed_entry_timestamp_verified: row.rekorSetVerified,
    },
    error: row.error,
    checked_at: row.checkedAt?.toISOString() ?? null,
    verified_at: row.verifiedAt?.toISOString() ?? null,
    bundle: row.bundle,
    signature: row.signature,
    // The entry as the log returned it (body, inclusion proof, signed entry timestamp), so a verifier need not ask the log.
    ...(o.entry === false ? {} : { entry_record: row.rekorEntryJson }),
  };
}

export async function listBundles(ctx: Ctx, providerId: string, limit = 20) {
  const rows = await ctx.db.select().from(measurementBundles).where(eq(measurementBundles.providerId, providerId)).orderBy(desc(measurementBundles.id)).limit(limit);
  return rows.map((r) => bundleView(ctx, r));
}

/** The verified bundle whose log entry is `uuid`, when it is for this provider and compose hash. */
export async function verifiedBundleForEntry(ctx: Ctx, providerId: string, composeHash: string, uuid: string): Promise<BundleRow | null> {
  const [row] = await ctx.db
    .select()
    .from(measurementBundles)
    .where(and(eq(measurementBundles.providerId, providerId), eq(measurementBundles.composeHash, composeHash), eq(measurementBundles.status, "verified"), eq(measurementBundles.rekorUuid, uuid)));
  return row ?? null;
}
