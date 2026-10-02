import { validRouteExplanation } from "./route-explanation.js"; // V84
import { base64ToBytes, bytesToHex, concatBytes, equalBytes, hexToBytes, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { defaultEd25519Verify, UnsupportedCrypto, type Ed25519Verifier } from "./ed25519.js";
import { keccak256, sha256 } from "./hash.js";
import type { AnchorProof, Check, Fetch, JwkKey, KeySet, ReceiptEnvelope } from "./types.js";

// Receipt verification. A receipt is a JSON payload plus an Ed25519 signature over the payload's canonical JSON
// (keys sorted, no whitespace). The router publishes its signing keys at /.well-known/anyroute-receipt-keys.json; a
// sidecar receipt is checked against the raw key its attestation binds. Nothing here talks to the server that issued
// the receipt except to fetch the key set, and a caller that pins keys never needs even that.

export const RECEIPT_KEYS_PATH = "/.well-known/anyroute-receipt-keys.json";

/** Bytes that were signed: the canonical JSON of the payload. Same rule as the router (`canonicalBytes`). */
export const canonicalBytes = (payload: unknown): Uint8Array => utf8(canonicalJson(payload));

/** The key id the router derives: the first 16 hex characters of sha256(raw public key). */
export async function keyIdOf(rawPublicKey: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(rawPublicKey)).slice(0, 16);
}

/** keccak256(keccak256(canonical bytes || signature)), 0x-prefixed. */
export function receiptLeaf(canonical: Uint8Array, signature: Uint8Array): string {
  return "0x" + bytesToHex(keccak256(keccak256(concatBytes(canonical, signature))));
}

