import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, equalBytes, fromUtf8, hexToBytes, isHex, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { defaultP256Verify, spkiFromText, type P256Verifier } from "./ecdsa.js";
import { defaultEd25519Verify, type Ed25519Verifier } from "./ed25519.js";
import { AnyRouteError } from "./errors.js";
import { sha256, sha256Hex } from "./hash.js";
import type { Fetch } from "./types.js";

// Split-view checks against the Anyroute transparency log (C2SP tlog-tiles, signed-note checkpoints, tlog-cosignature
// witnesses). Opt-in: nothing here runs unless a caller creates a TransparencyLog (or passes `transparency` to the
// AnyRoute client).
//
// Given a key or configuration, `requireLogged` accepts it only when
//   1. the log returns its entry, and the entry names exactly that kind and SHA-256;
//   2. the entry's leaf is included (RFC 6962 inclusion proof) in a checkpoint the pinned log key signed;
//   3. that checkpoint carries valid cosignature/v1 signatures from at least `quorum` of the configured witnesses;
//   4. the checkpoint is consistent with the newest one this client remembers: the same root at the same size, or a
//      verified consistency proof between the two; and the same holds for every mirror the caller configured.
// Anything else is refused with a TransparencyError; two checkpoints of one size with different roots, or a failed
// consistency proof, is a SplitViewDetected carrying both notes as evidence.
//
// Public-log anchoring (`rekor`) is a second way to meet step 3, for a log that records its checkpoints in Sigstore's
// Rekor instead of (or as well as) collecting witness cosignatures. The checkpoint must then have a Rekor entry that
//   a. is a hashedrekord over the checkpoint note as the log signed it (text, blank line, the log's signature line),
//      signed with the log's anchoring key (ECDSA P-256), pinned out of band;
//   b. is named by its own leaf hash and included (RFC 6962) under a checkpoint that Rekor's pinned key signed.
// With witnesses configured as well, both must hold. Rekor makes a second history visible after the fact to anyone who
// follows the anchoring key's entries there; unlike a witness quorum, it does not stop the log from signing one.

export const TLOG_KINDS = ["receipt_key", "ohttp_key_config", "blind_issuer_key", "measurement_bundle", "attestation_binding", "data_inventory"] as const;
export type TlogKind = (typeof TLOG_KINDS)[number];

export class TransparencyError extends AnyRouteError {
  constructor(message: string, code: string, details?: unknown) {
    super(message, code, undefined, details);
    this.name = "TransparencyError";
  }
}

/** Two views of one log: the same size with different roots, or a newer tree that does not extend an older one. */
export class SplitViewDetected extends TransparencyError {
  constructor(
    message: string,
    readonly evidence: { first: string; second: string },
    code = "split_view",
  ) {
    super(message, code, evidence);
    this.name = "SplitViewDetected";
  }
}

// ---- digests clients compute from what they were handed -------------------------------------------------------------

/** receipt_key: SHA-256 of the raw 32-byte Ed25519 public key. */
export const receiptKeyDigest = (rawPublicKey: Uint8Array) => sha256Hex(rawPublicKey);
/** ohttp_key_config: SHA-256 of one encoded key configuration (RFC 9458 section 3.1). */
export const ohttpKeyConfigDigest = (config: Uint8Array) => sha256Hex(config);
/** blind_issuer_key: SHA-256 of the issuer's SubjectPublicKeyInfo, which is its token_key_id. */
export const blindIssuerKeyDigest = (spki: Uint8Array) => sha256Hex(spki);
/** attestation_binding: SHA-256 of the canonical JSON of a sidecar's bindings. */
export const bindingsDigest = (bindings: Record<string, unknown>) => sha256Hex(canonicalJson(bindings));

// ---- RFC 6962 -------------------------------------------------------------------------------------------------------

const H = async (...parts: Uint8Array[]) => sha256(concatBytes(...parts));
export const leafHash = (entry: Uint8Array) => H(Uint8Array.of(0), entry);
const nodeHash = (l: Uint8Array, r: Uint8Array) => H(Uint8Array.of(1), l, r);
const odd = (x: number) => x % 2 === 1;
const half = (x: number) => Math.floor(x / 2);
const isPow2 = (n: number) => n > 0 && 2 ** Math.round(Math.log2(n)) === n;

