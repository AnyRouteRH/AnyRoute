import { base64ToBytes, bytesToHex, concatBytes, fromUtf8, hexToBytes, utf8 } from "./bytes.js";
import { defaultEd25519Verify, UnsupportedCrypto, type Ed25519Verifier } from "./ed25519.js";
import { keccak256, sha256 } from "./hash.js";
import { keyIdOf, verifyMerkleProof } from "./receipts.js";
import type { Check, JwkKey, KeySet } from "./types.js";

// Receipt v2 (spec/0004-receipts.md Section 4): a COSE_Sign1 (RFC 9052, tag 18) over a deterministic-CBOR claim set,
// signed EdDSA (-8) with the router's Ed25519 receipt key; kid in the protected header is the key id's 8 bytes. The
// checks run in the spec's order: signature, then hashes, then the streamed chain head, then the anchor proof.

export const COSE_ALG_EDDSA = -8;
const te = new TextEncoder();

export type ReceiptClaimsV2 = {
  v: number;
  rid: string;
  iat: number;
  iss?: string;
  model?: { id?: string };
  node?: { provider?: string; quote_ref?: string; policy_hash?: string };
  req?: { h?: string; n_in_bucket?: string };
  resp?: { h?: string; chain?: string; n_out_bucket?: string; finish?: string; stream?: boolean; complete?: boolean };
  lane?: string;
  disclosure?: string;
  policy?: { enforced: boolean; blocked: boolean };
  credit?: { mode?: string; cost_units?: number; keyset?: string };
  [extra: string]: unknown;
};

// ---- minimal CBOR (the subset receipts use) ---------------------------------------------------------------------

type Cbor = number | bigint | string | boolean | null | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { tag: number; value: Cbor };

function decodeCbor(bytes: Uint8Array): Cbor {
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error("cbor: truncated");
  };
  const item = (): Cbor => {
    need(1);
    const b = bytes[at++];
    const major = b >> 5;
    const info = b & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("cbor: unsupported simple value or float");
    }
    let n = BigInt(info);
    if (info >= 24) {
      const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
      if (!len) throw new Error("cbor: indefinite lengths are not allowed");
      need(len);
      n = 0n;
      for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(bytes[at++]);
    }
    const num = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
    switch (major) {
      case 0:
        return num ?? n;
      case 1:
        return num !== null ? -1 - num : -1n - n;
      case 2:
      case 3: {
        const len = Number(n);
        need(len);
        const s = bytes.slice(at, at + len);
        at += len;
        return major === 2 ? s : fromUtf8(s);
      }
      case 4:
        return Array.from({ length: Number(n) }, item);
      case 5: {
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < Number(n); i++) m.set(item(), item());
        return m;
      }
      default:
        return { tag: Number(n), value: item() };
    }
  };
  const v = item();
  if (at !== bytes.length) throw new Error("cbor: trailing bytes");
  return v;
}

const head = (major: number, n: number): Uint8Array =>
  n < 24 ? Uint8Array.of((major << 5) | n) : n < 0x100 ? Uint8Array.of((major << 5) | 24, n) : n < 0x10000 ? Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff) : Uint8Array.of((major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
const bstr = (b: Uint8Array) => concatBytes(head(2, b.length), b);

/** Sig_structure for COSE_Sign1: ["Signature1", protected, external_aad (empty), payload]. */
export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const context = te.encode("Signature1");
  return concatBytes(head(4, 4), head(3, context.length), context, bstr(protectedBytes), bstr(new Uint8Array()), bstr(payload));
}

function toJson(v: Cbor): unknown {
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of v) o[String(k)] = toJson(x);
    return o;
  }
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "bigint") return v.toString();
  return v;
}

export type DecodedReceiptV2 = { alg: number | null; keyId: string; claims: ReceiptClaimsV2; protectedBytes: Uint8Array; payload: Uint8Array; signature: Uint8Array };

