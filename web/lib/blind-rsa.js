// Blind RSA in the browser: RFC 9474 (RSABSSA-SHA384-PSS-Deterministic) for Privacy Pass token type 0x0002 (RFC 9578).
// This is the client half of the router's src/blind and of packages/client/src/blind.ts, written against WebCrypto and
// BigInt so the page needs no library. The router signs blinded messages; this file blinds a token, and turns the
// router's signature into a finished token that verifies as an ordinary RSA-PSS signature.
//
//   blind:    encoded = EMSA-PSS(msg); m = OS2IP(encoded); z = m * r^e mod n     (r is a fresh random blinding factor)
//   finalize: s = blind_sig * r^-1 mod n; the token is valid only if s verifies as RSA-PSS over msg
//
// The router never sees msg, r or s. Everything secret here (msg, r, inv) stays in this tab.

export const TOKEN_TYPE = 0x0002;
export const NK = 256; // modulus and signature length in bytes for the 2048-bit token type
export const TOKEN_LEN = 2 + 32 + 32 + 32 + NK; // token_type, nonce, challenge_digest, token_key_id, authenticator
const NONCE_LEN = 32;
const DIGEST_LEN = 32;
const KEY_ID_LEN = 32;
const H_LEN = 48; // SHA-384
const S_LEN = 48; // PSS salt length fixed by the suite

// ---- bytes -------------------------------------------------------------------------------------------------------

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(hex) {
  const s = String(hex).replace(/^0x/i, "");
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(b) {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Standard base64 or base64url, padded or not. Throws on anything else. */
export function fromBase64(text) {
  const t = String(text).trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t)) throw new Error("invalid base64");
  const std = t.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const os2ip = (b) => (b.length ? BigInt("0x" + toHex(b)) : 0n);
function i2osp(x, len) {
  if (x < 0n || x >= 1n << BigInt(8 * len)) throw new Error("integer too large");
  return fromHex(x.toString(16).padStart(len * 2, "0"));
}
const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const u32 = (n) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** Fill a buffer with random bytes. The tests replace this to reproduce the RFC's vectors. */
export const systemRandom = (buf) => crypto.getRandomValues(buf);

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
const sha384 = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-384", concat(...parts)));

// ---- big numbers ------------------------------------------------------------------------------------------------

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
  }
  return result;
}

