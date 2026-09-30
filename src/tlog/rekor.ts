import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { tlogRekorAnchors } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { hashedrekordEntry, keyId, publicKeyPem, SIGNATURE_ALGORITHM, signBytes, verifyBundleEntry } from "../services/measurement-bundle.ts";
import { parseRekorEntry, type RawRekorEntry } from "../services/measurements.ts";
import { fetchRekorEntry, RekorHttpError, submitToRekor, withInclusionProof } from "../services/rekor-client.ts";

// Public-log anchoring: every checkpoint the log moves to is recorded in a Sigstore Rekor log that Anyroute does not run.
//
// The entry is a Rekor `hashedrekord` (the type measurement bundles use) over the artifact
//
//   <checkpoint text>\n<the log's own signature line>
//
// that is, the checkpoint as the log signed it without cosignatures, signed with ECDSA P-256 / SHA-256 by a dedicated
// anchoring key (TLOG_REKOR_SIGNING_KEY). Anyone holding a checkpoint can hash that artifact and find its entry in Rekor.
// Every entry signed with the anchoring key is public and timestamped, so a second history (a checkpoint of the same size
// with another root) shown to some clients needs a second entry there, visible to anyone who follows the key's entries,
// and a client that requires an anchor refuses a checkpoint that has none.
//
// The job submits when the newest checkpoint is not anchored yet and at most once per TLOG_REKOR_MIN_INTERVAL_MS. After a
// submission the entry's inclusion proof is verified the way measurement bundles are (verifyBundleEntry: the uuid names
// the body, the body is this artifact under this key with a valid signature, the proof leads to the root, and with
// REKOR_PUBLIC_KEY Rekor's signed checkpoint and signed entry timestamp). An entry that comes back without a proof is kept
// as pending and read again on the next run instead of being submitted twice. Failures back off exponentially and are
// logged as codes only. Nothing here runs on the path that publishes keys: key publication never waits for Rekor.

type RekorConfig = Config["tlog"]["rekor"];
export type AnchorRow = typeof tlogRekorAnchors.$inferSelect;
type CheckpointLike = { size: number; rootHash: string; checkpoint: string; signature: string };

export const PUBLIC_REKOR_URL = "https://rekor.sigstore.dev";
const MAX_BACKOFF_MS = 4 * 3_600_000;
/** Reads of a new entry that came back without an inclusion proof, a second apart, before it is kept as pending. */
const PROOF_TRIES = 5;

/** The bytes a checkpoint's Rekor entry commits to: the checkpoint text, a blank line and the log's own signature line. */
export const anchorArtifact = (cp: Pick<CheckpointLike, "checkpoint" | "signature">): Buffer => Buffer.from(`${cp.checkpoint}\n${cp.signature}`);

export type AnchorResult =
  | { status: "anchored" | "pending"; size: number; uuid: string; logIndex: number | null }
  | { status: "unchanged" | "throttled" | "backoff" | "empty"; size?: number }
  | { status: "failed"; size?: number; code: string };

class AnchorError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A short code for a failure, never text from Rekor or a key. */
function codeOf(e: unknown): string {
  if (e instanceof AnchorError) return e.code;
  if (e instanceof RekorHttpError) return e.status ? `rekor_http_${e.status}` : "rekor_bad_answer";
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "rekor_timeout";
  if (e instanceof TypeError) return "rekor_unreachable";
  return "anchor_error";
}

export class RekorAnchor {
  readonly url: string;
  readonly publicKey: KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: string;
  readonly minIntervalMs: number;
  readonly rekorPublicKey: string | null;
  /** Test hooks: the clock (milliseconds), the HTTP client and the pause between reads of a new entry. */
  now: () => number = () => Date.now();
  fetch: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch;
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  private readonly signingKey: KeyObject;
  private lastAttemptAt = 0;
  private failures = 0;
  private retryAt = 0;

  constructor(
    private readonly db: Db,
    cfg: RekorConfig,
  ) {
    if (!cfg.signingKey) throw new Error("Rekor anchoring needs TLOG_REKOR_SIGNING_KEY");
    this.signingKey = cfg.signingKey;
    this.publicKey = createPublicKey(cfg.signingKey);
    this.publicKeyPem = publicKeyPem(this.publicKey);
    this.keyId = keyId(this.publicKey);
    this.url = cfg.url;
    this.minIntervalMs = cfg.minIntervalMs;
    this.rekorPublicKey = cfg.rekorPublicKey;
  }

  // ---- reading ---------------------------------------------------------------------------------------------------

  private current() {
    return and(eq(tlogRekorAnchors.status, "verified"), eq(tlogRekorAnchors.rekorUrl, this.url), eq(tlogRekorAnchors.keyId, this.keyId));
  }

