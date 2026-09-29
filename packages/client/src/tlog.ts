import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, equalBytes, isHex, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
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

export const TLOG_KINDS = ["receipt_key", "ohttp_key_config", "blind_issuer_key", "measurement_bundle", "attestation_binding"] as const;
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
export type Checkpoint = { origin: string; size: number; root: Uint8Array; text: string; note: string };

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

export type TransparencyOptions = {
  /** The log's verifier key "<origin>+<id>+<base64 key>", pinned out of band (for example from the documentation). */
  logKey: string;
  /** Witness verifier keys (cosignature/v1, type 0x04), pinned out of band. */
  witnesses: string[];
  /** How many of those witnesses must have cosigned. Default: 2, or 1 when only one witness is configured. */
  quorum?: number;
  /** Base URL of the router that serves the log (…/api/v1/tlog). The AnyRoute client passes its own. */
  logUrl?: string;
  /** Other places serving the log's checkpoint (full URLs), fetched as a second path: each must agree with the log. */
  mirrors?: string[];
  store?: CheckpointStore;
  fetch?: Fetch;
  ed25519?: Ed25519Verifier;
};

export type LoggedKey = { kind: TlogKind; sha256: string; index: number; entry: Record<string, unknown>; checkpoint: { size: number; rootHash: string }; cosignedBy: string[] };

export class TransparencyLog {
  private readonly f: Fetch;
  private readonly verify: Ed25519Verifier;
  private readonly memory = new Map<string, string>();
  private keys: Promise<{ log: VerifierKey; witnesses: VerifierKey[] }> | null = null;
  readonly quorum: number;

  constructor(private readonly o: TransparencyOptions) {
    if (!o?.logKey) throw new TransparencyError("transparency.logKey is required.", "bad_options");
    if (!Array.isArray(o.witnesses) || !o.witnesses.length) throw new TransparencyError("transparency.witnesses must list at least one witness key.", "bad_options");
    this.quorum = o.quorum ?? Math.min(2, o.witnesses.length);
    if (!Number.isInteger(this.quorum) || this.quorum < 1 || this.quorum > o.witnesses.length) throw new TransparencyError("transparency.quorum must be between 1 and the number of witnesses.", "bad_options");
    this.f = o.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
    this.verify = o.ed25519 ?? defaultEd25519Verify;
  }

  private parsedKeys() {
    this.keys ??= (async () => {
      const log = await parseVerifierKey(this.o.logKey);
      if (log.type !== 0x01) throw new TransparencyError("The log key must be an Ed25519 (0x01) key.", "bad_options");
      const witnesses = await Promise.all(this.o.witnesses.map(parseVerifierKey));
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
    let signed = false;
    for (const s of parsed.signatures) if (!signed && s.name === log.name && equalBytes(s.keyId, log.keyId) && s.sig.length === 64) signed = await this.verify(log.publicKey, text, s.sig).catch(() => false);
    if (!signed) throw new TransparencyError("The log's signature on the checkpoint does not verify against the pinned log key.", "bad_log_signature");
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
    return { ...cp, text: parsed.text, note, cosignedBy };
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

  /** Accept a key or configuration only if it is logged under a witnessed checkpoint consistent with everything seen. */
  async requireLogged(kind: TlogKind, digestOrMaterial: string | Uint8Array): Promise<LoggedKey> {
    if (!(TLOG_KINDS as readonly string[]).includes(kind)) throw new TransparencyError(`Unknown entry kind ${kind}.`, "bad_options");
    const digest = typeof digestOrMaterial === "string" ? digestOrMaterial.toLowerCase() : await sha256Hex(digestOrMaterial);
    if (!isHex(digest, 32)) throw new TransparencyError("A key digest is 64 hex characters.", "bad_options");
    const prev = await this.remembered();
    const r = await this.getJson(`/api/v1/tlog/proof?kind=${kind}&sha256=${digest}${prev ? `&from=${prev.size}` : ""}`);
    if (r.status === 404 && r.body?.error?.type === "not_logged") throw new TransparencyError(`This ${kind} is not in the transparency log; refusing it.`, "not_logged", { kind, sha256: digest });
    if (r.status !== 200 || !r.body?.data) throw new TransparencyError(`The log did not return a proof (HTTP ${r.status}); refusing the key.`, r.status === 409 ? "not_yet_included" : "log_unavailable", { kind, sha256: digest });
    const d = r.body.data as { index: number; entry: string; inclusion: string[]; checkpoint: { note: string }; consistency: { from: number; to: number; proof: string[] } | null };
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
    return { kind, sha256: digest, index: Number(d.index), entry, checkpoint: { size: cp.size, rootHash: bytesToBase64(cp.root) }, cosignedBy: cp.cosignedBy };
  }
}