/** a^-1 mod m, or null when a and m are not coprime. */
function modInverse(a, m) {
  let [r0, r1, s0, s1] = [m, ((a % m) + m) % m, 0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return r0 === 1n ? ((s0 % m) + m) % m : null;
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

const bitLength = (b) => {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return i === b.length ? 0 : (b.length - i) * 8 - Math.clz32(b[i]) + 24;
};

// ---- EMSA-PSS (RFC 8017 section 9.1.1) with SHA-384, MGF1-SHA-384 and a 48-byte salt --------------------------------

async function mgf1(seed, length) {
  const out = new Uint8Array(Math.ceil(length / H_LEN) * H_LEN);
  for (let c = 0; c * H_LEN < length; c++) out.set(await sha384(seed, u32(c)), c * H_LEN);
  return out.subarray(0, length);
}

export async function emsaPssEncode(msg, emBits, salt) {
  const emLen = Math.ceil(emBits / 8);
  if (salt.length !== S_LEN || emLen < H_LEN + S_LEN + 2) throw new Error("encoding error");
  const h = await sha384(new Uint8Array(8), await sha384(msg), salt);
  const db = new Uint8Array(emLen - H_LEN - 1);
  db[db.length - S_LEN - 1] = 1;
  db.set(salt, db.length - S_LEN);
  const mask = await mgf1(h, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= mask[i];
  db[0] &= 0xff >> (8 * emLen - emBits);
  return concat(db, h, Uint8Array.of(0xbc));
}

// ---- RFC 9474 blind / finalize ---------------------------------------------------------------------------------

/** RSABSSA Blind: the blinded message to send and `inv`, the inverse of the blinding factor that unblinds the answer. */
export async function blind(pk, msg, random = systemRandom) {
  const n = os2ip(pk.n);
  const kLen = pk.n.length;
  const salt = random(new Uint8Array(S_LEN));
  const m = os2ip(await emsaPssEncode(msg, bitLength(pk.n) - 1, salt));
  if (gcd(m, n) !== 1n) throw new Error("invalid input");
  let inv = null;
  let r = 0n;
  for (let tries = 0; inv === null; tries++) {
    if (tries > 64) throw new Error("blinding error");
    r = os2ip(random(new Uint8Array(kLen)));
    if (r > 0n && r < n) inv = modInverse(r, n);
  }
  const z = (m * modPow(r, os2ip(pk.e), n)) % n;
  return { blindedMsg: i2osp(z, kLen), inv: i2osp(inv, kLen) };
}

/**
 * RSABSSA Finalize: unblind the router's signature and check it as RSA-PSS over msg with the public key.
 * Throws unless it verifies, so a wrong or corrupted signature never becomes a token.
 */
export async function finalize(pk, cryptoKey, msg, blindSig, inv) {
  const n = os2ip(pk.n);
  const kLen = pk.n.length;
  if (blindSig.length !== kLen || inv.length !== kLen) throw new Error("unexpected input size");
  const z = os2ip(blindSig);
  if (z >= n) throw new Error("signature is not below the modulus");
  const sig = i2osp((z * os2ip(inv)) % n, kLen);
  if (!(await crypto.subtle.verify({ name: "RSA-PSS", saltLength: S_LEN }, cryptoKey, sig, msg))) throw new Error("invalid signature");
  return sig;
}

// ---- issuer key (RFC 9578 section 6.5) ---------------------------------------------------------------------------

function readTlv(buf, at) {
  if (at + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[at];
  let len = buf[at + 1];
  let p = at + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count < 1 || count > 3 || p + count > buf.length) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[p + i];
    p += count;
  }
  if (p + len > buf.length) throw new Error("truncated DER");
  return { tag, body: buf.subarray(p, p + len), end: p + len };
}

const PSS_ALGORITHM_IDENTIFIER = fromHex("303d06092a864886f70d01010a3030a00d300b0609608648016503040202a11a301806092a864886f70d010108300b0609608648016503040202a203020130");

/** Reject any SPKI that is not exactly the RFC 9578 shape (RSASSA-PSS, SHA-384, MGF1-SHA-384, 48-byte salt, 2048-bit key). */
export function parseIssuerSpki(spki, expectedLen = NK) {
  const outer = readTlv(spki, 0);
  if (outer.tag !== 0x30 || outer.end !== spki.length) throw new Error("invalid SPKI");
  const body = outer.body;
  const alg = PSS_ALGORITHM_IDENTIFIER;
  if (body.length < alg.length || !alg.every((v, i) => body[i] === v)) throw new Error("SPKI is not RSASSA-PSS with SHA-384, MGF1-SHA-384 and a 48-byte salt");
  const bits = readTlv(body, alg.length);
  if (bits.tag !== 0x03 || bits.end !== body.length || bits.body[0] !== 0) throw new Error("invalid SPKI bit string");
  const seq = readTlv(bits.body, 1);
  if (seq.tag !== 0x30 || seq.end !== bits.body.length) throw new Error("invalid RSAPublicKey");
  const nInt = readTlv(seq.body, 0);
  const eInt = readTlv(seq.body, nInt.end);
  if (nInt.tag !== 0x02 || eInt.tag !== 0x02 || eInt.end !== seq.body.length) throw new Error("invalid RSAPublicKey");
  const strip = (b) => (b.length > 1 && b[0] === 0 ? b.subarray(1) : b);
  const n = strip(nInt.body);
  if (n.length !== expectedLen) throw new Error("modulus must be 2048 bits");
  return { n, e: strip(eInt.body) };
}

/** token_key_id: SHA-256 of the issuer SPKI, lowercase hex. */
export const tokenKeyId = async (spki) => toHex(await sha256(spki));

/** The public key as WebCrypto needs it to verify RSA-PSS with SHA-384. */
export function importPublicKey({ n, e }) {
  return crypto.subtle.importKey("jwk", { kty: "RSA", n: toBase64Url(n), e: toBase64Url(e), alg: "PS384", ext: true }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
}

// ---- token wire format (RFC 9578) --------------------------------------------------------------------------------

/** token_input = concat(0x0002, nonce, challenge_digest, token_key_id): the message that gets blind-signed. */
export function tokenInput(nonce, digest, keyId) {
  if (nonce.length !== NONCE_LEN || digest.length !== DIGEST_LEN || keyId.length !== KEY_ID_LEN) throw new Error("invalid token input");
  return concat(u16(TOKEN_TYPE), nonce, digest, keyId);
}

/** `Authorization: PrivateToken token=<base64url>`, from a finished token string. */
export const authorizationHeader = (token) => `PrivateToken token=${token}`;

// ---- buying ----------------------------------------------------------------------------------------------------

/**
 * Blind `count` fresh tokens for one directory key (an entry of GET /api/v1/blind/keys). Checks that the published key
 * hashes to its id first, so a router cannot show different visitors different keys under one id. The result holds
 * everything secret about the purchase (`input`, `inv`): keep it in this tab until the router's answer is unblinded.
 */
export async function blindTokens(key, challengeDigestHex, count, random = systemRandom) {
  const spki = fromBase64(key.token_key);
  if ((await tokenKeyId(spki)) !== key.token_key_id) throw new Error("The issuer key does not match its id, so no tokens were requested.");
  const pk = parseIssuerSpki(spki);
  const digest = fromHex(challengeDigestHex);
  const keyId = fromHex(key.token_key_id);
  const out = [];
  for (let i = 0; i < count; i++) {
    const input = tokenInput(random(new Uint8Array(NONCE_LEN)), digest, keyId);
    const { blindedMsg, inv } = await blind(pk, input, random);
    out.push({ keyId: key.token_key_id, input, blindedMsg, inv });
  }
  return out;
}

/** Unblind the router's signatures (in request order) into finished tokens, base64url, ready for `PrivateToken token=`. */
export async function finalizeTokens(key, pending, signatures) {
  if (signatures.length !== pending.length) throw new Error("The signature count does not match the request.");
  const pk = parseIssuerSpki(fromBase64(key.token_key));
  const cryptoKey = await importPublicKey(pk);
  const tokens = [];
  for (const [i, p] of pending.entries()) {
    const authenticator = await finalize(pk, cryptoKey, p.input, fromBase64(signatures[i]), p.inv);
    tokens.push(toBase64Url(concat(p.input, authenticator)));
  }
  return tokens;
}

/** Check a finished token against the issuer's public key: layout, key id and the RSA-PSS signature. */
export async function verifyToken(token, key, challengeDigestHex) {
  try {
    const bytes = fromBase64(token);
    if (bytes.length !== TOKEN_LEN || ((bytes[0] << 8) | bytes[1]) !== TOKEN_TYPE) return false;
    const input = bytes.subarray(0, TOKEN_LEN - NK);
    if (toHex(input.subarray(66, 98)) !== key.token_key_id) return false;
    if (challengeDigestHex && toHex(input.subarray(34, 66)) !== challengeDigestHex) return false;
    const pk = parseIssuerSpki(fromBase64(key.token_key));
    return await crypto.subtle.verify({ name: "RSA-PSS", saltLength: S_LEN }, await importPublicKey(pk), bytes.subarray(TOKEN_LEN - NK), input);
  } catch {
    return false;
  }
}
