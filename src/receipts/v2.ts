import type { RouteExplanation } from "../router/explain.ts"; // V84
import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { CborTag, cborDecode, cborEncode, cborToJson, type CborValue } from "./cbor.ts";

// Receipt v2 (spec/0004-receipts.md Section 4): a COSE_Sign1 (RFC 9052) over a deterministic-CBOR claim set, signed
// with the router's Ed25519 receipt key (alg EdDSA, -8). The claims carry hashes, buckets and amounts only: no payer,
// address, IP or content. Exact token counts stay in the account-only generation record.

export const COSE_ALG_EDDSA = -8;
export const COSE_SIGN1_TAG = 18;
export const COSE_CONTENT_TYPE = 'application/cose; cose-type="cose-sign1"';
const HDR_ALG = 1;
const HDR_KID = 4;

export type ClaimsV2 = {
  route?: RouteExplanation; // V84: versioned additive claim.
  v: 2;
  rid: string;
  iat: number;
  iss: string;
  model: { id: string };
  node: { provider: string; quote_ref?: string; policy_hash?: string };
  req: { h: string; n_in_bucket: string };
  resp: { h: string; chain?: string; n_out_bucket: string; finish?: string; stream: boolean; complete: boolean };
  lane: string;
  disclosure: string;
  policy?: { enforced: boolean; blocked: boolean };
  credit: { mode: string; cost_units: number; keyset?: string };
};

// ---- token buckets ----------------------------------------------------------------------------------------------

/** Power-of-two bucket: "0", then "lo-hi" with lo = 2^floor(log2 n) and hi = 2*lo (lo inclusive, hi exclusive). */
export function tokenBucket(n: number): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v === 0) return "0";
  let lo = 1;
  while (lo * 2 <= v) lo *= 2;
  return `${lo}-${lo * 2}`;
}

// ---- chunk hash chain -------------------------------------------------------------------------------------------

const sha = (...parts: (Uint8Array | string)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/** c_0 = SHA-256(UTF-8(rid)); c_i = SHA-256(c_{i-1} || UTF-8(chunk_i)); chunk_i is the i-th event's data value. */
export class ChunkChain {
  private c: Uint8Array;
  count = 0;
  constructor(rid: string) {
    this.c = sha(rid);
  }
  push(chunk: string): string {
    this.c = sha(this.c, chunk);
    this.count++;
    return this.hex;
  }
  get hex() {
    return Buffer.from(this.c).toString("hex");
  }
  /** The value receipts carry as resp.chain. */
  get head() {
    return `sha256:${this.hex}`;
  }
}

/** Every c_i for a list of chunks (c_1..c_n), and the head. */
export function chainOf(rid: string, chunks: string[]): { steps: string[]; head: string } {
  const ch = new ChunkChain(rid);
  const steps = chunks.map((d) => ch.push(d));
  return { steps, head: ch.head };
}

/** The SSE comment line that carries c_i right after the i-th chained event. */
export const chainComment = (i: number, hex: string) => `: anyroute-chain ${i} ${hex}\n\n`;
export const CHAIN_COMMENT = /^: anyroute-chain (\d+) ([0-9a-f]{64})$/;

// ---- COSE_Sign1 -------------------------------------------------------------------------------------------------

export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array, externalAad: Uint8Array = new Uint8Array()): Uint8Array {
  return cborEncode(["Signature1", protectedBytes, externalAad, payload]);
}

/** COSE_Sign1 (tag 18) with alg EdDSA and kid in the protected header and an empty unprotected header. */
export function coseSign1(payload: Uint8Array, kid: Uint8Array, sign: (toBeSigned: Uint8Array) => Uint8Array): Uint8Array {
  const protectedBytes = cborEncode(new Map<CborValue, CborValue>([[HDR_ALG, COSE_ALG_EDDSA], [HDR_KID, kid]]));
  const signature = sign(sigStructure(protectedBytes, payload));
  return cborEncode(new CborTag(COSE_SIGN1_TAG, [protectedBytes, new Map(), payload, signature]));
}