  /** The newest verified anchor, in the configured Rekor log under the configured key, of a checkpoint of at least `minSize`. */
  async latest(minSize = 0): Promise<AnchorRow | null> {
    const [row] = await this.db.select().from(tlogRekorAnchors).where(and(this.current(), gte(tlogRekorAnchors.size, minSize))).orderBy(desc(tlogRekorAnchors.size), desc(tlogRekorAnchors.id)).limit(1);
    return row ?? null;
  }

  /** The verified anchor of the checkpoint of this size (configured log and key), if there is one. */
  async at(size: number): Promise<AnchorRow | null> {
    const [row] = await this.db.select().from(tlogRekorAnchors).where(and(this.current(), eq(tlogRekorAnchors.size, size))).orderBy(desc(tlogRekorAnchors.id)).limit(1);
    return row ?? null;
  }

  /** Every verified anchor, newest checkpoint first (all logs and keys ever configured), `limit` at a time below `before`. */
  async list(limit: number, before?: number): Promise<AnchorRow[]> {
    const where = before === undefined ? eq(tlogRekorAnchors.status, "verified") : and(eq(tlogRekorAnchors.status, "verified"), sql`${tlogRekorAnchors.size} < ${before}`);
    return this.db.select().from(tlogRekorAnchors).where(where).orderBy(desc(tlogRekorAnchors.size), desc(tlogRekorAnchors.id)).limit(limit);
  }

  // ---- anchoring -------------------------------------------------------------------------------------------------

  /**
   * One pass of the job: finish entries still waiting for an inclusion proof, then submit the newest checkpoint when it
   * is not anchored yet and the minimum interval (and any backoff) has passed. Never throws.
   */
  async run(latest: CheckpointLike | null): Promise<AnchorResult> {
    try {
      await this.completePending();
    } catch (e) {
      log.warn("tlog rekor anchor: pending entry not read", { code: codeOf(e) });
    }
    if (!latest || latest.size === 0) return { status: "empty" };
    const now = this.now();
    let last: { size: number | null; at: Date | null };
    try {
      [last] = await this.db
        .select({ size: sql<number | null>`max(${tlogRekorAnchors.size})`, at: sql<Date | null>`max(${tlogRekorAnchors.createdAt})` })
        .from(tlogRekorAnchors)
        .where(and(eq(tlogRekorAnchors.rekorUrl, this.url), eq(tlogRekorAnchors.keyId, this.keyId)));
    } catch (e) {
      return this.failed(latest.size, e, now);
    }
    const anchoredSize = last?.size == null ? -1 : Number(last.size);
    if (anchoredSize >= latest.size) return { status: "unchanged", size: anchoredSize };
    if (now < this.retryAt) return { status: "backoff", size: latest.size };
    const lastAt = Math.max(this.lastAttemptAt, last?.at ? new Date(last.at).getTime() : 0);
    if (lastAt && now - lastAt < this.minIntervalMs) return { status: "throttled", size: latest.size };
    this.lastAttemptAt = now;
    try {
      const out = await this.submit(latest, now);
      this.failures = 0;
      this.retryAt = 0;
      if (out.status === "anchored") log.info("tlog checkpoint anchored in rekor", { size: out.size, log_index: out.logIndex });
      return out;
    } catch (e) {
      return this.failed(latest.size, e, now);
    }
  }

