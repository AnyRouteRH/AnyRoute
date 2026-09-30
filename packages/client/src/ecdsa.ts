import { base64ToBytes } from "./bytes.js";
import { UnsupportedCrypto } from "./ed25519.js";

// ECDSA P-256 with SHA-256, as Sigstore Rekor signs its checkpoints and signed entry timestamps and as the Anyroute log's
// anchoring key signs its Rekor entries. Signatures arrive DER-encoded (X9.62, as OpenSSL writes them); WebCrypto wants
// the fixed-size r || s form, so they are converted first.

/** Returns true when the DER signature is valid for the message under the key (a SubjectPublicKeyInfo). */
export type P256Verifier = (spki: Uint8Array, message: Uint8Array, derSignature: Uint8Array) => Promise<boolean>;

const asBuffer = (b: Uint8Array) => b as unknown as BufferSource;

/** A public key from PEM ("-----BEGIN PUBLIC KEY-----", real or \n-escaped newlines) or base64 SPKI, as DER bytes. */
export function spkiFromText(text: string): Uint8Array {
  const src = text.replace(/\\n/g, "\n").trim();
  if (/PRIVATE KEY/.test(src)) throw new Error("a private key was given; only the public key belongs here");
  const m = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(src);
  const b64 = (m ? m[1] : src).replace(/\s+/g, "");
  if (!b64) throw new Error("no public key");
  const der = base64ToBytes(b64);
  if (der.length < 60 || der[0] !== 0x30) throw new Error("not a SubjectPublicKeyInfo");
  return der;
}

/** DER SEQUENCE { INTEGER r, INTEGER s } to 64 bytes r || s; null when it is not one. */
export function derSignatureToRaw(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(64);
  let i = 2;
  for (let k = 0; k < 2; k++) {
    if (der[i] !== 0x02) return null;
    const n = der[i + 1];
    i += 2;
    if (n < 1 || n > 33 || i + n > der.length) return null;
    let v = der.subarray(i, i + n);
    i += n;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    out.set(v, k * 32 + 32 - v.length);
  }
  return i === der.length ? out : null;
}

/** ECDSA P-256 / SHA-256 through WebCrypto (Node 20+, Bun, current browsers). */
export const defaultP256Verify: P256Verifier = async (spki, message, derSignature) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UnsupportedCrypto("WebCrypto is not available");
  const raw = derSignatureToRaw(derSignature);
  if (!raw) return false;
  let key: CryptoKey;
  try {
    key = await subtle.importKey("spki", asBuffer(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return false;
  }
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, asBuffer(raw), asBuffer(message));
};