/** Sorted-pair (OpenZeppelin-compatible) merkle inclusion, the scheme the router's anchors use. */
export function verifyMerkleProof(leaf: string, proof: string[], root: string): boolean {
  try {
    let h = hexToBytes(leaf);
    for (const p of proof) {
      const q = hexToBytes(p);
      const [a, b] = compare(h, q) < 0 ? [h, q] : [q, h];
      h = keccak256(concatBytes(a, b));
    }
    return equalBytes(h, hexToBytes(root));
  } catch {
    return false;
  }
}
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export async function fetchReceiptKeys(baseUrl: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<KeySet> {
  const res = await fetchImpl(baseUrl.replace(/\/$/, "") + RECEIPT_KEYS_PATH, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${RECEIPT_KEYS_PATH} failed with ${res.status}`);
  return parseKeySet(await res.json());
}

/** Accepts the published JWKS shape and drops nothing silently: a malformed set is an error. */
export function parseKeySet(json: unknown): KeySet {
  const keys = (json as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new Error("receipt key set has no keys array");
  for (const k of keys as Partial<JwkKey>[]) if (typeof k?.x !== "string" || typeof k?.kid !== "string") throw new Error("receipt key set contains a malformed key");
  return { keys: keys as JwkKey[] };
}

export type VerifyReceiptOptions = {
  /** The router's published keys. */
  keys?: KeySet | JwkKey[];
  /** A raw 32-byte Ed25519 public key in hex, for example a sidecar's `bindings.receipt_pubkey`. Used instead of `keys`. */
  publicKeyHex?: string;
  ed25519?: Ed25519Verifier;
  /** Tolerance when comparing a receipt's timestamp with its key's validity window. Default 5 minutes. */
  clockSkewMs?: number;
};

export type ReceiptVerification = {
  /** True only when the signature verifies under a key whose id is what it claims and no other check failed. */
  valid: boolean;
  keyId: string;
  checks: Check[];
  anchor: "proof_valid" | "proof_invalid" | "no_proof";
  /** What this function cannot establish on its own. */
  notChecked: string[];
};

const NOT_CHECKED_RECEIPT = [
  "That the signing key is the one registered on chain: compare the key id with ReceiptAnchor, or pin the key yourself.",
  "That the anchor root was posted on chain: an inclusion proof shows the receipt is under a root, not that the root was published.",
];

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const notChecked = (id: string, detail: string): Check => ({ id, status: "not_checked", detail });

function payloadTime(payload: Record<string, unknown>): number | null {
  const ts = payload.ts;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const issued = payload.issued;
  if (typeof issued === "string") {
    const t = Date.parse(issued);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export async function verifyReceipt(receipt: ReceiptEnvelope, opts: VerifyReceiptOptions = {}): Promise<ReceiptVerification> {
  const checks: Check[] = [];
  const keyId = typeof receipt?.key_id === "string" ? receipt.key_id : "";
  const done = (anchor: ReceiptVerification["anchor"]): ReceiptVerification => ({
    valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "signature" && c.status === "pass"),
    keyId,
    checks,
    anchor,
    notChecked: NOT_CHECKED_RECEIPT,
  });

  if (!receipt || typeof receipt !== "object" || typeof receipt.payload !== "object" || receipt.payload === null || typeof receipt.sig !== "string" || !keyId) {
    checks.push(fail("shape", "A receipt needs payload, sig and key_id."));
    return done("no_proof");
  }
  checks.push(receipt.alg === undefined || receipt.alg === "Ed25519" ? pass("alg", "Ed25519") : fail("alg", `unsupported algorithm ${String(receipt.alg)}`));

  if (receipt.payload.route !== undefined) checks.push(validRouteExplanation(receipt.payload.route, receipt.payload.provider) ? pass("route", "Versioned routing summary; the signature covers it, not an independent selection check.") : fail("route", "Invalid route explanation.")); // V84

  // Which public key does this receipt claim, and is it one we were given?
  let raw: Uint8Array | null = null;
  let window: { from: number | null; to: number | null } | null = null;
  if (opts.publicKeyHex) {
    try {
      raw = hexToBytes(opts.publicKeyHex);
      if (raw.length !== 32) throw new Error("wrong length");
    } catch {
      checks.push(fail("key", "The supplied public key is not 32 bytes of hex."));
    }
    if (raw) {
      const derived = await keyIdOf(raw);
      checks.push(derived === keyId ? pass("key", `key id ${keyId} matches the supplied key`) : fail("key", `receipt key id ${keyId} is not the supplied key's id (${derived})`));
    }
  } else {
    const list = Array.isArray(opts.keys) ? opts.keys : opts.keys?.keys ?? [];
    const jwk = list.find((k) => k.kid === keyId);
    if (!jwk) {
      checks.push(fail("key", `Key ${keyId} is not in the published key set.`));
    } else if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      checks.push(fail("key", "The published key is not an Ed25519 key."));
    } else {
      try {
        raw = base64ToBytes(jwk.x);
        if (raw.length !== 32) throw new Error("wrong length");
        const derived = await keyIdOf(raw);
        checks.push(derived === keyId ? pass("key", `key ${keyId} is in the published set and its id matches the key bytes`) : fail("key", `the published key's id does not match its bytes (${derived})`));
        window = { from: jwk.valid_from ? Date.parse(jwk.valid_from) : null, to: jwk.retired_at ? Date.parse(jwk.retired_at) : null };
      } catch {
        raw = null;
        checks.push(fail("key", "The published key is malformed."));
      }
    }
  }

  // Signature over the canonical JSON of the payload.
  let sigBytes: Uint8Array | null = null;
  try {
    sigBytes = base64ToBytes(receipt.sig);
  } catch {
    checks.push(fail("signature", "The signature is not valid base64."));
  }
  const bytes = canonicalBytes(receipt.payload);
  if (raw && sigBytes && !checks.some((c) => c.id === "key" && c.status === "fail")) {
    try {
      const ok = await (opts.ed25519 ?? defaultEd25519Verify)(raw, bytes, sigBytes);
      checks.push(ok ? pass("signature", "Ed25519 signature over the canonical payload verifies") : fail("signature", "The signature does not verify for this payload and key."));
    } catch (e) {
      checks.push(e instanceof UnsupportedCrypto ? notChecked("signature", `This runtime cannot verify Ed25519: ${e.message}`) : fail("signature", (e as Error).message));
    }
  } else if (!checks.some((c) => c.id === "signature")) {
    checks.push(fail("signature", "Not verified: there is no usable key or signature."));
  }

  // Key validity window (router keys rotate weekly and old keys stay published).
  const t = payloadTime(receipt.payload);
  if (window && t !== null && (window.from !== null || window.to !== null)) {
    const skew = opts.clockSkewMs ?? 300_000;
    const early = window.from !== null && t < window.from - skew;
    const late = window.to !== null && t > window.to + skew;
    checks.push(early || late ? fail("key_window", "The receipt is dated outside its signing key's validity window.") : pass("key_window", "The receipt time falls inside its key's validity window"));
  } else {
    checks.push(notChecked("key_window", "No key window or receipt time to compare."));
  }

  // Leaf: recompute from the canonical bytes and signature.
  if (receipt.leaf && sigBytes) {
    const leaf = receiptLeaf(bytes, sigBytes);
    checks.push(leaf === receipt.leaf.toLowerCase() ? pass("leaf", "leaf = keccak256(keccak256(payload || signature)) matches") : fail("leaf", "The leaf does not match the payload and signature."));
  } else {
    checks.push(notChecked("leaf", "The receipt carries no leaf."));
  }

  // Anchor inclusion proof, when the receipt came with one.
  let anchor: ReceiptVerification["anchor"] = "no_proof";
  const proof: AnchorProof | null | undefined = receipt.anchor;
  if (proof && Array.isArray(proof.proof) && typeof proof.root === "string" && receipt.leaf) {
    const ok = verifyMerkleProof(receipt.leaf, proof.proof, proof.root);
    anchor = ok ? "proof_valid" : "proof_invalid";
    checks.push(ok ? pass("anchor_proof", `leaf is included under root ${proof.root.slice(0, 10)}…`) : fail("anchor_proof", "The inclusion proof does not lead from the leaf to the stated root."));
  } else {
    checks.push(notChecked("anchor_proof", "No anchor proof supplied (a receipt is anchored within the hour; fetch it again later)."));
  }
  return done(anchor);
}
