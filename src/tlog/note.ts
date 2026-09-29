import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

// C2SP signed-note, tlog-checkpoint and tlog-cosignature.
//
// A signed note is a text ending in a newline, a blank line, then signature lines "— <key name> <base64(key id || sig)>".
// The key id is the first 4 bytes of SHA-256(key name || 0x0A || signature type || public key).
//
//   type 0x01  Ed25519 over the note text (the log's own signature on its checkpoint)
//   type 0x04  cosignature/v1: Ed25519 over "cosignature/v1\ntime <T>\n" || checkpoint text, carried as
//              key id (4) || T as big-endian uint64 seconds (8) || signature (64)
//
// A checkpoint's text is "<origin>\n<tree size>\n<base64 root hash>\n" (extension lines are not used by this log).

export const SIG_ED25519 = 0x01;
export const SIG_COSIGNATURE_V1 = 0x04;
const MAX_SIGNATURES = 100;
const MAX_NOTE_BYTES = 16_384;
const EM_DASH = "—";
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export const keyIdOf = (name: string, type: number, publicKey: Uint8Array): Buffer =>
  createHash("sha256").update(name).update(Buffer.from([0x0a, type])).update(publicKey).digest().subarray(0, 4);

/** Key names are non-empty and contain no whitespace or "+" (signed-note). */
export const validKeyName = (name: string) => name.length > 0 && name.length <= 256 && !/[\s+]/u.test(name);

const rawPublic = (pub: KeyObject) => Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
const publicFromRaw = (raw: Uint8Array) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });

export type NoteVerifier = { name: string; type: number; keyId: Buffer; publicKey: Buffer; key: KeyObject };

/** "<name>+<8 hex key id>+<base64(type || 32-byte public key)>", the signed-note verifier key encoding. */
export function formatVerifierKey(name: string, type: number, publicKey: Uint8Array): string {
  return `${name}+${keyIdOf(name, type, publicKey).toString("hex")}+${Buffer.concat([Buffer.from([type]), publicKey]).toString("base64")}`;
}

export function parseVerifierKey(vkey: string): NoteVerifier {
  const m = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/.exec(vkey.trim());
  if (!m) throw new Error("a verifier key is <name>+<8 hex>+<base64 key>");
  const [, name, idHex, b64] = m;
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 33 || (raw[0] !== SIG_ED25519 && raw[0] !== SIG_COSIGNATURE_V1)) throw new Error("the verifier key must be an Ed25519 (0x01) or cosignature/v1 (0x04) key");
  const type = raw[0];
  const publicKey = raw.subarray(1);
  const keyId = keyIdOf(name, type, publicKey);
  if (keyId.toString("hex") !== idHex) throw new Error("the verifier key's id does not match its name and key");
  return { name, type, keyId, publicKey, key: publicFromRaw(publicKey) };
}

export type NoteSigner = { name: string; type: number; keyId: Buffer; publicKey: Buffer; verifierKey: string; sign(message: Uint8Array): Buffer };

/** An Ed25519 signer from a 32-byte seed or a PKCS#8 key, for `type` 0x01 (note) or 0x04 (cosignature/v1). */
export function noteSigner(name: string, type: number, key: Uint8Array | KeyObject): NoteSigner {
  if (!validKeyName(name)) throw new Error("a key name must be non-empty and contain no spaces or '+'");
  const priv = key instanceof Uint8Array ? createPrivateKey({ key: key.length === 32 ? Buffer.concat([PKCS8_ED25519, key]) : Buffer.from(key), format: "der", type: "pkcs8" }) : key;
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("the key must be Ed25519");
  const publicKey = rawPublic(createPublicKey(priv));
  return { name, type, keyId: keyIdOf(name, type, publicKey), publicKey, verifierKey: formatVerifierKey(name, type, publicKey), sign: (m) => edSign(null, m, priv) };
}

