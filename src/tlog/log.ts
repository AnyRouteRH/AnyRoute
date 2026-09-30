import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { blindKeys, measurementBundles, ohttpKeys, receiptKeys, tlogCheckpoints, tlogCosignatures, tlogEntries } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { blindKeyEntry, dataInventoryEntry, ENTRY_KINDS, entryText, measurementBundleEntry, ohttpKeyEntry, receiptKeyEntry, type EntryInput, type EntryKind } from "./entries.ts";
import { currentInventory } from "../privacy/inventory.ts";
import { onKeyPublished } from "./hooks.ts";
import { encodeEntryBundle, leafHash, MAX_ENTRY_BYTES, MerkleTree, tileWidth, TILE_WIDTH, type TileRef } from "./merkle.ts";
import { formatCheckpoint, noteSigner, parseCheckpoint, parseNote, SIG_ED25519, signatureLine, verifyCosignature, type NoteSigner, type NoteVerifier } from "./note.ts";
import { RekorAnchor, type AnchorResult } from "./rekor.ts";

// The Anyroute transparency log: an append-only Merkle tree over the keys and configurations clients encrypt to or
// verify against (receipt keys, Oblivious HTTP key configurations, blind-token issuer keys, measurement bundles and
// sidecar key bindings). It is served in the C2SP tlog-tiles layout with signed-note checkpoints, and witnesses add
// tlog-cosignature (cosignature/v1) signatures to those checkpoints.
//
// Appends are serialised across processes by a transaction-scoped advisory lock and deduplicated by (kind, sha256), so
// every replica may append and the order is the database's. Entries are never changed. Every process reads new leaves
// from the database before it answers, so replicas serve the same tree.

type TlogConfig = Config["tlog"];
export type CheckpointRow = typeof tlogCheckpoints.$inferSelect;
export type CosignatureRow = typeof tlogCosignatures.$inferSelect;
export type EntryRow = typeof tlogEntries.$inferSelect;

const LOCK = sql`select pg_advisory_xact_lock(hashtextextended('anyroute:tlog:append', 0))`;
/** A cosignature dated further ahead than this is refused (seconds). */
const MAX_FUTURE_S = 600;

