import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { MeasurementRegistryAbi } from "../chain/abis.ts";
import type { Ctx } from "../context.ts";
import { measurements } from "../db/schema.ts";
import { canonicalJson, log, sha256 } from "../lib/util.ts";
import { boundedJson } from "../providers/network.ts";

// Measurements: the image, compose and model digests a provider's confidential endpoint runs.
//
//   1. The attestor records a row only from a hardware quote a configured verifier accepted whose report_data
//      commits to the digests (recordMeasurement). No simulated or unverified attestation creates a row.
//   2. The Rekor watcher looks the image digest up in the Sigstore transparency log and checks the entry's
//      Merkle inclusion proof (and, when REKOR_PUBLIC_KEY is set, the log's signed checkpoint). It does not check
//      who signed the entry.
//   3. The keeper builds MeasurementRegistry.register() calldata for rows that are both attested and logged. It
//      never submits: an operator (or the attestor wallet of the registry) sends it.
//
// A measurement is identified by (provider, image digest, compose hash). A provider has at most one current row, the
// one its latest verified quote committed to; when a verified quote commits to other digests (a redeploy with a new
// compose file, say), that becomes a new row and the previous one is superseded, never rewritten or deleted, so its
// history and its log entry stay as they were. Superseded rows are history: they are not looked up, not given
// calldata, and never presented as what a provider runs now.
//
// Status: observed -> ready -> registered (only once the registry itself reports it attested) -> revoked.

export type FetchFn = typeof fetch;
export type Digests = { imageDigest: Hex; composeHash: Hex; modelDigest: Hex };

export const providerIdHash = (id: string): Hex => keccak256(toBytes(id));
const sha256Bytes = (v: Uint8Array | string) => createHash("sha256").update(v).digest();

/** "sha256:<64 hex>", "0x<64 hex>" or bare hex to 0x-prefixed lowercase bytes32; null when it is none of those. */
export function normalizeDigest(v: unknown): Hex | null {
  if (typeof v !== "string") return null;
  const m = /^(?:sha256:|0x)?([0-9a-fA-F]{64})$/.exec(v.trim());
  return m ? (`0x${m[1].toLowerCase()}` as Hex) : null;
}

// ---- Sidecar bindings -----------------------------------------------------------------------------------

/** Read the three digests out of a sidecar bindings object; null when any is missing or malformed. */
export function digestsFromBindings(bindings: unknown): Digests | null {
  if (!bindings || typeof bindings !== "object") return null;
  const b = bindings as Record<string, unknown>;
  const imageDigest = normalizeDigest(b.image_digest);
  const composeHash = normalizeDigest(b.compose_hash);
  const modelDigest = normalizeDigest(b.model_digest);
  return imageDigest && composeHash && modelDigest ? { imageDigest, composeHash, modelDigest } : null;
}

/** The sidecar puts sha256(canonical_json(bindings)) in the first 32 bytes of the quote's report_data. */
export function bindingsCommittedIn(reportDataHex: string, bindings: unknown): boolean {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return false;
  return reportDataHex.toLowerCase().startsWith(sha256(canonicalJson(bindings)));
}

// ---- Rows ------------------------------------------------------------------------------------------------

export type RecordInput = {
  providerId: string;
  digests: Digests;
  verifiers: string[];
  teeKind: string | null;
  quoteHex: string;
  reportHash: string;
};

export type RecordResult = {
  /** created: a new row; seen: an existing row, now current; conflict: nothing recorded (see below). */
  status: "created" | "seen" | "conflict";
  id: number;
  /** Rows of this provider that stopped being current because of this quote. */
  superseded: number[];
};