export async function verifyInclusion(index: number, size: number, leaf: Uint8Array, proof: Uint8Array[], root: Uint8Array): Promise<boolean> {
  if (!(Number.isSafeInteger(index) && Number.isSafeInteger(size) && index >= 0 && index < size)) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      r = await nodeHash(p, r);
      if (!odd(fn)) while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else r = await nodeHash(r, p);
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equalBytes(r, root);
}

export async function verifyConsistency(size1: number, size2: number, proof: Uint8Array[], root1: Uint8Array, root2: Uint8Array): Promise<boolean> {
  if (!(Number.isSafeInteger(size1) && Number.isSafeInteger(size2) && size1 >= 0 && size1 <= size2)) return false;
  if (size1 === size2) return proof.length === 0 && equalBytes(root1, root2);
  if (size1 === 0) return proof.length === 0;
  if (!proof.length) return false;
  const path = isPow2(size1) ? [root1, ...proof] : proof;
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (odd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      if (!odd(fn)) while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else sr = await nodeHash(sr, c);
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equalBytes(fr, root1) && equalBytes(sr, root2);
}

// ---- signed notes ---------------------------------------------------------------------------------------------------

export type VerifierKey = { name: string; type: number; keyId: Uint8Array; publicKey: Uint8Array };
/** `logNote` is the note with only the log's own signature: the bytes a Rekor anchor commits to. */
export type Checkpoint = { origin: string; size: number; root: Uint8Array; text: string; note: string; logNote?: string };

const EM_DASH = "—";

async function keyIdOf(name: string, type: number, publicKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(concatBytes(utf8(name), Uint8Array.of(0x0a, type), publicKey))).slice(0, 4);
}

function strictB64(text: string): Uint8Array {
  const raw = base64ToBytes(text);
  if (bytesToBase64(raw) !== text) throw new Error("non-canonical base64");
  return raw;
}

/** Parse "<name>+<8 hex>+<base64(type || key)>" and check the key id. */
export async function parseVerifierKey(vkey: string): Promise<VerifierKey> {
  const m = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/.exec(vkey.trim());
  if (!m) throw new TransparencyError("A verifier key is <name>+<8 hex>+<base64 key>.", "bad_options");
  const raw = strictB64(m[3]);
  if (raw.length !== 33 || (raw[0] !== 0x01 && raw[0] !== 0x04)) throw new TransparencyError("A verifier key must be an Ed25519 (0x01) or cosignature/v1 (0x04) key.", "bad_options");
  const keyId = await keyIdOf(m[1], raw[0], raw.slice(1));
  if (bytesToHex(keyId) !== m[2]) throw new TransparencyError("The verifier key's id does not match its name and key.", "bad_options");
  return { name: m[1], type: raw[0], keyId, publicKey: raw.slice(1) };
}

type NoteSig = { name: string; keyId: Uint8Array; sig: Uint8Array };

export function parseNote(msg: string): { text: string; signatures: NoteSig[] } {
  const split = msg.lastIndexOf("\n\n");
  if (split < 0 || !msg.endsWith("\n")) throw new Error("not a signed note");
  const text = msg.slice(0, split + 1);
  const signatures: NoteSig[] = [];
  for (const line of msg.slice(split + 2, -1).split("\n")) {
    const m = new RegExp(`^${EM_DASH} ([^\\s+]+) ([A-Za-z0-9+/]+={0,2})$`, "u").exec(line);
    if (!m) throw new Error("malformed signature line");
    const raw = strictB64(m[2]);
    if (raw.length < 5) throw new Error("malformed signature");
    signatures.push({ name: m[1], keyId: raw.slice(0, 4), sig: raw.slice(4) });
    if (signatures.length > 100) throw new Error("too many signatures");
  }
  return { text, signatures };
}

export function parseCheckpointText(text: string): { origin: string; size: number; root: Uint8Array } {
  const lines = text.split("\n");
  if (lines.length !== 4 || lines[3] !== "") throw new Error("a checkpoint is three lines");
  if (!/^[^\s+]{1,256}$/u.test(lines[0])) throw new Error("bad origin");
  if (!/^(0|[1-9]\d{0,15})$/.test(lines[1]) || !Number.isSafeInteger(Number(lines[1]))) throw new Error("bad size");
  const root = strictB64(lines[2]);
  if (root.length !== 32) throw new Error("bad root hash");
  return { origin: lines[0], size: Number(lines[1]), root };
}

