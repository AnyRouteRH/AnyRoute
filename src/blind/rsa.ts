import { createHash, constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, type KeyObject } from "node:crypto";
import { RSABSSA, type BlindRSA } from "@cloudflare/blindrsa-ts";

// Blind RSA primitives for Privacy Pass token type 0x0002 (RFC 9578) built on RSABSSA (RFC 9474).
//
// Division of labour:
//  - Client side (blind, finalize) and verification go through @cloudflare/blindrsa-ts, so anyone can
//    reproduce them with the same library. The suite is RSABSSA-SHA384-PSS-Deterministic, the variant
//    RFC 9578 fixes for this token type (2048-bit modulus, SHA-384, MGF1-SHA-384, 48-byte salt).
//  - The issuer's private-key operation (RSASP1) runs on the platform's native RSA (node:crypto with
//    no padding), not on the library's JavaScript big-number code: about 0.6 ms instead of 300 ms per
//    signature, and it keeps the private exponent out of a non-constant-time implementation. It is
//    the same function RFC 9474 section 4.3 defines, including the verify-after-sign fault check, and
//    the test suite checks it against the library and the RFC vectors.

export const TOKEN_TYPE = 0x0002;
/** Modulus and signature length in bytes (Nk) for the 2048-bit token type. */
export const NK = 256;
export const MODULUS_BITS = 2048;
export const SALT_LENGTH = 48;

export const suite = (): BlindRSA => RSABSSA.SHA384.PSS.Deterministic();

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

// ---- minimal DER ---------------------------------------------------------------------------------

function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts);
const tlv = (tag: number, body: Uint8Array) => cat(Uint8Array.of(tag), derLength(body.length), body);
const derInteger = (unsigned: Uint8Array) => {
  let i = 0;
  while (i < unsigned.length - 1 && unsigned[i] === 0) i++;
  const v = unsigned.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? cat(Uint8Array.of(0), v) : v);
};

function readTlv(buf: Uint8Array, at: number): { tag: number; body: Uint8Array; end: number } {
  if (at + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[at];
  let len = buf[at + 1];
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + n > buf.length) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length) throw new Error("truncated DER");
  return { tag, body: buf.subarray(p, p + len), end: p + len };
}

/**
 * AlgorithmIdentifier RFC 9578 section 6.5 requires in the SPKI: id-RSASSA-PSS with
 * RSASSA-PSS-params { hashAlgorithm sha384, maskGenAlgorithm mgf1(sha384), saltLength 48 }.
 */
const PSS_ALGORITHM_IDENTIFIER = Buffer.from(
  "303d06092a864886f70d01010a3030a00d300b06096086480165030402" + "02a11a301806092a864886f70d010108300b06096086480165030402" + "02a203020130",
  "hex",
);

/** The SubjectPublicKeyInfo RFC 9578 defines for an issuer key: RSASSA-PSS OID plus SHA-384 PSS parameters. */
export function issuerSpki(n: Uint8Array, e: Uint8Array): Uint8Array {
  const rsaPublicKey = tlv(0x30, cat(derInteger(n), derInteger(e)));
  const bitString = tlv(0x03, cat(Uint8Array.of(0), rsaPublicKey));
  return tlv(0x30, cat(PSS_ALGORITHM_IDENTIFIER, bitString));
}

/** Inverse of issuerSpki. Rejects any SPKI that is not exactly the RFC 9578 shape for a 2048-bit key. */
export function parseIssuerSpki(spki: Uint8Array): { n: Uint8Array; e: Uint8Array } {
  const outer = readTlv(spki, 0);
  if (outer.tag !== 0x30 || outer.end !== spki.length) throw new Error("invalid SPKI");
  const body = outer.body;
  if (body.length < PSS_ALGORITHM_IDENTIFIER.length || Buffer.compare(body.subarray(0, PSS_ALGORITHM_IDENTIFIER.length), PSS_ALGORITHM_IDENTIFIER) !== 0)
    throw new Error("SPKI is not RSASSA-PSS with SHA-384, MGF1-SHA-384 and a 48-byte salt");
  const bits = readTlv(body, PSS_ALGORITHM_IDENTIFIER.length);
  if (bits.tag !== 0x03 || bits.end !== body.length || bits.body[0] !== 0) throw new Error("invalid SPKI bit string");
  const seq = readTlv(bits.body, 1);
  if (seq.tag !== 0x30 || seq.end !== bits.body.length) throw new Error("invalid RSAPublicKey");
  const nInt = readTlv(seq.body, 0);
  const eInt = readTlv(seq.body, nInt.end);
  if (nInt.tag !== 0x02 || eInt.tag !== 0x02 || eInt.end !== seq.body.length) throw new Error("invalid RSAPublicKey");
  const strip = (b: Uint8Array) => (b.length > 1 && b[0] === 0 ? b.subarray(1) : b);
  const n = strip(nInt.body);
  const e = strip(eInt.body);
  if (n.length !== NK) throw new Error(`modulus must be ${MODULUS_BITS} bits`);
  return { n, e };
}

