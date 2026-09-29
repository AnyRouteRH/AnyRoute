import { base64ToBytes, bytesToBase64Url, bytesToHex, concatBytes, hexToBytes, randomBytes } from "./bytes.js";
import { sha256 } from "./hash.js";
import type { Fetch } from "./types.js";

// Blind tokens (Privacy Pass token type 0x0002, RFC 9578, over RSA blind signatures, RFC 9474). Buy tokens with an API
// key by sending blinded messages; spend one later with `Authorization: PrivateToken token=...`. The router sees the
// blinded messages when tokens are bought and the finished tokens when they are spent, and cannot connect the two.
// This is the client half of src/blind in the router, using the same library and suite (RSABSSA-SHA384-PSS-Deterministic).
// The blind-signature library is an optional peer dependency, loaded only when this module is used:
//   npm install @cloudflare/blindrsa-ts@0.4.6

export const TOKEN_TYPE = 0x0002;
export const NK = 256;
const NONCE_LEN = 32;
const DIGEST_LEN = 32;
const KEY_ID_LEN = 32;

type BlindRSA = {
  blind(pk: CryptoKey, msg: Uint8Array): Promise<{ blindedMsg: Uint8Array; inv: Uint8Array }>;
  finalize(pk: CryptoKey, msg: Uint8Array, blindSig: Uint8Array, inv: Uint8Array): Promise<Uint8Array>;
};

async function suite(): Promise<BlindRSA> {
  let mod: typeof import("@cloudflare/blindrsa-ts");
  try {
    mod = await import("@cloudflare/blindrsa-ts");
  } catch {
    throw new Error("Blind tokens need the optional dependency @cloudflare/blindrsa-ts (npm install @cloudflare/blindrsa-ts@0.4.6).");
  }
  return mod.RSABSSA.SHA384.PSS.Deterministic() as unknown as BlindRSA;
}

const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const cat = concatBytes;

// ---- issuer key (RFC 9578 section 6.5) -------------------------------------------------------------------------

function readTlv(buf: Uint8Array, at: number) {
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

const PSS_ALGORITHM_IDENTIFIER = hexToBytes("303d06092a864886f70d01010a3030a00d300b0609608648016503040202a11a301806092a864886f70d010108300b0609608648016503040202a203020130");

/** Reject any SPKI that is not exactly the RFC 9578 shape (RSASSA-PSS, SHA-384, MGF1-SHA-384, 48-byte salt, 2048-bit key). */
export function parseIssuerSpki(spki: Uint8Array): { n: Uint8Array; e: Uint8Array } {
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
  const strip = (b: Uint8Array) => (b.length > 1 && b[0] === 0 ? b.subarray(1) : b);
  const n = strip(nInt.body);
  if (n.length !== NK) throw new Error("modulus must be 2048 bits");
  return { n, e: strip(eInt.body) };
}

/** token_key_id: SHA-256 of the issuer SPKI, lowercase hex. */
export const tokenKeyId = async (spki: Uint8Array) => bytesToHex(await sha256(spki));

export async function importIssuerPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  const { n, e } = parseIssuerSpki(spki);
  return crypto.subtle.importKey("jwk", { kty: "RSA", n: bytesToBase64Url(n), e: bytesToBase64Url(e), alg: "PS384", ext: true }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
}

// ---- token wire format -----------------------------------------------------------------------------------------

/** token_input = concat(0x0002, nonce, challenge_digest, token_key_id): the message that gets blind-signed. */
export function tokenInput(nonce: Uint8Array, digest: Uint8Array, keyId: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_LEN || digest.length !== DIGEST_LEN || keyId.length !== KEY_ID_LEN) throw new Error("invalid token input");
  return cat(u16(TOKEN_TYPE), nonce, digest, keyId);
}

/** `Authorization: PrivateToken token=<base64url>`. */
export const authorizationHeader = (tokenBytes: Uint8Array) => `PrivateToken token=${bytesToBase64Url(tokenBytes)}`;