/**
 * Record (or refresh) a measurement seen in a verified attestation, and make it the provider's current one.
 *
 * The same image digest and compose hash refresh the existing row (and make it current again if it had been
 * superseded, as after a rollback to an earlier compose file). Any other image digest or compose hash is a new row,
 * and the provider's previous current row is marked superseded by it. A change of the digests a provider runs is
 * logged as a warning; the attestation history records it as a measurement change as well.
 *
 * A different model digest under an image digest and compose hash that already have a row is a conflict: that row is
 * not rewritten and nothing is recorded, and since no recorded measurement describes the quote, the provider is left
 * with no current measurement until a verified quote matches one again.
 */
export async function recordMeasurement(ctx: Ctx, input: RecordInput): Promise<RecordResult> {
  const quote = input.quoteHex.replace(/^0x/, "").toLowerCase();
  const d = input.digests;
  const now = new Date();
  const result = await ctx.db.transaction(async (tx) => {
    // The provider's rows, locked, so two attestor runs cannot both decide which one is current.
    const rows = await tx.select().from(measurements).where(eq(measurements.providerId, input.providerId)).orderBy(asc(measurements.id)).for("update");
    const current = rows.filter((r) => !r.supersededAt).map((r) => r.id);
    const supersede = async (ids: number[], by: number | null) => {
      if (ids.length) await tx.update(measurements).set({ supersededAt: now, supersededBy: by, updatedAt: now }).where(and(inArray(measurements.id, ids), isNull(measurements.supersededAt)));
      return ids;
    };
    const same = rows.find((r) => r.imageDigest === d.imageDigest && r.composeHash === d.composeHash);
    if (same && same.modelDigest !== d.modelDigest) return { status: "conflict" as const, id: same.id, superseded: await supersede(current, null) };
    let id: number;
    let status: "created" | "seen";
    if (same) {
      await tx.update(measurements).set({ lastSeenAt: now, supersededAt: null, supersededBy: null, updatedAt: now }).where(eq(measurements.id, same.id));
      [id, status] = [same.id, "seen"];
    } else {
      const [created] = await tx
        .insert(measurements)
        .values({
          providerId: input.providerId,
          imageDigest: d.imageDigest,
          composeHash: d.composeHash,
          modelDigest: d.modelDigest,
          verifier: input.verifiers.join(","),
          teeKind: input.teeKind,
          quote,
          quoteProofHash: keccak256(`0x${quote}`),
          reportHash: input.reportHash,
          attestedAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: measurements.id });
      if (created) [id, status] = [created.id, "created"];
      else {
        const [raced] = await tx.select({ id: measurements.id }).from(measurements).where(and(eq(measurements.providerId, input.providerId), eq(measurements.imageDigest, d.imageDigest), eq(measurements.composeHash, d.composeHash)));
        [id, status] = [raced!.id, "seen"];
      }
    }
    return { status, id, superseded: await supersede(current.filter((c) => c !== id), id) };
  });
  const where = { provider: input.providerId, image: d.imageDigest, compose: d.composeHash, model: d.modelDigest };
  if (result.status === "conflict") log.warn("provider reports a different model digest under an image and compose hash it already has a measurement for; nothing recorded, and it has no current measurement", { ...where, superseded: result.superseded });
  else if (result.superseded.length) log.warn("provider's verified quote commits to digests other than its current measurement; recorded as its current measurement, the previous one kept as history", { ...where, id: result.id, superseded: result.superseded });
  return result;
}

// ---- Rekor -----------------------------------------------------------------------------------------------

export type RekorEntry = {
  uuid: string;
  body: string; // base64 canonical entry
  kind: string | null;
  logIndex: number | null;
  integratedTime: number | null;
  inclusionProof: { logIndex: number; treeSize: number; rootHash: string; hashes: string[]; checkpoint?: string } | null;
  /** The log's identifier and its signed entry timestamp, when the entry carries them. */
  logId?: string | null;
  signedEntryTimestamp?: string | null;
};

const HEX = /^[0-9a-fA-F]+$/;