/** The Go/C2SP private key encoding "PRIVATE+KEY+<name>+<8 hex>+<base64(0x01 || seed)>". */
export function parseSignerKey(skey: string): { name: string; seed: Buffer } {
  const m = /^PRIVATE\+KEY\+([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+={0,2})$/.exec(skey.trim());
  if (!m) throw new Error("a signer key is PRIVATE+KEY+<name>+<8 hex>+<base64 key>");
  const raw = Buffer.from(m[3], "base64");
  if (raw.length !== 33 || raw[0] !== SIG_ED25519) throw new Error("the signer key must be an Ed25519 (0x01) key");
  const seed = raw.subarray(1);
  if (noteSigner(m[1], SIG_ED25519, seed).keyId.toString("hex") !== m[2]) throw new Error("the signer key's id does not match its name and key");
  return { name: m[1], seed };
}

export const formatSignerKey = (name: string, seed: Uint8Array) => `PRIVATE+KEY+${name}+${noteSigner(name, SIG_ED25519, seed).keyId.toString("hex")}+${Buffer.concat([Buffer.from([SIG_ED25519]), seed]).toString("base64")}`;

// ---- notes ---------------------------------------------------------------------------------------------------------

export type NoteSignature = { name: string; keyId: Buffer; sig: Buffer; line: string };
export type SignedNote = { text: string; signatures: NoteSignature[] };

export const signatureLine = (name: string, keyId: Uint8Array, sig: Uint8Array) => `${EM_DASH} ${name} ${Buffer.concat([keyId, sig]).toString("base64")}\n`;

/** Split a signed note into its text and signature lines. Throws on anything malformed. */
export function parseNote(msg: string): SignedNote {
  if (Buffer.byteLength(msg) > MAX_NOTE_BYTES) throw new Error("note too large");
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(msg)) throw new Error("note contains control characters");
  const split = msg.lastIndexOf("\n\n");
  if (split < 0) throw new Error("note has no signatures");
  const text = msg.slice(0, split + 1);
  const rest = msg.slice(split + 2);
  if (!rest.endsWith("\n")) throw new Error("note does not end in a newline");
  const signatures: NoteSignature[] = [];
  for (const line of rest.slice(0, -1).split("\n")) {
    const m = new RegExp(`^${EM_DASH} ([^\\s+]+) ([A-Za-z0-9+/]+={0,2})$`, "u").exec(line);
    if (!m) throw new Error("malformed signature line");
    const raw = Buffer.from(m[2], "base64");
    if (raw.length < 5 || raw.toString("base64") !== m[2]) throw new Error("malformed signature");
    signatures.push({ name: m[1], keyId: raw.subarray(0, 4), sig: raw.subarray(4), line: line + "\n" });
    if (signatures.length > MAX_SIGNATURES) throw new Error("too many signatures");
  }
  if (!signatures.length) throw new Error("note has no signatures");
  return { text, signatures };
}

export const formatNote = (text: string, lines: string[]) => `${text}\n${lines.join("")}`;

/** The note's signature by this Ed25519 (0x01) verifier, if one verifies. */
export function verifyNoteSignature(n: SignedNote, v: NoteVerifier): boolean {
  if (v.type !== SIG_ED25519) return false;
  return n.signatures.some((s) => s.name === v.name && s.keyId.equals(v.keyId) && s.sig.length === 64 && safeVerify(Buffer.from(n.text), v.key, s.sig));
}

const safeVerify = (msg: Uint8Array, key: KeyObject, sig: Uint8Array) => {
  try {
    return edVerify(null, msg, key, sig);
  } catch {
    return false;
  }
};

// ---- checkpoints ---------------------------------------------------------------------------------------------------

export type Checkpoint = { origin: string; size: number; root: Buffer; text: string };

export function formatCheckpoint(origin: string, size: number, root: Uint8Array): string {
  if (!validOrigin(origin)) throw new Error("bad origin");
  return `${origin}\n${size}\n${Buffer.from(root).toString("base64")}\n`;
}

const validOrigin = (o: string) => o.length > 0 && o.length <= 256 && !/[\s+]/u.test(o);

/** Parse a checkpoint text (no signatures). Extension lines are refused. */
export function parseCheckpoint(text: string): Checkpoint {
  const lines = text.split("\n");
  if (lines.length !== 4 || lines[3] !== "") throw new Error("a checkpoint is exactly three lines (no extension lines)");
  const [origin, sizeText, rootB64] = lines;
  if (!validOrigin(origin)) throw new Error("bad checkpoint origin");
  if (!/^(0|[1-9]\d{0,15})$/.test(sizeText) || !Number.isSafeInteger(Number(sizeText))) throw new Error("bad checkpoint size");
  const root = Buffer.from(rootB64, "base64");
  if (root.length !== 32 || root.toString("base64") !== rootB64) throw new Error("bad checkpoint root hash");
  return { origin, size: Number(sizeText), root, text };
}

// ---- cosignatures (tlog-cosignature, cosignature/v1) ----------------------------------------------------------------

export const cosignedMessage = (checkpointText: string, timestamp: number) => Buffer.from(`cosignature/v1\ntime ${timestamp}\n${checkpointText}`);

/** A witness cosignature line over this checkpoint text at `timestamp` (seconds). */
export function cosign(signer: NoteSigner, checkpointText: string, timestamp: number): string {
  if (signer.type !== SIG_COSIGNATURE_V1) throw new Error("a cosignature needs a cosignature/v1 (0x04) key");
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("bad timestamp");
  const t = Buffer.alloc(8);
  t.writeBigUInt64BE(BigInt(timestamp));
  return signatureLine(signer.name, signer.keyId, Buffer.concat([t, signer.sign(cosignedMessage(checkpointText, timestamp))]));
}

/** The timestamp of a valid cosignature/v1 by this witness over the checkpoint text, or null. */
export function verifyCosignature(checkpointText: string, s: NoteSignature, w: NoteVerifier): number | null {
  if (w.type !== SIG_COSIGNATURE_V1 || s.name !== w.name || !s.keyId.equals(w.keyId) || s.sig.length !== 72) return null;
  const t = s.sig.readBigUInt64BE(0);
  if (t > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const timestamp = Number(t);
  return safeVerify(cosignedMessage(checkpointText, timestamp), w.key, s.sig.subarray(8)) ? timestamp : null;
}