const cosignedMessage = (text: string, t: number) => utf8(`cosignature/v1\ntime ${t}\n${text}`);

// ---- the check ------------------------------------------------------------------------------------------------------

/** Where the newest accepted checkpoint is kept between runs (a file, browser storage...). In memory by default. */
export type CheckpointStore = { get(origin: string): Promise<string | null> | string | null; set(origin: string, note: string): Promise<void> | void };

/** Public-log anchoring: accept a checkpoint on a verified Rekor entry for it. Both keys are pinned out of band. */
export type RekorAnchorOptions = {
  /** The log's anchoring key: the ECDSA P-256 public key (PEM or base64 SPKI) that signs its Rekor entries. */
  anchorKey: string;
  /** The Rekor log's public key (PEM), which signs Rekor's checkpoints and signed entry timestamps. */
  rekorKey: string;
};

export type TransparencyOptions = {
  /** The log's verifier key "<origin>+<id>+<base64 key>", pinned out of band (for example from the documentation). */
  logKey: string;
  /** Witness verifier keys (cosignature/v1, type 0x04), pinned out of band. Optional with `rekor`. */
  witnesses?: string[];
  /** How many of those witnesses must have cosigned. Default: 2, or 1 when only one witness is configured. */
  quorum?: number;
  /** Opt-in: require a verified Rekor anchor for every checkpoint (in place of witnesses, or as well as them). */
  rekor?: RekorAnchorOptions;
  /** Base URL of the router that serves the log (…/api/v1/tlog). The AnyRoute client passes its own. */
  logUrl?: string;
  /** Other places serving the log's checkpoint (full URLs), fetched as a second path: each must agree with the log. */
  mirrors?: string[];
  store?: CheckpointStore;
  fetch?: Fetch;
  ed25519?: Ed25519Verifier;
  /** ECDSA P-256 verification for Rekor anchors; WebCrypto by default. */
  p256?: P256Verifier;
};

/** The Rekor entry a checkpoint was accepted on. `signedEntryTimestamp` says whether Rekor's promise verified too. */
export type RekorAnchor = { uuid: string; logIndex: number | null; integratedTime: number | null; treeSize: number; signedEntryTimestamp: boolean };

export type LoggedKey = { kind: TlogKind; sha256: string; index: number; entry: Record<string, unknown>; checkpoint: { size: number; rootHash: string }; cosignedBy: string[]; rekor?: RekorAnchor };

export class TransparencyLog {
  private readonly f: Fetch;
  private readonly verify: Ed25519Verifier;
  private readonly memory = new Map<string, string>();
  private readonly p256: P256Verifier;
  private keys: Promise<{ log: VerifierKey; witnesses: VerifierKey[] }> | null = null;
  private readonly rekorKeys: { anchor: Uint8Array; rekor: Uint8Array } | null;
  readonly quorum: number;

  constructor(private readonly o: TransparencyOptions) {
    if (!o?.logKey) throw new TransparencyError("transparency.logKey is required.", "bad_options");
    const witnesses = o.witnesses ?? [];
    if (!Array.isArray(witnesses) || (!witnesses.length && !o.rekor)) throw new TransparencyError("transparency.witnesses must list at least one witness key (or set transparency.rekor).", "bad_options");
    this.quorum = o.quorum ?? Math.min(2, witnesses.length);
    if (!Number.isInteger(this.quorum) || this.quorum < (witnesses.length ? 1 : 0) || this.quorum > witnesses.length) throw new TransparencyError("transparency.quorum must be between 1 and the number of witnesses.", "bad_options");
    this.rekorKeys = null;
    if (o.rekor) {
      if (!o.rekor.anchorKey || !o.rekor.rekorKey) throw new TransparencyError("transparency.rekor needs anchorKey and rekorKey.", "bad_options");
      try {
        this.rekorKeys = { anchor: spkiFromText(o.rekor.anchorKey), rekor: spkiFromText(o.rekor.rekorKey) };
      } catch (e) {
        throw new TransparencyError(`transparency.rekor: ${(e as Error).message}.`, "bad_options");
      }
    }
    this.f = o.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
    this.verify = o.ed25519 ?? defaultEd25519Verify;
    this.p256 = o.p256 ?? defaultP256Verify;
  }