export type DecodedCose = { protectedBytes: Uint8Array; alg: number | null; kid: Uint8Array | null; payload: Uint8Array; signature: Uint8Array; toBeSigned: Uint8Array };

export function decodeCoseSign1(bytes: Uint8Array): DecodedCose {
  let v = cborDecode(bytes);
  if (v instanceof CborTag) {
    if (v.tag !== COSE_SIGN1_TAG) throw new Error(`not a COSE_Sign1 (tag ${v.tag})`);
    v = v.value;
  }
  if (!Array.isArray(v) || v.length !== 4) throw new Error("COSE_Sign1 must be an array of four items");
  const [protectedBytes, , payload, signature] = v;
  if (!(protectedBytes instanceof Uint8Array) || !(payload instanceof Uint8Array) || !(signature instanceof Uint8Array)) throw new Error("COSE_Sign1 items have the wrong types");
  const hdr = protectedBytes.length ? cborDecode(protectedBytes) : new Map();
  if (!(hdr instanceof Map)) throw new Error("protected header is not a map");
  const alg = hdr.get(HDR_ALG);
  const kid = hdr.get(HDR_KID);
  return {
    protectedBytes,
    alg: typeof alg === "number" ? alg : null,
    kid: kid instanceof Uint8Array ? kid : null,
    payload,
    signature,
    toBeSigned: sigStructure(protectedBytes, payload),
  };
}

// ---- claims -----------------------------------------------------------------------------------------------------

export const encodeClaims = (claims: ClaimsV2) => cborEncode(claims as unknown as CborValue);
export const decodeClaims = (payload: Uint8Array) => cborToJson(cborDecode(payload)) as ClaimsV2;

/** Anchor leaf of a v2 receipt: keccak256(keccak256(COSE_Sign1 bytes)), same double hash as v1. */
export const receiptLeafV2 = (cose: Uint8Array): Hex => keccak256(keccak256(cose));

/** The claims the router signs for one settled generation. Nothing here names a payer, an address or content. */
export function buildClaimsV2(i: {
  route?: RouteExplanation; // V84
  rid: string;
  issuedAt: Date;
  router: string;
  modelId: string;
  providerId: string;
  attestation: string | null;
  policyHash: string | null;
  requestSha256: string;
  responseSha256: string;
  chainHead?: string | null;
  tokensIn: number;
  tokensOut: number;
  finish: string | null;
  stream: boolean;
  complete: boolean;
  lane: string;
  disclosure: string;
  mode: string;
  chargedPico: bigint;
  keyset?: string | null;
}): ClaimsV2 {
  const node: ClaimsV2["node"] = { provider: i.providerId };
  if (i.attestation) node.quote_ref = `sha256:${i.attestation.replace(/^(sha256:|0x)/, "")}`;
  if (i.policyHash) node.policy_hash = i.policyHash.startsWith("sha256:") ? i.policyHash : `sha256:${i.policyHash.replace(/^0x/, "")}`;
  const resp: ClaimsV2["resp"] = { h: `sha256:${i.responseSha256}`, n_out_bucket: tokenBucket(i.tokensOut), stream: i.stream, complete: i.complete };
  if (i.chainHead) resp.chain = i.chainHead;
  if (i.finish) resp.finish = i.finish;
  const credit: ClaimsV2["credit"] = { mode: i.mode, cost_units: Number((i.chargedPico + 999_999n) / 1_000_000n) };
  if (i.keyset) credit.keyset = i.keyset;
  return {
    ...(i.route ? { route: i.route } : {}), // V84: omit entirely when disabled.
    v: 2,
    rid: i.rid,
    iat: Math.floor(i.issuedAt.getTime() / 1000),
    iss: i.router,
    model: { id: i.modelId },
    node,
    req: { h: `sha256:${i.requestSha256}`, n_in_bucket: tokenBucket(i.tokensIn) },
    resp,
    lane: i.lane,
    disclosure: i.disclosure,
    // Known only when the serving endpoint's fresh attestation bound a classifier policy.
    ...(i.policyHash ? { policy: { enforced: true, blocked: i.finish === "content_filter" } } : {}),
    credit,
  };
}