export class TransparencyLog {
  readonly origin: string;
  readonly signer: NoteSigner;
  readonly witnesses: NoteVerifier[];
  readonly quorum: number;
  /** Public-log anchoring of checkpoints in Rekor (TLOG_REKOR_ENABLED), or null. */
  readonly rekor: RekorAnchor | null;
  /** Whether to append the SHA-256 of the data inventory this build publishes (TLOG_DATA_INVENTORY). */
  readonly dataInventory: boolean;
  /** Test hook: the clock, in milliseconds. */
  now: () => number = () => Date.now();
  private readonly tree = new MerkleTree();
  private readonly logged = new Set<string>();
  private refreshing: Promise<void> | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    cfg: TlogConfig,
  ) {
    this.origin = cfg.origin;
    this.signer = noteSigner(cfg.origin, SIG_ED25519, cfg.signingKey);
    this.witnesses = cfg.witnesses;
    this.quorum = cfg.quorum;
    this.rekor = cfg.rekor?.enabled ? new RekorAnchor(db, cfg.rekor) : null;
    this.dataInventory = !!cfg.dataInventory;
  }

  /** The verifier key clients pin: "<origin>+<key id>+<base64 key>". */
  get verifierKey(): string {
    return this.signer.verifierKey;
  }

  /** Start listening for published keys on this database, and log whatever is already there. */
  start(): this {
    onKeyPublished(this.db, (kind, entry) => void this.track(entry ? this.append([entry]) : this.sync([kind])));
    void this.track(this.sync());
    return this;
  }

  /** Stop listening and wait for appends in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    onKeyPublished(this.db, null);
    await this.idle();
  }

  /** Resolves when every append started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T | undefined> {
    const q = p.catch((e) => {
      if (!this.stopped) log.warn("transparency log append failed", { error: (e as Error).message });
      return undefined;
    });
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
    return q;
  }

  // ---- appending -----------------------------------------------------------------------------------------------

  /** Entries for every key the router has published, of the given kinds (all by default). */
  async candidates(kinds: readonly EntryKind[] = ENTRY_KINDS): Promise<EntryInput[]> {
    const out: EntryInput[] = [];
    if (kinds.includes("receipt_key")) for (const k of await this.db.select().from(receiptKeys).orderBy(asc(receiptKeys.validFrom), asc(receiptKeys.id))) out.push(receiptKeyEntry(k));
    if (kinds.includes("ohttp_key_config")) for (const k of await this.db.select().from(ohttpKeys).orderBy(asc(ohttpKeys.epoch))) out.push(ohttpKeyEntry(k));
    if (kinds.includes("blind_issuer_key")) for (const k of await this.db.select().from(blindKeys).orderBy(asc(blindKeys.epoch), asc(blindKeys.denomination))) out.push(blindKeyEntry(k));
    if (kinds.includes("measurement_bundle"))
      for (const b of await this.db.select().from(measurementBundles).where(eq(measurementBundles.status, "verified")).orderBy(asc(measurementBundles.verifiedAt), asc(measurementBundles.id))) out.push(measurementBundleEntry(b));
    // The data inventory of the code that is running. The entry is deduplicated by digest like any other, so it is appended
    // once, the first time a router with a new inventory starts. A problem building it must not hold back the keys.
    if (this.dataInventory && kinds.includes("data_inventory")) {
      try {
        out.push(dataInventoryEntry(currentInventory()));
      } catch (e) {
        log.warn("data inventory not logged", { error: (e as Error).message.split("\n")[0] });
      }
    }
    return out;
  }

  /** Append every published key of these kinds that is not logged yet. Returns how many entries were added. */
  async sync(kinds: readonly EntryKind[] = ENTRY_KINDS): Promise<number> {
    return this.append(await this.candidates(kinds));
  }

  /** Append entries not already in the log (by kind and digest), in the order given, then sign a checkpoint. */
  async append(items: EntryInput[]): Promise<number> {
    const fresh = items.filter((e, i) => !this.logged.has(`${e.kind}:${e.sha256}`) && items.findIndex((x) => x.kind === e.kind && x.sha256 === e.sha256) === i);
    for (const e of fresh) if (Buffer.byteLength(entryText(e)) > MAX_ENTRY_BYTES) throw new Error(`a ${e.kind} entry is larger than a log entry may be`);
    let added = 0;
    if (fresh.length) {
      added = await this.db.transaction(async (tx) => {
        await tx.execute(LOCK);
        const have = new Set<string>();
        for (const kind of new Set(fresh.map((e) => e.kind))) {
          const digests = fresh.filter((e) => e.kind === kind).map((e) => e.sha256);
          for (const r of await tx.select({ sha256: tlogEntries.sha256 }).from(tlogEntries).where(and(eq(tlogEntries.kind, kind), inArray(tlogEntries.sha256, digests)))) have.add(`${kind}:${r.sha256}`);
        }
        const todo = fresh.filter((e) => !have.has(`${e.kind}:${e.sha256}`));
        if (!todo.length) return 0;
        const [{ next }] = await tx.select({ next: sql<string>`coalesce(max(${tlogEntries.idx}) + 1, 0)` }).from(tlogEntries);
        const base = Number(next);
        await tx.insert(tlogEntries).values(
          todo.map((e, i) => {
            const text = entryText(e);
            return { idx: base + i, kind: e.kind, sha256: e.sha256, subject: e.subject, entry: text, leafHash: leafHash(Buffer.from(text)).toString("hex") };
          }),
        );
        return todo.length;
      });
      for (const e of fresh) this.logged.add(`${e.kind}:${e.sha256}`);
      if (added) log.info("transparency log appended", { added });
    }
    await this.checkpoint();
    return added;
  }

  // ---- the tree ------------------------------------------------------------------------------------------------

  /** Read leaves other processes appended since the last read. */
  async refresh(): Promise<MerkleTree> {
    while (this.refreshing) await this.refreshing;
    const run = (async () => {
      const rows = await this.db.select({ idx: tlogEntries.idx, leafHash: tlogEntries.leafHash, kind: tlogEntries.kind, sha256: tlogEntries.sha256 }).from(tlogEntries).where(gte(tlogEntries.idx, this.tree.size)).orderBy(asc(tlogEntries.idx));
      for (const r of rows) {
        if (r.idx !== this.tree.size) throw new Error(`transparency log has a gap at ${this.tree.size}`);
        this.tree.appendLeafHash(Buffer.from(r.leafHash, "hex"));
        this.logged.add(`${r.kind}:${r.sha256}`);
      }
    })();
    this.refreshing = run;
    try {
      await run;
    } finally {
      this.refreshing = null;
    }
    return this.tree;
  }

  async size(): Promise<number> {
    return (await this.refresh()).size;
  }

  /** Sign a checkpoint for the current tree size unless one exists. Returns the newest checkpoint. */
  async checkpoint(): Promise<CheckpointRow> {
    const tree = await this.refresh();
    const latest = await this.latest();
    if (latest && latest.size >= tree.size) return latest;
    const root = tree.root();
    const body = formatCheckpoint(this.origin, tree.size, root);
    const row = { size: tree.size, rootHash: root.toString("hex"), checkpoint: body, signature: signatureLine(this.signer.name, this.signer.keyId, this.signer.sign(Buffer.from(body))) };
    await this.db.insert(tlogCheckpoints).values(row).onConflictDoNothing();
    return (await this.checkpointAt(tree.size))!;
  }

  async latest(): Promise<CheckpointRow | null> {
    const [row] = await this.db.select().from(tlogCheckpoints).orderBy(desc(tlogCheckpoints.size)).limit(1);
    return row ?? null;
  }

  async checkpointAt(size: number): Promise<CheckpointRow | null> {
    const [row] = await this.db.select().from(tlogCheckpoints).where(eq(tlogCheckpoints.size, size));
    return row ?? null;
  }

  /** Cosignatures on a checkpoint from witnesses that are configured now, one per witness. */
  async cosignatures(size: number): Promise<CosignatureRow[]> {
    if (!this.witnesses.length) return [];
    const rows = await this.db.select().from(tlogCosignatures).where(and(eq(tlogCosignatures.size, size), inArray(tlogCosignatures.witness, this.witnesses.map((w) => w.name)))).orderBy(asc(tlogCosignatures.witness));
    return rows.filter((r) => this.witnesses.some((w) => w.name === r.witness && w.keyId.toString("hex") === r.keyId));
  }

  /** The checkpoint as a signed note: its text, the log's signature, then every cosignature collected. */
  async note(cp: CheckpointRow): Promise<string> {
    const cosigs = await this.cosignatures(cp.size);
    return `${cp.checkpoint}\n${cp.signature}${cosigs.map((c) => c.line).join("")}`;
  }

  /** The newest checkpoint cosigned by at least `quorum` configured witnesses, if any. */
  async witnessed(minSize = 0): Promise<CheckpointRow | null> {
    if (this.witnesses.length < this.quorum) return null;
    const configured = or(...this.witnesses.map((w) => and(eq(tlogCosignatures.witness, w.name), eq(tlogCosignatures.keyId, w.keyId.toString("hex")))));
    const [hit] = await this.db
      .select({ size: tlogCosignatures.size })
      .from(tlogCosignatures)
      .where(and(gte(tlogCosignatures.size, minSize), configured))
      .groupBy(tlogCosignatures.size)
      .having(sql`count(*) >= ${this.quorum}`)
      .orderBy(desc(tlogCosignatures.size))
      .limit(1);
    return hit ? this.checkpointAt(hit.size) : null;
  }

  /** The newest checkpoint of at least `minSize` whose Rekor anchor verified, if anchoring is on. */
  async anchored(minSize = 0): Promise<CheckpointRow | null> {
    const a = await this.rekor?.latest(minSize);
    return a ? this.checkpointAt(a.size) : null;
  }

  // ---- witnesses -----------------------------------------------------------------------------------------------

  /**
   * Take a signed note from a witness: a checkpoint this log signed, carrying the witness's cosignature/v1 line (other
   * lines are ignored). Every valid cosignature from a configured witness is kept, the newest per witness.
   */
  async addCosignatures(noteText: string): Promise<{ size: number; accepted: string[]; cosignatures: number; witnessed: boolean }> {
    let note;
    let cp;
    try {
      note = parseNote(noteText);
      cp = parseCheckpoint(note.text);
    } catch (e) {
      throw new CosignError(400, `Not a checkpoint note: ${(e as Error).message}.`, "invalid_checkpoint");
    }
    if (cp.origin !== this.origin) throw new CosignError(400, "The checkpoint is for another log.", "unknown_log");
    const stored = await this.checkpointAt(cp.size);
    if (!stored) throw new CosignError(404, "This log has not signed a checkpoint of that size.", "unknown_checkpoint");
    if (stored.checkpoint !== note.text) throw new CosignError(409, "The checkpoint does not match the one this log signed for that size.", "checkpoint_mismatch");
    const nowS = Math.floor(this.now() / 1000);
    const accepted: string[] = [];
    let unknown = true;
    for (const s of note.signatures) {
      const w = this.witnesses.find((x) => x.name === s.name && x.keyId.equals(s.keyId));
      if (!w) continue;
      unknown = false;
      const t = verifyCosignature(note.text, s, w);
      if (t === null || t > nowS + MAX_FUTURE_S) continue;
      const keyId = w.keyId.toString("hex");
      const values = { size: cp.size, witness: w.name, keyId, timestamp: t, line: s.line };
      await this.db
        .insert(tlogCosignatures)
        .values(values)
        .onConflictDoUpdate({ target: [tlogCosignatures.size, tlogCosignatures.witness, tlogCosignatures.keyId], set: { timestamp: t, line: s.line, updatedAt: new Date() }, setWhere: lt(tlogCosignatures.timestamp, t) });
      accepted.push(w.name);
    }
    if (unknown) throw new CosignError(403, "The note carries no signature from a witness this log is configured with.", "unknown_witness");
    if (!accepted.length) throw new CosignError(403, "No cosignature on the note verifies.", "invalid_cosignature");
    const n = (await this.cosignatures(cp.size)).length;
    return { size: cp.size, accepted, cosignatures: n, witnessed: this.witnesses.length >= this.quorum && n >= this.quorum };
  }

  // ---- reading -------------------------------------------------------------------------------------------------

  /** Tile bytes, or null when the tile (at that width) does not exist in the current tree. */
  async tile(ref: TileRef): Promise<Buffer | null> {
    const tree = await this.refresh();
    if (ref.level === "entries") {
      const avail = tileWidth(0, ref.index, tree.size);
      const w = ref.width ?? TILE_WIDTH;
      if (avail < w) return null;
      const lo = ref.index * TILE_WIDTH;
      const rows = await this.db.select({ idx: tlogEntries.idx, entry: tlogEntries.entry }).from(tlogEntries).where(and(gte(tlogEntries.idx, lo), lt(tlogEntries.idx, lo + w))).orderBy(asc(tlogEntries.idx));
      if (rows.length !== w) return null;
      return encodeEntryBundle(rows.map((r) => Buffer.from(r.entry)));
    }
    const avail = tileWidth(ref.level, ref.index, tree.size);
    const w = ref.width ?? TILE_WIDTH;
    if (avail < w) return null;
    return tree.tile(ref.level, ref.index, w);
  }

  async lookup(kind: EntryKind, digest: string): Promise<EntryRow | null> {
    const [row] = await this.db.select().from(tlogEntries).where(and(eq(tlogEntries.kind, kind), eq(tlogEntries.sha256, digest.toLowerCase())));
    return row ?? null;
  }

  async entryAt(index: number): Promise<EntryRow | null> {
    const [row] = await this.db.select().from(tlogEntries).where(eq(tlogEntries.idx, index));
    return row ?? null;
  }

  async inclusionProof(index: number, size: number): Promise<Buffer[]> {
    return (await this.refresh()).inclusionProof(index, size);
  }

  async consistencyProof(from: number, to: number): Promise<Buffer[]> {
    return (await this.refresh()).consistencyProof(from, to);
  }

  /** Periodic job: log keys published since the last run, make sure the newest tree size has a checkpoint and, with
   *  anchoring on, record that checkpoint in Rekor (throttled; a Rekor failure is reported, never thrown). */
  async run(): Promise<{ size: number; added: number; witnessed: number | null; rekor?: AnchorResult }> {
    const added = await this.sync();
    const cp = await this.checkpoint();
    const w = await this.witnessed();
    if (!this.rekor) return { size: cp.size, added, witnessed: w?.size ?? null };
    return { size: cp.size, added, witnessed: w?.size ?? null, rekor: await this.rekor.run(cp) };
  }
}

export class CosignError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string,
  ) {
    super(message);
  }
}
