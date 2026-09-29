import { canonicalJson, sha256Bytes, hexToBytes, bytesToHex } from "./util.ts";

// What the hardware quote is bound to. The 64-byte report_data field of the quote is
//   sha256(canonical_json({tls_pubkey, receipt_pubkey, image_digest, compose_hash, model_digest})) || nonce
// where the nonce is 32 bytes (all zero for the quote taken at boot). A verifier rebuilds this from /attest and
// compares it with the report_data inside the quote.

export type Bindings = {
  /** Hex SubjectPublicKeyInfo DER of the TLS key. */
  tlsPubkey: string;
  /** Hex raw 32-byte Ed25519 receipt key. */
  receiptPubkey: string;
  /** "sha256:<hex>" or "" when the operator did not declare one (development only). */
  imageDigest: string;
  /** "sha256:<hex>" or "". */
  composeHash: string;
  modelDigest: string;
};

export const bindingsObject = (b: Bindings) => ({
  tls_pubkey: b.tlsPubkey,
  receipt_pubkey: b.receiptPubkey,
  image_digest: b.imageDigest,
  compose_hash: b.composeHash,
  model_digest: b.modelDigest,
});

export const bindingsDigest = (b: Bindings): Uint8Array => sha256Bytes(canonicalJson(bindingsObject(b)));

export const ZERO_NONCE = new Uint8Array(32);

export function reportData(b: Bindings, nonce: Uint8Array = ZERO_NONCE): Uint8Array {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const out = new Uint8Array(64);
  out.set(bindingsDigest(b), 0);
  out.set(nonce, 32);
  return out;
}

export const reportDataHex = (b: Bindings, nonce?: Uint8Array) => bytesToHex(reportData(b, nonce));

/** Parse a client nonce: exactly 64 hex characters. */
export function parseNonce(hex: string): Uint8Array | null {
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(hex)) return null;
  return hexToBytes(hex);
}