/** The nullifier the router records for a spent token (SHA-256 of the token bytes), hex; also what its receipt shows. */
export async function tokenNullifier(token: string): Promise<string> {
  return bytesToHex(await sha256(base64ToBytes(token)));
}

// ---- protocol ---------------------------------------------------------------------------------------------------

export type DirectoryKey = { token_key_id: string; token_key: string; epoch: number; denomination: number; status: string; value_usd: string; issue_until: string; redeem_until: string };
export type Directory = { challenge_digest: string; unit_price_usd: string; max_batch: number; epoch: number; keys: DirectoryKey[] };

export async function fetchDirectory(baseUrl: string, fetchImpl: Fetch = fetch): Promise<Directory> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/v1/blind/keys`);
  if (!res.ok) throw new Error(`GET /api/v1/blind/keys failed with ${res.status}`);
  return ((await res.json()) as { data: Directory }).data;
}

/** The key currently issuing tokens of one denomination. */
export function issuingKey(dir: Directory, denomination: number): DirectoryKey {
  const k = dir.keys.find((x) => x.denomination === denomination && x.status === "issuing");
  if (!k) throw new Error(`no key is issuing ${denomination}-unit tokens right now`);
  return k;
}

/** A token being bought. Keep `inv` and `input` private: they are what turns the router's signature into a token. */
export type PendingToken = { keyId: string; input: Uint8Array; blindedMsg: Uint8Array; inv: Uint8Array };

/** Blind `count` fresh tokens. Checks that the published key hashes to its id, so a router cannot show different clients different keys under one id. */
export async function blindTokens(key: DirectoryKey, challengeDigestHex: string, count: number): Promise<PendingToken[]> {
  const spki = base64ToBytes(key.token_key);
  if ((await tokenKeyId(spki)) !== key.token_key_id) throw new Error("issuer key does not match its token_key_id");
  const pk = await importIssuerPublicKey(spki);
  const s = await suite();
  const out: PendingToken[] = [];
  for (let i = 0; i < count; i++) {
    const input = tokenInput(randomBytes(32), hexToBytes(challengeDigestHex), hexToBytes(key.token_key_id));
    const { blindedMsg, inv } = await s.blind(pk, input);
    out.push({ keyId: key.token_key_id, input, blindedMsg, inv });
  }
  return out;
}

/** Unblind the router's signatures (in request order) into finished tokens, base64url, ready for `PrivateToken token=`. */
export async function finalizeTokens(key: DirectoryKey, pending: PendingToken[], signatures: string[]): Promise<string[]> {
  if (signatures.length !== pending.length) throw new Error("signature count does not match the request");
  const pk = await importIssuerPublicKey(base64ToBytes(key.token_key));
  const s = await suite();
  const tokens: string[] = [];
  for (const [i, p] of pending.entries()) {
    const authenticator = await s.finalize(pk, p.input, base64ToBytes(signatures[i]), p.inv); // throws unless the signature verifies
    tokens.push(bytesToBase64Url(cat(p.input, authenticator)));
  }
  return tokens;
}

export type Bought = { tokens: string[]; denomination: number; epoch: number; costUsd: string; keyId: string };

/** Buy `count` tokens of one denomination with a router API key. */
export async function buyTokens(o: { baseUrl: string; apiKey: string; denomination: number; count: number; fetch?: Fetch }): Promise<Bought> {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  const dir = await fetchDirectory(base, f);
  const key = issuingKey(dir, o.denomination);
  const pending = await blindTokens(key, dir.challenge_digest, o.count);
  const res = await f(`${base}/api/v1/blind/purchase`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => bytesToBase64Url(p.blindedMsg)) }),
  });
  const json = (await res.json()) as { data?: { signatures: string[]; cost_usd: string; epoch: number; denomination: number }; error?: { message: string } };
  if (!res.ok || !json.data) throw new Error(`purchase failed (${res.status}): ${json.error?.message ?? "unknown error"}`);
  return { tokens: await finalizeTokens(key, pending, json.data.signatures), denomination: json.data.denomination, epoch: json.data.epoch, costUsd: json.data.cost_usd, keyId: key.token_key_id };
}