/** RFC 6962/9162 Merkle audit path check. */
export function verifyInclusionProof(leafHash: Buffer, leafIndex: bigint, treeSize: bigint, hashes: Buffer[], rootHash: Buffer): boolean {
  if (leafIndex < 0n || leafIndex >= treeSize) return false;
  let fn = leafIndex;
  let sn = treeSize - 1n;
  let r = leafHash;
  for (const p of hashes) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = sha256Bytes(Buffer.concat([Buffer.from([1]), p, r]));
      if ((fn & 1n) === 0n) while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      r = sha256Bytes(Buffer.concat([Buffer.from([1]), r, p]));
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.equals(rootHash);
}

/** True when the entry's body is included in the tree its own inclusion proof describes. */
export function entryIncluded(e: RekorEntry): boolean {
  const p = e.inclusionProof;
  if (!p || !HEX.test(p.rootHash) || p.hashes.some((h) => !HEX.test(h)) || !Number.isSafeInteger(p.logIndex) || !Number.isSafeInteger(p.treeSize)) return false;
  const leaf = sha256Bytes(Buffer.concat([Buffer.from([0]), Buffer.from(e.body, "base64")]));
  return verifyInclusionProof(leaf, BigInt(p.logIndex), BigInt(p.treeSize), p.hashes.map((h) => Buffer.from(h, "hex")), Buffer.from(p.rootHash, "hex"));
}

/** Verify the signed checkpoint ("signed note") of an entry's inclusion proof against a known log key, and that it
 *  commits to the same tree size and root as the proof. ECDSA P-256 / SHA-256, as Rekor signs. */
export function checkpointSigned(e: RekorEntry, publicKeyPem: string): boolean {
  const p = e.inclusionProof;
  if (!p?.checkpoint) return false;
  const split = p.checkpoint.indexOf("\n\n");
  if (split < 0) return false;
  const note = p.checkpoint.slice(0, split + 1);
  const lines = note.split("\n");
  if (Number(lines[1]) !== p.treeSize || Buffer.from(lines[2] ?? "", "base64").toString("hex") !== p.rootHash.toLowerCase()) return false;
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  for (const line of p.checkpoint.slice(split + 2).split("\n")) {
    if (!line.startsWith("— ")) continue;
    const raw = Buffer.from(line.split(" ")[2] ?? "", "base64");
    if (raw.length <= 4) continue;
    try {
      if (cryptoVerify("sha256", Buffer.from(note), key, raw.subarray(4))) return true;
    } catch {
      /* next signature line */
    }
  }
  return false;
}

/** Verify an entry's signed entry timestamp (SET) against the log's key: an ECDSA P-256 / SHA-256 signature over the
 *  canonical JSON of { body, integratedTime, logID, logIndex }, as Rekor v1 issues when it accepts an entry. */
export function setSigned(e: RekorEntry, publicKeyPem: string): boolean {
  if (!e.signedEntryTimestamp || !e.logId || e.integratedTime == null || e.logIndex == null) return false;
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  const payload = canonicalJson({ body: e.body, integratedTime: e.integratedTime, logID: e.logId, logIndex: e.logIndex });
  try {
    return cryptoVerify("sha256", Buffer.from(payload), key, Buffer.from(e.signedEntryTimestamp, "base64"));
  } catch {
    return false;
  }
}

