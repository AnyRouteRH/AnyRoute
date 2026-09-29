import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, canonicalBytes, randomHex, sha256Hex } from "./util.ts";

// Receipts: the enclave signs, per response,
//   sig(H(req) ‖ H(resp) ‖ model_digest ‖ attestation_ref ‖ nullifier ‖ ts ‖ usage)
// The fields are carried as one JSON object and signed over its canonical bytes (keys sorted, no whitespace),
// which is unambiguous where a raw concatenation is not, and is the same encoding and Ed25519 scheme the router
// uses for its own receipts. The signing key is generated in memory at boot and its public half is bound into the
// attestation report data. Fields that only exist when a feature is on (`classifier`, `e2ee`) are left out
// otherwise, so a receipt from a deployment without them is unchanged.

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export type ReceiptPayload = {
  v: 1;
  type: "anyroute.sidecar.receipt";
  id: string;
  /** Unix milliseconds. */
  ts: number;
  path: string;
  status: number;
  stream: boolean;
  /** For streams: the upstream sent its terminating event. Always true for non-streaming responses. */
  complete: boolean;
  /** "sha256:<hex>" of the exact request body bytes received from the client. */
  req_hash: string;
  /** "sha256:<hex>" of the exact upstream response body bytes (for streams: the whole event stream, terminator included). */
  resp_hash: string;
  model_digest: string;
  /** 64 hex characters: the reference carried in the TLS certificate SAN and served at /attest. */
  attestation_ref: string;
  /** Reserved for unlinkable-access tokens. Always empty in this version. */
  nullifier: string;
  usage: Usage | null;
  /** True when the attestation behind this receipt is simulated. Verifiers must reject dev receipts in production. */
  dev: boolean;
  /**
   * Present only when the in-enclave classifier is on: its weights digest (the one bound in the attestation) and one
   * bit, whether it refused this exchange. Nothing about the content or the category is recorded.
   */
  classifier?: { enabled: true; digest: string; blocked: boolean };
  /**
   * Present only for end-to-end encrypted exchanges. req_hash and resp_hash are then hashes of the encrypted bytes
   * on the wire (for a stream, everything before the final frame, which carries this receipt), which the client
   * can recompute from what it sent and received.
   */
  e2ee?: "anyroute-hpke-v1";
};

export type ReceiptEnvelope = {
  payload: ReceiptPayload;
  /** Base64 Ed25519 signature over canonicalBytes(payload). */
  sig: string;
  key_id: string;
  alg: "Ed25519";
  /** keccak256(keccak256(canonicalBytes ‖ sigBytes)): the leaf the router anchors, identical to its own receipt leaf. */
  leaf: string;
};

const rawPublic = (pub: KeyObject) => Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
const publicFromRaw = (hex: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(hex, "hex").toString("base64url") }, format: "jwk" });

export const keyIdOf = (publicKeyHex: string) => sha256Hex(Buffer.from(publicKeyHex, "hex")).slice(0, 16);

export function receiptLeaf(canonical: Uint8Array, signature: Uint8Array): string {
  const inner = keccak_256(Buffer.concat([canonical, signature]));
  return "0x" + bytesToHex(keccak_256(inner));
}

export class EnclaveSigner {
  readonly publicKeyHex: string;
  readonly keyId: string;
  private constructor(private privateKey: KeyObject) {
    this.publicKeyHex = rawPublic(createPublicKey(privateKey)).toString("hex");
    this.keyId = keyIdOf(this.publicKeyHex);
  }

  /** A fresh in-memory key. It is never exported or written anywhere. */
  static generate(): EnclaveSigner {
    return new EnclaveSigner(generateKeyPairSync("ed25519").privateKey);
  }

  /** For tests that need a fixed key. */
  static fromPkcs8(der: Buffer): EnclaveSigner {
    return new EnclaveSigner(createPrivateKey({ key: der, format: "der", type: "pkcs8" }));
  }