  private parsedKeys() {
    this.keys ??= (async () => {
      const log = await parseVerifierKey(this.o.logKey);
      if (log.type !== 0x01) throw new TransparencyError("The log key must be an Ed25519 (0x01) key.", "bad_options");
      const witnesses = await Promise.all((this.o.witnesses ?? []).map(parseVerifierKey));
      if (witnesses.some((w) => w.type !== 0x04)) throw new TransparencyError("Witness keys must be cosignature/v1 (0x04) keys.", "bad_options");
      return { log, witnesses };
    })();
    return this.keys;
  }

  private get base() {
    if (!this.o.logUrl) throw new TransparencyError("transparency.logUrl is required.", "bad_options");
    return this.o.logUrl.replace(/\/$/, "");
  }

  /** The newest checkpoint this client accepted, as a note, or null. */
  async remembered(): Promise<Checkpoint | null> {
    const { log } = await this.parsedKeys();
    const note = this.o.store ? await this.o.store.get(log.name) : this.memory.get(log.name) ?? null;
    if (!note) return null;
    return this.checkpoint(note, { quorum: false });
  }

  private async remember(cp: Checkpoint) {
    if (this.o.store) await this.o.store.set(cp.origin, cp.note);
    else this.memory.set(cp.origin, cp.note);
  }

  /**
   * Verify a checkpoint note: the log's signature, and (unless `quorum: false`) cosignatures from at least `quorum`
   * distinct configured witnesses. Returns the parsed checkpoint and who cosigned it.
   */
  async checkpoint(note: string, o: { quorum?: boolean } = {}): Promise<Checkpoint & { cosignedBy: string[] }> {
    const { log, witnesses } = await this.parsedKeys();
    let parsed;
    let cp;
    try {
      parsed = parseNote(note);
      cp = parseCheckpointText(parsed.text);
    } catch (e) {
      throw new TransparencyError(`The checkpoint is malformed: ${(e as Error).message}.`, "bad_checkpoint");
    }
    if (cp.origin !== log.name) throw new TransparencyError(`The checkpoint is for ${cp.origin}, not ${log.name}.`, "wrong_log");
    const text = utf8(parsed.text);
    let logNote: string | null = null;
    for (const s of parsed.signatures)
      if (!logNote && s.name === log.name && equalBytes(s.keyId, log.keyId) && s.sig.length === 64 && (await this.verify(log.publicKey, text, s.sig).catch(() => false)))
        logNote = `${parsed.text}\n${EM_DASH} ${log.name} ${bytesToBase64(concatBytes(s.keyId, s.sig))}\n`;
    if (!logNote) throw new TransparencyError("The log's signature on the checkpoint does not verify against the pinned log key.", "bad_log_signature");
    const cosignedBy: string[] = [];
    for (const w of witnesses)
      for (const s of parsed.signatures.filter((x) => x.name === w.name && equalBytes(x.keyId, w.keyId) && x.sig.length === 72)) {
        let t = 0n;
        for (const b of s.sig.slice(0, 8)) t = (t << 8n) | BigInt(b);
        if (t > BigInt(Number.MAX_SAFE_INTEGER)) continue;
        if (await this.verify(w.publicKey, cosignedMessage(parsed.text, Number(t)), s.sig.slice(8)).catch(() => false)) {
          cosignedBy.push(w.name);
          break;
        }
      }
    if (o.quorum !== false && cosignedBy.length < this.quorum)
      throw new TransparencyError(`The checkpoint has ${cosignedBy.length} valid witness cosignature(s); ${this.quorum} are required.`, "not_witnessed", { cosignedBy });
    return { ...cp, text: parsed.text, note, logNote, cosignedBy };
  }