/** Parse COSE_Sign1 bytes (or base64) into header, claims and signature. Throws on anything malformed. */
export function decodeReceiptV2(cose: Uint8Array | string): DecodedReceiptV2 {
  const bytes = typeof cose === "string" ? base64ToBytes(cose) : cose;
  let v = decodeCbor(bytes);
  if (v && typeof v === "object" && "tag" in v && !(v instanceof Map) && !(v instanceof Uint8Array) && !Array.isArray(v)) {
    if (v.tag !== 18) throw new Error(`not a COSE_Sign1 (tag ${v.tag})`);
    v = v.value;
  }
  if (!Array.isArray(v) || v.length !== 4) throw new Error("COSE_Sign1 must be an array of four items");
  const [protectedBytes, , payload, signature] = v;
  if (!(protectedBytes instanceof Uint8Array) || !(payload instanceof Uint8Array) || !(signature instanceof Uint8Array)) throw new Error("COSE_Sign1 items have the wrong types");
  const hdr = decodeCbor(protectedBytes);
  if (!(hdr instanceof Map)) throw new Error("protected header is not a map");
  const alg = hdr.get(1);
  const kid = hdr.get(4);
  return { alg: typeof alg === "number" ? alg : null, keyId: kid instanceof Uint8Array ? bytesToHex(kid) : "", claims: toJson(decodeCbor(payload)) as ReceiptClaimsV2, protectedBytes, payload, signature };
}

/** keccak256(keccak256(COSE bytes)): the v2 anchor leaf, 0x-prefixed. */
export const receiptLeafV2 = (cose: Uint8Array): string => "0x" + bytesToHex(keccak256(keccak256(cose)));

// ---- chunk hash chain -------------------------------------------------------------------------------------------

/** c_0 = SHA-256(rid), c_i = SHA-256(c_{i-1} || chunk_i). Returns every c_i in hex and the head ("sha256:<hex>"). */
export async function chunkChain(rid: string, chunks: string[]): Promise<{ steps: string[]; head: string }> {
  let c = await sha256(utf8(rid));
  const steps: string[] = [];
  for (const d of chunks) {
    c = await sha256(concatBytes(c, utf8(d)));
    steps.push(bytesToHex(c));
  }
  return { steps, head: "sha256:" + bytesToHex(c) };
}

/** A streamed event as the client saw it: its data and the chain value that followed it, if any. */
export type ChainedEvent = { data: string; chain?: string };

/**
 * Recompute the chain over what arrived and compare each step with the value the router sent. `firstMismatch` is the
 * 1-based index of the first event whose value is missing or wrong (an altered, dropped or inserted event).
 */
export async function checkChain(rid: string, events: ChainedEvent[]): Promise<{ ok: boolean; head: string; firstMismatch: number | null }> {
  const { steps, head } = await chunkChain(rid, events.map((e) => e.data));
  const bad = events.findIndex((e, i) => e.chain !== steps[i]);
  return { ok: bad < 0, head, firstMismatch: bad < 0 ? null : bad + 1 };
}

// ---- verification -----------------------------------------------------------------------------------------------

export type VerifyReceiptV2Options = {
  keys?: KeySet | JwkKey[];
  publicKeyHex?: string;
  ed25519?: Ed25519Verifier;
  /** Hashes to compare with req.h / resp.h (hex, with or without "sha256:"). */
  requestSha256?: string;
  responseSha256?: string;
  /** The data of every streamed event before the receipt, in order: recomputes the chain head. */
  chunks?: string[];
  /** From GET /api/v1/receipts/:id/proof. */
  proof?: { root: string; proof: string[]; anchored?: boolean } | null;
};

export type ReceiptV2Verification = {
  valid: boolean;
  keyId: string;
  claims: ReceiptClaimsV2 | null;
  leaf: string | null;
  checks: Check[];
  anchor: "proof_valid" | "proof_invalid" | "no_proof";
};

const pass = (id: string, detail: string): Check => ({ id, status: "pass", detail });
const fail = (id: string, detail: string): Check => ({ id, status: "fail", detail });
const skip = (id: string, detail: string): Check => ({ id, status: "not_checked", detail });
const bare = (h: string | undefined) => String(h ?? "").replace(/^sha256:/, "").toLowerCase();