  sign(payload: ReceiptPayload): ReceiptEnvelope {
    const bytes = canonicalBytes(payload);
    const sigBytes = edSign(null, bytes, this.privateKey);
    return { payload, sig: sigBytes.toString("base64"), key_id: this.keyId, alg: "Ed25519", leaf: receiptLeaf(bytes, sigBytes) };
  }
}

/** Check a receipt's signature (and that its leaf matches) against the raw Ed25519 public key from /attest. */
export function verifyReceipt(env: ReceiptEnvelope, publicKeyHex: string): boolean {
  try {
    if (env.alg !== "Ed25519" || env.key_id !== keyIdOf(publicKeyHex)) return false;
    const bytes = canonicalBytes(env.payload);
    const sig = Buffer.from(env.sig, "base64");
    if (!edVerify(null, bytes, publicFromRaw(publicKeyHex), sig)) return false;
    return receiptLeaf(bytes, sig) === env.leaf;
  } catch {
    return false;
  }
}

export const encodeReceiptHeader = (env: ReceiptEnvelope) => Buffer.from(JSON.stringify(env)).toString("base64url");
export const decodeReceiptHeader = (value: string): ReceiptEnvelope => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export const newReceiptId = () => `rcpt_${randomHex(12)}`;

export function normalizeUsage(u: unknown): Usage | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const prompt = n(o.prompt_tokens) ?? n(o.input_tokens);
  const completion = n(o.completion_tokens) ?? n(o.output_tokens) ?? 0;
  const total = n(o.total_tokens) ?? (prompt !== null ? prompt + completion : null);
  if (prompt === null || total === null) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

// ---- local queue the router's anchor pulls from ------------------------------------------------------

export type QueuedLeaf = { seq: number; leaf: string; id: string; ts: number; receipt: ReceiptEnvelope };

/**
 * The interface the router's anchor uses: pull the next batch after a cursor, then acknowledge what it has
 * anchored so the sidecar can drop it. Sequence numbers start at 1 and only increase.
 */
export interface LeafSource {
  pull(afterSeq: number, limit: number): { leaves: QueuedLeaf[]; head: number };
  ack(throughSeq: number): { removed: number; pending: number };
}

/** In-memory queue. When it is full the oldest leaves are dropped (and counted) rather than blocking traffic. */
export class ReceiptQueue implements LeafSource {
  private items: QueuedLeaf[] = [];
  private seq = 0;
  dropped = 0;
  constructor(private capacity: number) {}

  push(env: ReceiptEnvelope): QueuedLeaf {
    const item: QueuedLeaf = { seq: ++this.seq, leaf: env.leaf, id: env.payload.id, ts: env.payload.ts, receipt: env };
    this.items.push(item);
    if (this.items.length > this.capacity) {
      const over = this.items.length - this.capacity;
      this.items.splice(0, over);
      this.dropped += over;
    }
    return item;
  }

  pull(afterSeq: number, limit: number) {
    const start = this.items.findIndex((i) => i.seq > afterSeq);
    const leaves = start < 0 ? [] : this.items.slice(start, start + Math.max(1, limit));
    return { leaves, head: this.seq };
  }

  ack(throughSeq: number) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.seq > throughSeq);
    return { removed: before - this.items.length, pending: this.items.length };
  }

  get pending() {
    return this.items.length;
  }
  get head() {
    return this.seq;
  }
}

/** Recent receipts by id, so a client whose SSE reader stopped at `[DONE]` can still fetch the receipt it earned. */
export class ReceiptIndex {
  private items = new Map<string, { owner: string; receipt: ReceiptEnvelope }>();
  constructor(private capacity = 10_000) {}
  add(owner: string, receipt: ReceiptEnvelope) {
    this.items.set(receipt.payload.id, { owner, receipt });
    if (this.items.size > this.capacity) this.items.delete(this.items.keys().next().value as string);
  }
  /** Only the key that made the request can read its receipt back. */
  get(id: string, owner: string): ReceiptEnvelope | null {
    const hit = this.items.get(id);
    return hit && hit.owner === owner ? hit.receipt : null;
  }
}