/** token_key_id: SHA-256 of the issuer SPKI (RFC 9578 section 6.5), as lowercase hex. */
export const tokenKeyId = (spki: Uint8Array) => createHash("sha256").update(spki).digest("hex");

// ---- issuer keys ---------------------------------------------------------------------------------

export type IssuerKeyMaterial = { spki: Uint8Array; pkcs8: Uint8Array; keyId: string };

/** A fresh 2048-bit issuer key: the RFC 9578 SPKI (public) and the PKCS#8 private key. */
export async function generateIssuerKey(): Promise<IssuerKeyMaterial> {
  const pair = await suite().generateKey({ modulusLength: MODULUS_BITS, publicExponent: Uint8Array.of(1, 0, 1) });
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const spki = issuerSpki(Buffer.from(jwk.n!, "base64url"), Buffer.from(jwk.e!, "base64url"));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { spki, pkcs8, keyId: tokenKeyId(spki) };
}

/** Public key for the library's verify/blind/finalize, from an RFC 9578 SPKI. */
export async function importIssuerPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  const { n, e } = parseIssuerSpki(spki);
  return crypto.subtle.importKey("jwk", { kty: "RSA", n: b64u(n), e: b64u(e), alg: "PS384", ext: true }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
}

/** Native RSA private-key operation for one issuer key. */
export class Signer {
  private readonly key: KeyObject;
  private readonly pub: KeyObject;
  private readonly modulus: bigint;
  private readonly size: number;
  /** `bits` is the expected modulus size; issuer keys are always MODULUS_BITS, the RFC 9474 vectors use 4096. */
  constructor(pkcs8: Uint8Array, bits = MODULUS_BITS) {
    this.key = createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
    this.pub = createPublicKey(this.key);
    const jwk = this.pub.export({ format: "jwk" });
    this.modulus = BigInt("0x" + Buffer.from(jwk.n!, "base64url").toString("hex"));
    if (this.pub.asymmetricKeyDetails?.modulusLength !== bits) throw new Error(`issuer key must be ${bits}-bit RSA`);
    this.size = bits / 8;
  }
  /** The RFC 9578 SPKI of this key's public half. */
  get spki(): Uint8Array {
    const jwk = this.pub.export({ format: "jwk" });
    return issuerSpki(Buffer.from(jwk.n!, "base64url"), Buffer.from(jwk.e!, "base64url"));
  }
  /**
   * RFC 9474 BlindSign: s = blinded_msg^d mod n, then check s^e mod n == blinded_msg before releasing it.
   * The input must be exactly the modulus length in bytes and, as an integer, below the modulus.
   */
  blindSign(blindedMsg: Uint8Array): Uint8Array {
    if (blindedMsg.length !== this.size) throw new Error("unexpected input size");
    if (BigInt("0x" + Buffer.from(blindedMsg).toString("hex")) >= this.modulus) throw new Error("blinded message is not below the modulus");
    const s = privateDecrypt({ key: this.key, padding: constants.RSA_NO_PADDING }, blindedMsg);
    const check = publicEncrypt({ key: this.pub, padding: constants.RSA_NO_PADDING }, s);
    if (Buffer.compare(check, blindedMsg) !== 0) throw new Error("signing failure");
    return new Uint8Array(s);
  }
}

/** True when the bytes are a valid blinded message for this public key: Nk bytes, integer below n. */
export function isValidBlindedMsg(blindedMsg: Uint8Array, n: Uint8Array): boolean {
  return blindedMsg.length === NK && Buffer.compare(blindedMsg, n) < 0;
}