async function rekorJson(f: FetchFn, url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Rekor HTTP ${res.status}`);
  return boundedJson(res, 4 * 1024 * 1024);
}

/** Entry UUIDs Rekor has indexed under this image digest. */
export async function rekorSearch(f: FetchFn, baseUrl: string, imageDigest: Hex): Promise<string[]> {
  const r = await rekorJson(f, `${baseUrl}/api/v1/index/retrieve`, { method: "POST", body: JSON.stringify({ hash: `sha256:${imageDigest.slice(2)}` }) });
  return Array.isArray(r) ? r.filter((u): u is string => typeof u === "string" && /^[0-9a-f]{64,80}$/i.test(u)) : [];
}

/** The entry exactly as the log returned it, keyed by nothing: `{ body, integratedTime, logID, logIndex, verification }`. */
export type RawRekorEntry = Record<string, any>;

export async function rekorEntryRaw(f: FetchFn, baseUrl: string, uuid: string): Promise<RawRekorEntry | null> {
  const r = (await rekorJson(f, `${baseUrl}/api/v1/log/entries/${uuid}`)) as Record<string, any> | null;
  const raw = r && typeof r === "object" ? Object.values(r)[0] : null;
  return raw && typeof raw === "object" && typeof (raw as RawRekorEntry).body === "string" ? (raw as RawRekorEntry) : null;
}

export function parseRekorEntry(uuid: string, raw: RawRekorEntry): RekorEntry {
  let kind: string | null = null;
  try {
    kind = String(JSON.parse(Buffer.from(raw.body, "base64").toString("utf8")).kind ?? "") || null;
  } catch {
    /* body is opaque to us */
  }
  const ip = raw.verification?.inclusionProof;
  return {
    uuid,
    body: raw.body,
    kind,
    logIndex: Number.isSafeInteger(raw.logIndex) ? raw.logIndex : null,
    integratedTime: Number.isSafeInteger(raw.integratedTime) ? raw.integratedTime : null,
    inclusionProof: ip && typeof ip.rootHash === "string" && Array.isArray(ip.hashes) ? { logIndex: Number(ip.logIndex), treeSize: Number(ip.treeSize), rootHash: ip.rootHash, hashes: ip.hashes.map(String), checkpoint: typeof ip.checkpoint === "string" ? ip.checkpoint : undefined } : null,
    logId: typeof raw.logID === "string" ? raw.logID : null,
    signedEntryTimestamp: typeof raw.verification?.signedEntryTimestamp === "string" ? raw.verification.signedEntryTimestamp : null,
  };
}

export async function rekorEntry(f: FetchFn, baseUrl: string, uuid: string): Promise<RekorEntry | null> {
  const raw = await rekorEntryRaw(f, baseUrl, uuid);
  return raw ? parseRekorEntry(uuid, raw) : null;
}

const MAX_ENTRIES_PER_DIGEST = 5;

/** Look up the image digest of every observed current row in Rekor. A row becomes ready with the earliest entry whose
 *  inclusion proof verifies. Errors are recorded per row and never move a row backwards. Superseded rows are history
 *  and are not looked up. */
export async function watchRekor(ctx: Ctx, opts: { fetchImpl?: FetchFn; limit?: number } = {}) {
  const f = opts.fetchImpl ?? fetch;
  const { rekorUrl, rekorPublicKey } = ctx.cfg.measurements;
  const rows = await ctx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.status, "observed"), isNull(measurements.revokedAt), isNull(measurements.supersededAt)))
    .orderBy(sql`${measurements.rekorCheckedAt} asc nulls first`, asc(measurements.id))
    .limit(opts.limit ?? 25);
  let ready = 0;
  let missing = 0;
  let failed = 0;
  for (const row of rows) {
    const now = new Date();
    try {
      const uuids = (await rekorSearch(f, rekorUrl, row.imageDigest as Hex)).slice(0, MAX_ENTRIES_PER_DIGEST);
      const entries: RekorEntry[] = [];
      let unverifiable = 0;
      for (const uuid of uuids) {
        const e = await rekorEntry(f, rekorUrl, uuid);
        if (e && entryIncluded(e)) entries.push(e);
        else unverifiable++;
      }
      entries.sort((a, b) => (a.integratedTime ?? Infinity) - (b.integratedTime ?? Infinity) || (a.logIndex ?? Infinity) - (b.logIndex ?? Infinity));
      const hit = entries[0];
      if (!hit) {
        missing++;
        await ctx.db.update(measurements).set({ rekorCheckedAt: now, rekorError: uuids.length ? `no entry with a verifiable inclusion proof (${unverifiable} unverifiable)` : null, updatedAt: now }).where(eq(measurements.id, row.id));
        continue;
      }
      await ctx.db
        .update(measurements)
        .set({
          status: "ready",
          rekorUuid: hit.uuid,
          rekorEntry: `0x${hit.uuid.slice(-64).toLowerCase()}`,
          rekorLogIndex: hit.logIndex,
          rekorKind: hit.kind,
          rekorIntegratedAt: hit.integratedTime != null ? new Date(hit.integratedTime * 1000) : null,
          rekorInclusionVerified: true,
          rekorCheckpointVerified: rekorPublicKey ? checkpointSigned(hit, rekorPublicKey) : false,
          rekorCheckedAt: now,
          rekorError: null,
          updatedAt: now,
        })
        .where(and(eq(measurements.id, row.id), eq(measurements.status, "observed")));
      ready++;
    } catch (e) {
      failed++;
      log.warn("rekor lookup failed", { provider: row.providerId, error: (e as Error).message });
      await ctx.db.update(measurements).set({ rekorCheckedAt: now, rekorError: (e as Error).message.slice(0, 200), updatedAt: now }).where(eq(measurements.id, row.id));
    }
  }
  return { checked: rows.length, ready, missing, failed };
}

// ---- Keeper ----------------------------------------------------------------------------------------------

type Row = typeof measurements.$inferSelect;

/** Calldata for MeasurementRegistry.register(providerId, m, quoteProof). attestedAt and revoked are ignored by the
 *  contract (it stamps them), so they are sent as zero and false. */
export function buildRegisterCalldata(row: Pick<Row, "providerId" | "imageDigest" | "composeHash" | "modelDigest" | "rekorEntry" | "quote">): Hex {
  if (!row.rekorEntry) throw new Error("measurement has no transparency-log entry");
  return encodeFunctionData({
    abi: MeasurementRegistryAbi,
    functionName: "register",
    args: [
      providerIdHash(row.providerId),
      { imageDigest: row.imageDigest as Hex, composeHash: row.composeHash as Hex, modelDigest: row.modelDigest as Hex, rekorEntry: row.rekorEntry as Hex, attestedAt: 0n, revoked: false },
      `0x${row.quote}` as Hex,
    ],
  });
}

/** Build calldata for every ready current row that is still being attested. Nothing is sent. */
export async function runKeeper(ctx: Ctx) {
  const staleBefore = new Date(Date.now() - ctx.cfg.attestation.intervalMs * 3);
  const rows = await ctx.db.select().from(measurements).where(and(eq(measurements.status, "ready"), isNull(measurements.calldata), isNull(measurements.revokedAt), isNull(measurements.supersededAt)));
  const target = ctx.cfg.measurements.registry;
  let built = 0;
  let skippedStale = 0;
  for (const row of rows) {
    if (row.lastSeenAt < staleBefore) {
      skippedStale++;
      continue;
    }
    const now = new Date();
    await ctx.db.update(measurements).set({ calldata: buildRegisterCalldata(row), calldataTarget: target, calldataBuiltAt: now, updatedAt: now }).where(eq(measurements.id, row.id));
    built++;
  }
  return { built, skippedStale, target };
}

/** Record the transaction an operator sent with a row's calldata. The row stays "ready" until the registry itself
 *  reports it attested (reconcileRegistry); an operator's word alone never makes a measurement "registered". */
export async function recordSubmission(ctx: Ctx, id: number, txHash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 0x-prefixed 32-byte hash");
  const done = await ctx.db
    .update(measurements)
    .set({ txHash: txHash.toLowerCase(), updatedAt: new Date() })
    .where(and(eq(measurements.id, id), eq(measurements.status, "ready")))
    .returning({ id: measurements.id });
  if (!done.length) throw new Error("only a ready measurement can have a submission recorded");
}

/** Whether the registry holds this provider's measurement for the image, with this model digest and compose hash. */
export type IsAttestedReader = (providerIdHash: Hex, imageDigest: Hex, modelDigest: Hex, composeHash: Hex) => Promise<boolean>;

/** Read the registry back: a ready row it reports attested becomes registered; a registered row it no longer
 *  reports attested becomes revoked. The registry keeps one measurement per provider and image, so a row counts as
 *  registered only when the registered compose hash is the row's own. Skipped without a configured registry. */
export async function reconcileRegistry(ctx: Ctx, read?: IsAttestedReader) {
  const registry = ctx.cfg.measurements.registry;
  if (!registry) return { skipped: "no MEASUREMENT_REGISTRY_ADDRESS" };
  const reader: IsAttestedReader =
    read ??
    (async (pid, img, model, compose) => {
      if (!((await ctx.chain.client.readContract({ address: registry, abi: MeasurementRegistryAbi, functionName: "isAttested", args: [pid, img, model] })) as boolean)) return false;
      const m = (await ctx.chain.client.readContract({ address: registry, abi: MeasurementRegistryAbi, functionName: "measurements", args: [pid, img] })) as readonly [Hex, Hex, ...unknown[]];
      return String(m[1]).toLowerCase() === compose.toLowerCase();
    });
  const rows = await ctx.db.select().from(measurements).where(inArray(measurements.status, ["ready", "registered"]));
  let registered = 0;
  let revoked = 0;
  for (const row of rows) {
    let attested: boolean;
    try {
      attested = await reader(providerIdHash(row.providerId), row.imageDigest as Hex, row.modelDigest as Hex, row.composeHash as Hex);
    } catch (e) {
      log.warn("registry read failed", { provider: row.providerId, error: (e as Error).message });
      continue;
    }
    const now = new Date();
    if (row.status === "ready" && attested) {
      await ctx.db.update(measurements).set({ status: "registered", registeredAt: now, updatedAt: now }).where(and(eq(measurements.id, row.id), eq(measurements.status, "ready")));
      registered++;
    } else if (row.status === "registered" && !attested) {
      await ctx.db.update(measurements).set({ status: "revoked", revokedAt: now, updatedAt: now }).where(and(eq(measurements.id, row.id), eq(measurements.status, "registered")));
      revoked++;
    }
  }
  return { registered, revoked };
}

/** The measurement job: Rekor lookups, then calldata, then (with a registry configured) the read-back. */
export async function runMeasurements(ctx: Ctx, opts: { fetchImpl?: FetchFn; read?: IsAttestedReader } = {}) {
  if (!ctx.cfg.measurements.enabled) return { skipped: "MEASUREMENTS_ENABLED is false" };
  const rekor = await watchRekor(ctx, { fetchImpl: opts.fetchImpl });
  const keeper = await runKeeper(ctx);
  const registry = await reconcileRegistry(ctx, opts.read);
  return { rekor, keeper, registry };
}

// ---- Public view -----------------------------------------------------------------------------------------

/** The row that describes what a provider is running now: the one its latest verified quote committed to (not
 *  superseded), unless revoked. Rows recorded before rows could be superseded are ordered by when they were last seen. */
export async function currentMeasurement(ctx: Ctx, providerId: string): Promise<Row | null> {
  const rows = await ctx.db.select().from(measurements).where(and(eq(measurements.providerId, providerId), isNull(measurements.supersededAt)));
  const live = rows.filter((r) => r.status !== "revoked").sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || b.id - a.id);
  return live[0] ?? null;
}

/** A provider's superseded measurements, most recently superseded first: history, never what it runs now. */
export async function measurementHistory(ctx: Ctx, providerId: string, limit = 10): Promise<Row[]> {
  return ctx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.providerId, providerId), isNotNull(measurements.supersededAt)))
    .orderBy(desc(measurements.supersededAt), desc(measurements.id))
    .limit(limit);
}
