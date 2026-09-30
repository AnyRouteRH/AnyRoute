import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

// WebAuthn (passkeys) for organisation members: registration and assertion checks with no third-party library.
// The router asks for attestation "none": it stores only the credential's public key, never a device certificate, so a
// passkey says nothing about who or what made it. Supported keys: ES256 (-7, P-256), EdDSA (-8, Ed25519), RS256 (-257).

export const COSE_ALGS = [-7, -8, -257] as const;
export type WebAuthnPolicy = { rpId: string; origins: string[]; challenge: string };

const b64u = (s: string, what: string) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new WebAuthnError(`${what} must be base64url.`);
  return Buffer.from(s.replace(/=+$/, ""), "base64url");
};
export const toB64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class WebAuthnError extends Error {}

// A small, lenient CBOR reader: authenticators do not all encode canonically, and a credential public key in authData
// may be followed by extension data, so this returns how many bytes the first item used.
type Cbor = number | bigint | string | boolean | null | undefined | Buffer | Cbor[] | Map<Cbor, Cbor>;
export function readCbor(buf: Buffer, start = 0): [Cbor, number] {
  let at = start;
  const need = (n: number) => {
    if (at + n > buf.length) throw new WebAuthnError("CBOR data is truncated.");
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new WebAuthnError("CBOR data is nested too deeply.");
    need(1);
    const b = buf[at++];
    const major = b >> 5;
    const info = b & 0x1f;
    let n: bigint;
    if (info < 24) n = BigInt(info);
    else if (info <= 27) {
      const len = 1 << (info - 24);
      need(len);
      n = 0n;
      for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(buf[at++]);
    } else throw new WebAuthnError("CBOR indefinite lengths are not supported.");
    const num = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
    switch (major) {
      case 0:
        return num(n);
      case 1:
        return typeof num(n) === "number" ? -1 - Number(n) : -1n - n;
      case 2:
      case 3: {
        const len = Number(n);
        need(len);
        const bytes = buf.subarray(at, at + len);
        at += len;
        return major === 2 ? Buffer.from(bytes) : bytes.toString("utf8");
      }
      case 4:
        if (n > 1024n) throw new WebAuthnError("CBOR array is too long.");
        return Array.from({ length: Number(n) }, () => item(depth + 1));
      case 5: {
        if (n > 1024n) throw new WebAuthnError("CBOR map is too long.");
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < Number(n); i++) {
          const k = item(depth + 1);
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 6:
        return item(depth + 1); // tags carry no meaning here
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new WebAuthnError("CBOR floats are not expected here.");
    }
  };
  const v = item(0);
  return [v, at - start];
}

type ClientData = { type: string; challenge: string; origin: string };
function checkClientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", p: WebAuthnPolicy): ClientData {
  let cd: ClientData;
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON.");
  }
  if (cd?.type !== type) throw new WebAuthnError(`clientDataJSON.type must be ${type}.`);
  if (typeof cd.challenge !== "string" || cd.challenge.replace(/=+$/, "") !== p.challenge) throw new WebAuthnError("The challenge does not match.");
  if (!p.origins.includes(cd.origin)) throw new WebAuthnError(`Origin ${String(cd.origin).slice(0, 100)} is not allowed.`);
  return cd;
}

type AuthData = { rpIdHash: Buffer; flags: number; signCount: number; credentialId?: Buffer; cosePublicKey?: Buffer };
export function parseAuthData(a: Buffer): AuthData {
  if (a.length < 37) throw new WebAuthnError("authenticatorData is too short.");
  const out: AuthData = { rpIdHash: a.subarray(0, 32), flags: a[32], signCount: a.readUInt32BE(33) };
  if (out.flags & 0x40) {
    if (a.length < 55) throw new WebAuthnError("Attested credential data is truncated.");
    const len = a.readUInt16BE(53);
    if (len < 16 || len > 1023 || a.length < 55 + len + 1) throw new WebAuthnError("The credential id is out of range.");
    out.credentialId = a.subarray(55, 55 + len);
    const [, used] = readCbor(a, 55 + len);
    out.cosePublicKey = a.subarray(55 + len, 55 + len + used);
  }
  return out;
}