export async function verifyReceiptV2(cose: Uint8Array | string, opts: VerifyReceiptV2Options = {}): Promise<ReceiptV2Verification> {
  const checks: Check[] = [];
  let d: DecodedReceiptV2;
  let bytes: Uint8Array;
  try {
    bytes = typeof cose === "string" ? base64ToBytes(cose) : cose;
    d = decodeReceiptV2(bytes);
  } catch (e) {
    return { valid: false, keyId: "", claims: null, leaf: null, checks: [fail("shape", `Not a COSE_Sign1 receipt: ${(e as Error).message}`)], anchor: "no_proof" };
  }
  const done = (anchor: ReceiptV2Verification["anchor"]): ReceiptV2Verification => ({
    valid: checks.every((c) => c.status !== "fail") && checks.some((c) => c.id === "signature" && c.status === "pass"),
    keyId: d.keyId,
    claims: d.claims,
    leaf: receiptLeafV2(bytes),
    checks,
    anchor,
  });
  checks.push(d.alg === COSE_ALG_EDDSA ? pass("alg", "EdDSA (COSE -8)") : fail("alg", `unsupported COSE algorithm ${String(d.alg)}`));
  checks.push(d.claims?.v === 2 && typeof d.claims.rid === "string" ? pass("claims", `v2 claims for ${d.claims.rid}`) : fail("claims", "The payload is not a v2 claim set."));

  // 1. Signature under the named key.
  let raw: Uint8Array | null = null;
  if (opts.publicKeyHex) {
    try {
      raw = hexToBytes(opts.publicKeyHex);
    } catch {
      raw = null;
    }
  } else {
    const list = Array.isArray(opts.keys) ? opts.keys : opts.keys?.keys ?? [];
    const jwk = list.find((k) => k.kid === d.keyId);
    if (jwk && jwk.kty === "OKP" && jwk.crv === "Ed25519") raw = base64ToBytes(jwk.x);
  }
  if (!raw || raw.length !== 32) checks.push(fail("key", `Key ${d.keyId || "(none)"} is not available.`));
  else {
    const derived = await keyIdOf(raw);
    checks.push(derived === d.keyId ? pass("key", `kid ${d.keyId} matches the key bytes`) : fail("key", `kid ${d.keyId} is not the key's id (${derived})`));
  }
  if (raw && raw.length === 32 && !checks.some((c) => c.id === "key" && c.status === "fail")) {
    try {
      const ok = await (opts.ed25519 ?? defaultEd25519Verify)(raw, sigStructure(d.protectedBytes, d.payload), d.signature);
      checks.push(ok ? pass("signature", "COSE_Sign1 signature verifies") : fail("signature", "The COSE signature does not verify for these claims and key."));
    } catch (e) {
      checks.push(e instanceof UnsupportedCrypto ? skip("signature", `This runtime cannot verify Ed25519: ${e.message}`) : fail("signature", (e as Error).message));
    }
  } else checks.push(fail("signature", "Not verified: no usable key."));

  // 2. Hashes.
  if (opts.requestSha256 != null || opts.responseSha256 != null) {
    const reqOk = opts.requestSha256 == null || bare(opts.requestSha256) === bare(d.claims.req?.h);
    const respOk = opts.responseSha256 == null || bare(opts.responseSha256) === bare(d.claims.resp?.h);
    checks.push(reqOk && respOk ? pass("hashes", "req.h and resp.h match what you hold") : fail("hashes", `${reqOk ? "" : "req.h "}${respOk ? "" : "resp.h "}does not match`.trim()));
  } else checks.push(skip("hashes", "No request or response hash supplied."));

  // 3. Chain head over the streamed events.
  if (opts.chunks) {
    const { head } = await chunkChain(d.claims.rid, opts.chunks);
    if (!d.claims.resp?.chain) checks.push(fail("chain", "The receipt carries no chain head, but stream events were supplied."));
    else checks.push(head === d.claims.resp.chain ? pass("chain", `chain head over ${opts.chunks.length} events matches`) : fail("chain", "The chain head does not match the events received: the stream was cut or altered."));
  } else checks.push(skip("chain", d.claims.resp?.chain ? "Supply the streamed events to check the chain head." : "Not a streamed response."));

  // 4. Anchor proof.
  let anchor: ReceiptV2Verification["anchor"] = "no_proof";
  if (opts.proof && Array.isArray(opts.proof.proof) && typeof opts.proof.root === "string") {
    const ok = verifyMerkleProof(receiptLeafV2(bytes), opts.proof.proof, opts.proof.root);
    anchor = ok ? "proof_valid" : "proof_invalid";
    checks.push(ok ? pass("anchor_proof", `leaf is under root ${opts.proof.root.slice(0, 10)}…${opts.proof.anchored ? "" : " (root kept off chain)"}`) : fail("anchor_proof", "The Merkle path does not lead from this receipt to the root."));
  } else checks.push(skip("anchor_proof", "No proof supplied (roots are built hourly)."));
  return done(anchor);
}