  private async getJson(path: string): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, { headers: { accept: "application/json" } });
    } catch (e) {
      throw new TransparencyError(`The log could not be reached: ${(e as Error).message}.`, "log_unavailable");
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  private async consistencyProof(from: number, to: number): Promise<Uint8Array[]> {
    const r = await this.getJson(`/api/v1/tlog/consistency?from=${from}&to=${to}`);
    const proof = r.body?.data?.proof;
    if (r.status !== 200 || !Array.isArray(proof)) throw new TransparencyError(`The log gave no consistency proof from ${from} to ${to}.`, "inconsistent");
    try {
      return proof.map((p: unknown) => strictB64(String(p)));
    } catch {
      throw new TransparencyError("The consistency proof is malformed.", "inconsistent");
    }
  }

  /** Throw SplitViewDetected unless two checkpoints of this log describe one append-only tree. */
  async requireConsistent(a: Checkpoint, b: Checkpoint, supplied?: { from: number; to: number; proof: Uint8Array[] } | null): Promise<void> {
    if (a.size === b.size) {
      if (!equalBytes(a.root, b.root)) throw new SplitViewDetected(`Two different checkpoints of size ${a.size}: the log is showing more than one view.`, { first: a.note, second: b.note });
      return;
    }
    const [lo, hi] = a.size < b.size ? [a, b] : [b, a];
    const proof = supplied && supplied.from === lo.size && supplied.to === hi.size ? supplied.proof : await this.consistencyProof(lo.size, hi.size);
    if (!(await verifyConsistency(lo.size, hi.size, proof, lo.root, hi.root)))
      throw new SplitViewDetected(`The tree of size ${hi.size} does not extend the tree of size ${lo.size}.`, { first: lo.note, second: hi.note }, "inconsistent");
  }

  /**
   * Verify a checkpoint's Rekor anchor (the `rekor` record the log serves with it): the entry commits to exactly this
   * checkpoint note under the pinned anchoring key, is named by its leaf hash, and is included under a checkpoint the
   * pinned Rekor key signed. Throws a TransparencyError (`not_anchored`, `anchor_mismatch` or `bad_anchor`) otherwise.
   */
  async requireAnchored(cp: Checkpoint, record: unknown): Promise<RekorAnchor> {
    if (!this.rekorKeys) throw new TransparencyError("transparency.rekor is not set.", "bad_options");
    if (!record || typeof record !== "object") throw new TransparencyError(`The checkpoint of size ${cp.size} is not anchored in Rekor; refusing it.`, "not_anchored", { size: cp.size });
    const rec = record as Record<string, any>;
    const bad = (why: string, code = "bad_anchor"): never => {
      throw new TransparencyError(`The checkpoint's Rekor anchor does not verify: ${why}.`, code, { size: cp.size, uuid: rec.uuid ?? null });
    };
    const logNote = cp.logNote ?? (await this.checkpoint(cp.note, { quorum: false })).logNote!;
    const artifact = utf8(logNote);

    // a. A hashedrekord over this very note, signed with the pinned anchoring key.
    let bodyBytes: Uint8Array;
    let body: any;
    try {
      bodyBytes = base64ToBytes(String(rec.body ?? ""));
      body = JSON.parse(fromUtf8(bodyBytes));
    } catch {
      return bad("the entry body is not readable");
    }
    if (body?.kind !== "hashedrekord" || body?.apiVersion !== "0.0.1") bad("the entry is not a hashedrekord 0.0.1 entry");
    const hash = body.spec?.data?.hash;
    if (hash?.algorithm !== "sha256" || String(hash?.value ?? "").toLowerCase() !== (await sha256Hex(artifact))) bad("the entry is for a different checkpoint", "anchor_mismatch");
    let entryKey: Uint8Array;
    try {
      entryKey = spkiFromText(fromUtf8(base64ToBytes(String(body.spec?.signature?.publicKey?.content ?? ""))));
    } catch {
      return bad("the entry carries no readable public key");
    }
    if (!equalBytes(entryKey, this.rekorKeys.anchor)) bad("the entry was not signed with the pinned anchoring key");
    let sig: Uint8Array;
    try {
      sig = base64ToBytes(String(body.spec?.signature?.content ?? ""));
    } catch {
      return bad("the entry's signature is not readable");
    }
    if (!(await this.p256(this.rekorKeys.anchor, artifact, sig).catch(() => false))) bad("the entry's signature does not verify");

    // b. Named by its leaf hash and included in Rekor under a checkpoint Rekor signed.
    const leaf = await leafHash(bodyBytes);
    const uuid = String(rec.uuid ?? "").toLowerCase();
    if (!/^(?:[0-9a-f]{16})?[0-9a-f]{64}$/.test(uuid) || !uuid.endsWith(bytesToHex(leaf))) bad("the entry's uuid does not name its body");
    const inc = await verifyRekorInclusion(rec, leaf, this.rekorKeys.rekor, this.p256);
    if (!inc.included) bad("the Rekor inclusion proof does not verify");
    if (!inc.checkpointSigned) bad("Rekor's checkpoint is not signed by the pinned Rekor key");
    return { uuid, logIndex: Number.isSafeInteger(rec.log_index) ? rec.log_index : null, integratedTime: Number.isSafeInteger(rec.integrated_time) ? rec.integrated_time : null, treeSize: inc.treeSize, signedEntryTimestamp: inc.setSigned };
  }

  private proof(kind: TlogKind, digest: string, prev: Checkpoint | null, size?: number) {
    return this.getJson(`/api/v1/tlog/proof?kind=${kind}&sha256=${digest}${prev ? `&from=${prev.size}` : ""}${size !== undefined ? `&size=${size}` : ""}`);
  }

  /** Accept a key or configuration only if it is logged under a witnessed (or anchored) checkpoint consistent with everything seen. */
  async requireLogged(kind: TlogKind, digestOrMaterial: string | Uint8Array): Promise<LoggedKey> {
    if (!(TLOG_KINDS as readonly string[]).includes(kind)) throw new TransparencyError(`Unknown entry kind ${kind}.`, "bad_options");
    const digest = typeof digestOrMaterial === "string" ? digestOrMaterial.toLowerCase() : await sha256Hex(digestOrMaterial);
    if (!isHex(digest, 32)) throw new TransparencyError("A key digest is 64 hex characters.", "bad_options");
    const prev = await this.remembered();
    let r = await this.proof(kind, digest, prev);
    if (this.rekorKeys && r.status === 200 && r.body?.data && !r.body.data.checkpoint?.rekor) {
      // The log answered with a checkpoint that is not anchored (yet): ask for the newest anchored one instead.
      const a = await this.getJson("/api/v1/tlog/rekor");
      const size = a.body?.data?.latest?.size;
      if (a.status !== 200 || !Number.isSafeInteger(size) || size <= Number(r.body.data.index))
        throw new TransparencyError(`No checkpoint that includes this ${kind} is anchored in Rekor yet; refusing it.`, "not_anchored", { kind, sha256: digest });
      r = await this.proof(kind, digest, prev, size);
    }
    if (r.status === 404 && r.body?.error?.type === "not_logged") throw new TransparencyError(`This ${kind} is not in the transparency log; refusing it.`, "not_logged", { kind, sha256: digest });
    if (r.status !== 200 || !r.body?.data) throw new TransparencyError(`The log did not return a proof (HTTP ${r.status}); refusing the key.`, r.status === 409 ? "not_yet_included" : "log_unavailable", { kind, sha256: digest });
    const d = r.body.data as { index: number; entry: string; inclusion: string[]; checkpoint: { note: string; rekor?: unknown }; consistency: { from: number; to: number; proof: string[] } | null };
    const cp = await this.checkpoint(String(d.checkpoint?.note ?? ""));

    // The entry must name this key, and be included under the checkpoint.
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(String(d.entry));
    } catch {
      throw new TransparencyError("The log returned an entry that is not JSON.", "bad_entry");
    }
    if (entry?.v !== 1 || entry.type !== "anyroute.tlog.entry" || entry.kind !== kind || entry.sha256 !== digest)
      throw new TransparencyError("The log returned an entry for a different key.", "bad_entry");
    let proof: Uint8Array[];
    try {
      proof = (d.inclusion ?? []).map((p) => strictB64(String(p)));
    } catch {
      throw new TransparencyError("The inclusion proof is malformed.", "bad_proof");
    }
    if (!(await verifyInclusion(Number(d.index), cp.size, await leafHash(utf8(String(d.entry))), proof, cp.root)))
      throw new TransparencyError("The inclusion proof does not lead from the entry to the checkpoint's root.", "bad_proof");
    const rekor = this.rekorKeys ? await this.requireAnchored(cp, d.checkpoint?.rekor) : undefined;

    // No split view: consistent with what this client saw before and with every mirror.
    let supplied = null;
    if (d.consistency && Array.isArray(d.consistency.proof)) {
      try {
        supplied = { from: Number(d.consistency.from), to: Number(d.consistency.to), proof: d.consistency.proof.map((p) => strictB64(String(p))) };
      } catch {
        supplied = null;
      }
    }
    if (prev) await this.requireConsistent(prev, cp, supplied);
    for (const url of this.o.mirrors ?? []) {
      let note: string;
      try {
        const res = await this.f(url, { headers: { accept: "text/plain" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        note = await res.text();
      } catch (e) {
        throw new TransparencyError(`The checkpoint mirror ${url} could not be read: ${(e as Error).message}.`, "mirror_unavailable");
      }
      await this.requireConsistent(cp, await this.checkpoint(note, { quorum: false }));
    }
    if (!prev || cp.size > prev.size) await this.remember(cp);
    return { kind, sha256: digest, index: Number(d.index), entry, checkpoint: { size: cp.size, rootHash: bytesToBase64(cp.root) }, cosignedBy: cp.cosignedBy, ...(rekor ? { rekor } : {}) };
  }
}

// ---- Rekor ------------------------------------------------------------------------------------------------------------

/**
 * Check a Rekor entry record (`body`, `inclusion_proof` with hex hashes and Rekor's signed `checkpoint`, and optionally
 * `log_index`, `integrated_time`, `log_id`, `signed_entry_timestamp`) against the entry's leaf hash and Rekor's key:
 *   included          the inclusion proof leads from the leaf to the proof's root hash;
 *   checkpointSigned  Rekor's checkpoint note commits to that tree size and root and a signature on it verifies;
 *   setSigned         the signed entry timestamp verifies (canonical JSON of body, integratedTime, logID, logIndex).
 */
export async function verifyRekorInclusion(rec: Record<string, any>, leaf: Uint8Array, rekorKey: Uint8Array, p256: P256Verifier = defaultP256Verify) {
  const out = { included: false, checkpointSigned: false, setSigned: false, treeSize: 0 };
  const p = rec?.inclusion_proof;
  if (!p || !Number.isSafeInteger(p.log_index) || !Number.isSafeInteger(p.tree_size) || !isHex(p.root_hash, 32) || !Array.isArray(p.hashes) || !p.hashes.every((h: unknown) => isHex(h, 32))) return out;
  const root = hexToBytes(p.root_hash);
  out.treeSize = p.tree_size;
  out.included = await verifyInclusion(p.log_index, p.tree_size, leaf, p.hashes.map((h: string) => hexToBytes(h)), root);
  const note = typeof p.checkpoint === "string" ? p.checkpoint : "";
  const split = note.indexOf("\n\n");
  if (out.included && split > 0) {
    const text = note.slice(0, split + 1);
    const lines = text.split("\n");
    let rootOk = false;
    try {
      rootOk = equalBytes(base64ToBytes(lines[2] ?? ""), root);
    } catch {
      rootOk = false;
    }
    if (lines[1] === String(p.tree_size) && rootOk)
      for (const line of note.slice(split + 2).split("\n")) {
        if (out.checkpointSigned || !line.startsWith(`${EM_DASH} `)) continue;
        let raw: Uint8Array;
        try {
          raw = base64ToBytes(line.split(" ")[2] ?? "");
        } catch {
          continue;
        }
        if (raw.length > 4) out.checkpointSigned = await p256(rekorKey, utf8(text), raw.slice(4)).catch(() => false);
      }
  }
  if (typeof rec.signed_entry_timestamp === "string" && typeof rec.log_id === "string" && Number.isSafeInteger(rec.integrated_time) && Number.isSafeInteger(rec.log_index)) {
    try {
      const payload = utf8(canonicalJson({ body: rec.body, integratedTime: rec.integrated_time, logID: rec.log_id, logIndex: rec.log_index }));
      out.setSigned = await p256(rekorKey, payload, base64ToBytes(rec.signed_entry_timestamp));
    } catch {
      out.setSigned = false;
    }
  }
  return out;
}