function checkAuthData(ad: AuthData, p: WebAuthnPolicy) {
  if (!ad.rpIdHash.equals(sha256(p.rpId))) throw new WebAuthnError("The authenticator signed for a different relying party.");
  if (!(ad.flags & 0x01)) throw new WebAuthnError("The user was not present (UP flag).");
}

/** A COSE_Key (RFC 9053) as a Node public key, with its algorithm. */
export function coseToKey(cose: Buffer): { alg: number; key: KeyObject } {
  const [m] = readCbor(cose);
  if (!(m instanceof Map)) throw new WebAuthnError("The credential public key is not a COSE key.");
  const kty = m.get(1);
  const alg = m.get(3);
  const bytes = (label: number) => {
    const v = m.get(label);
    if (!Buffer.isBuffer(v)) throw new WebAuthnError(`COSE key parameter ${label} is missing.`);
    return toB64u(v);
  };
  if (alg === -7 && kty === 2 && m.get(-1) === 1) return { alg, key: createPublicKey({ key: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, format: "jwk" }) };
  if (alg === -8 && kty === 1 && m.get(-1) === 6) return { alg, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes(-2) }, format: "jwk" }) };
  if (alg === -257 && kty === 3) return { alg, key: createPublicKey({ key: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, format: "jwk" }) };
  throw new WebAuthnError("Unsupported passkey algorithm: use ES256, EdDSA or RS256.");
}

function verifySig(alg: number, key: KeyObject, data: Buffer, sig: Buffer) {
  try {
    if (alg === -7) return verify("sha256", data, { key, dsaEncoding: "der" }, sig);
    if (alg === -8) return verify(null, data, key, sig);
    if (alg === -257) return verify("sha256", data, key, sig);
  } catch {
    return false;
  }
  return false;
}

export type Registration = { clientDataJSON: string; attestationObject: string };
export type RegisteredCredential = { credentialId: string; publicKey: string; alg: number; signCount: number; userVerified: boolean };

/** Check a navigator.credentials.create() response. Attestation statements are not checked (conveyance "none"). */
export function verifyRegistration(r: Registration, p: WebAuthnPolicy): RegisteredCredential {
  checkClientData(b64u(r.clientDataJSON, "clientDataJSON"), "webauthn.create", p);
  const [att] = readCbor(b64u(r.attestationObject, "attestationObject"));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get("authData"))) throw new WebAuthnError("attestationObject has no authData.");
  const ad = parseAuthData(att.get("authData") as Buffer);
  checkAuthData(ad, p);
  if (!ad.credentialId || !ad.cosePublicKey) throw new WebAuthnError("authData carries no credential (AT flag).");
  const { alg } = coseToKey(ad.cosePublicKey);
  return { credentialId: toB64u(ad.credentialId), publicKey: toB64u(ad.cosePublicKey), alg, signCount: ad.signCount, userVerified: !!(ad.flags & 0x04) };
}

export type Assertion = { clientDataJSON: string; authenticatorData: string; signature: string };

/** Check a navigator.credentials.get() response against a stored credential. Returns the new signature counter. */
export function verifyAssertion(a: Assertion, p: WebAuthnPolicy, stored: { publicKey: string; alg: number; signCount: number }): { signCount: number } {
  const clientData = b64u(a.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, "webauthn.get", p);
  const authData = b64u(a.authenticatorData, "authenticatorData");
  const ad = parseAuthData(authData);
  checkAuthData(ad, p);
  const { alg, key } = coseToKey(b64u(stored.publicKey, "publicKey"));
  if (alg !== stored.alg) throw new WebAuthnError("The stored key's algorithm changed.");
  if (!verifySig(alg, key, Buffer.concat([authData, sha256(clientData)]), b64u(a.signature, "signature"))) throw new WebAuthnError("The passkey signature is not valid.");
  // A counter that does not move forward (when either side uses one) points at a cloned authenticator.
  if ((ad.signCount !== 0 || stored.signCount !== 0) && ad.signCount <= stored.signCount) throw new WebAuthnError("The signature counter did not increase; the passkey may be cloned.");
  return { signCount: ad.signCount };
}
