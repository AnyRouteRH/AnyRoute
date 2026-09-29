import { createHash, timingSafeEqual } from "node:crypto";
import { NK, TOKEN_TYPE } from "./rsa.ts";

// Wire formats for Privacy Pass token type 0x0002 (RFC 9578) and the PrivateToken HTTP scheme (RFC 9577).

export const DENOMINATIONS = [1_000, 10_000, 100_000] as const;
export type Denomination = (typeof DENOMINATIONS)[number];

export const NONCE_LEN = 32;
export const DIGEST_LEN = 32;
export const KEY_ID_LEN = 32;
/** token_type (2) + nonce (32) + challenge_digest (32) + token_key_id (32) + authenticator (Nk). */
export const TOKEN_LEN = 2 + NONCE_LEN + DIGEST_LEN + KEY_ID_LEN + NK;
const INPUT_LEN = TOKEN_LEN - NK;

const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
export const sha256Bytes = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** Decode base64url (or standard base64), refusing anything else. Returns null on malformed input. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length || text === "" ? new Uint8Array(bytes) : null;
}

/**
 * The TokenChallenge (RFC 9577 section 2.1) this router issues for: no per-request context, bound to the
 * router's host as both issuer and origin. Tokens are single use, so the challenge does not need to be fresh.
 */
export function tokenChallenge(issuerName: string, originInfo = issuerName): Uint8Array {
  const issuer = Buffer.from(issuerName, "utf8");
  const origin = Buffer.from(originInfo, "utf8");
  if (!issuer.length || issuer.length > 0xffff || origin.length > 0xffff) throw new Error("invalid issuer name");
  return Buffer.concat([u16(TOKEN_TYPE), u16(issuer.length), issuer, Uint8Array.of(0), u16(origin.length), origin]);
}

export const challengeDigest = (challenge: Uint8Array) => sha256Bytes(challenge);

/** token_input = concat(0x0002, nonce, challenge_digest, token_key_id): the message that gets blind-signed. */
export function tokenInput(nonce: Uint8Array, digest: Uint8Array, keyId: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_LEN || digest.length !== DIGEST_LEN || keyId.length !== KEY_ID_LEN) throw new Error("invalid token input");
  return Buffer.concat([u16(TOKEN_TYPE), nonce, digest, keyId]);
}

export type Token = { nonce: Uint8Array; challengeDigest: Uint8Array; keyId: Uint8Array; authenticator: Uint8Array };

export function encodeToken(t: Token): Uint8Array {
  if (t.authenticator.length !== NK) throw new Error("invalid authenticator");
  return Buffer.concat([tokenInput(t.nonce, t.challengeDigest, t.keyId), t.authenticator]);
}

/** Strict decode: exact length and token type, no trailing bytes. */
export function decodeToken(bytes: Uint8Array): Token | null {
  if (bytes.length !== TOKEN_LEN || ((bytes[0] << 8) | bytes[1]) !== TOKEN_TYPE) return null;
  let at = 2;
  const take = (n: number) => bytes.subarray(at, (at += n));
  return { nonce: take(NONCE_LEN), challengeDigest: take(DIGEST_LEN), keyId: take(KEY_ID_LEN), authenticator: take(NK) };
}

/** The signed part of a token (everything but the authenticator). */
export const signedPart = (bytes: Uint8Array) => bytes.subarray(0, INPUT_LEN);

/** Nullifier: SHA-256 of the whole token, hex. A token can be spent once; this is what is remembered. */
export const nullifierOf = (tokenBytes: Uint8Array) => hex(sha256Bytes(tokenBytes));

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

/** `Authorization: PrivateToken token=<base64url>` (the value may be quoted). */
export const authorizationHeader = (tokenBytes: Uint8Array) => `PrivateToken token=${b64url(tokenBytes)}`;

/**
 * Parse an Authorization header. Returns undefined when it is not the PrivateToken scheme at all, and
 * null when it is but the token parameter is malformed.
 */
export function parsePrivateToken(header: string | undefined | null): Uint8Array | null | undefined {
  if (!header) return undefined;
  const scheme = /^\s*PrivateToken(?:\s+(.*))?$/i.exec(header);
  if (!scheme) return undefined;
  const m = /(?:^|[\s,])token="?([A-Za-z0-9_+/=-]+)"?\s*(?:,|$)/i.exec(scheme[1] ?? "");
  return m ? decodeBase64(m[1]) : null;
}