  private failed(size: number, e: unknown, now: number): AnchorResult {
    const code = codeOf(e);
    this.failures++;
    this.retryAt = now + Math.min(this.minIntervalMs * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    log.warn("tlog rekor anchor failed", { code, failures: this.failures });
    return { status: "failed", size, code };
  }

  private async submit(cp: CheckpointLike, now: number): Promise<AnchorResult> {
    const artifact = anchorArtifact(cp);
    const entry = hashedrekordEntry(artifact, signBytes(artifact, this.signingKey), this.publicKey);
    const posted = await submitToRekor(this.fetch, this.url, entry);
    const done = await withInclusionProof(this.fetch, this.url, posted, this.wait, PROOF_TRIES);
    const checked = this.check(done.uuid, done.raw, artifact);
    if (!checked.ok && !checked.retry) throw new AnchorError(checked.code);
    const base = {
      size: cp.size,
      rootHash: cp.rootHash,
      note: artifact.toString(),
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      keyId: this.keyId,
      rekorUrl: this.url,
      uuid: done.uuid.toLowerCase(),
      createdAt: new Date(now),
    };
    const values = checked.ok ? { ...base, ...checked.fields, status: "verified", verifiedAt: new Date(now) } : { ...base, status: "pending", entryBase64: done.raw.body };
    await this.db.insert(tlogRekorAnchors).values(values).onConflictDoNothing();
    const logIndex = checked.ok ? checked.fields.logIndex : null;
    return { status: checked.ok ? "anchored" : "pending", size: cp.size, uuid: base.uuid, logIndex };
  }

  /** Read entries that came back without an inclusion proof again, and verify them now. */
  private async completePending(): Promise<void> {
    const rows = await this.db.select().from(tlogRekorAnchors).where(eq(tlogRekorAnchors.status, "pending")).orderBy(desc(tlogRekorAnchors.size)).limit(5);
    for (const row of rows) {
      const got = await fetchRekorEntry(this.fetch, row.rekorUrl, row.uuid);
      const checked = this.check(got.uuid, got.raw, Buffer.from(row.note), row.keyId === this.keyId ? this.publicKey : null);
      if (checked.ok) {
        await this.db.update(tlogRekorAnchors).set({ ...checked.fields, status: "verified", verifiedAt: new Date(this.now()) }).where(and(eq(tlogRekorAnchors.id, row.id), eq(tlogRekorAnchors.status, "pending")));
        log.info("tlog checkpoint anchored in rekor", { size: row.size, log_index: checked.fields.logIndex });
      } else if (!checked.retry) {
        // Not an entry for this checkpoint under this key: forget it, so the checkpoint is submitted again.
        await this.db.delete(tlogRekorAnchors).where(and(eq(tlogRekorAnchors.id, row.id), eq(tlogRekorAnchors.status, "pending")));
        log.warn("tlog rekor anchor dropped", { code: checked.code });
      }
    }
  }

  /** verifyBundleEntry over the artifact, with the anchoring key; the fields to store when it passes. */
  private check(uuid: string, raw: RawRekorEntry, artifact: Buffer, key: KeyObject | null = this.publicKey) {
    if (!key) return { ok: false as const, retry: false, code: "key_changed" };
    const parsed = parseRekorEntry(uuid.toLowerCase(), raw);
    const v = verifyBundleEntry(parsed, { bytes: artifact, publicKey: key, rekorPublicKey: this.rekorPublicKey });
    if (!v.ok) return { ok: false as const, retry: v.retry, code: v.retry ? "no_inclusion_proof" : "entry_mismatch" };
    if (this.rekorPublicKey && !v.checkpointVerified) log.warn("tlog rekor anchor: rekor checkpoint signature does not verify", { code: "rekor_checkpoint_unverified" });
    const p = parsed.inclusionProof!;
    return {
      ok: true as const,
      fields: {
        logIndex: parsed.logIndex,
        integratedTime: parsed.integratedTime,
        logId: parsed.logId ?? null,
        entryBase64: parsed.body,
        inclusionProof: { logIndex: p.logIndex, treeSize: p.treeSize, rootHash: p.rootHash.toLowerCase(), hashes: p.hashes.map((h) => h.toLowerCase()), checkpoint: p.checkpoint ?? null },
        signedEntryTimestamp: parsed.signedEntryTimestamp ?? null,
        checkpointVerified: v.checkpointVerified,
        setVerified: v.setVerified,
      },
    };
  }
}

// ---- the public view ---------------------------------------------------------------------------------------------

/** An anchor as the JSON API serves it. Hashes in Rekor's own fields stay as Rekor writes them (hex); `root_hash` is
 *  base64 as in checkpoints. */
export function anchorView(row: AnchorRow) {
  const p = row.inclusionProof;
  return {
    size: row.size,
    root_hash: Buffer.from(row.rootHash, "hex").toString("base64"),
    note: row.note,
    artifact_sha256: row.artifactSha256,
    key_id: row.keyId,
    rekor_url: row.rekorUrl,
    uuid: row.uuid,
    log_index: row.logIndex,
    integrated_time: row.integratedTime,
    log_id: row.logId,
    entry_url: `${row.rekorUrl}/api/v1/log/entries/${row.uuid}`,
    search_url: row.rekorUrl === PUBLIC_REKOR_URL && row.logIndex != null ? `https://search.sigstore.dev/?logIndex=${row.logIndex}` : null,
    body: row.entryBase64,
    inclusion_proof: p ? { log_index: p.logIndex, tree_size: p.treeSize, root_hash: p.rootHash, hashes: p.hashes, checkpoint: p.checkpoint } : null,
    signed_entry_timestamp: row.signedEntryTimestamp,
    verified: { inclusion: row.status === "verified", checkpoint_signature: row.checkpointVerified, signed_entry_timestamp: row.setVerified },
    anchored_at: (row.verifiedAt ?? row.createdAt).toISOString(),
  };
}

export const ANCHOR_KEY_ALGORITHM = SIGNATURE_ALGORITHM;
