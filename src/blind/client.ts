import { importIssuerPublicKey, suite, tokenKeyId } from "./rsa.ts";
import { authorizationHeader, b64url, decodeBase64, encodeToken, hex, nullifierOf, tokenInput, unhex } from "./privacy-token.ts";

// Client helper for blind tokens: fetch the issuer keys, blind a batch, buy it, unblind, and build the
// Authorization header. Everything secret stays in this process; the router sees blinded messages when
// tokens are bought and finished tokens when they are spent, and cannot connect the two.
//
//   const dir = await fetchDirectory(baseUrl);
//   const bought = await buyTokens({ baseUrl, apiKey, denomination: 10_000, count: 5 });
//   fetch(`${baseUrl}/api/v1/chat/completions`, { headers: { authorization: authorizationHeader(bought.tokens[0]) }, ... });

export type DirectoryKey = {
  token_key_id: string;
  token_key: string;
  epoch: number;
  denomination: number;
  status: string;
  value_usd: string;
  issue_until: string;
  redeem_until: string;
};
export type Directory = { challenge_digest: string; unit_price_usd: string; max_batch: number; epoch: number; keys: DirectoryKey[] };

type Fetch = typeof fetch;

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

/** A token being bought: the blinded message to send, and what is needed to finish it. Keep `inv` and `input` private. */
export type PendingToken = { keyId: string; input: Uint8Array; blindedMsg: Uint8Array; inv: Uint8Array };

/**
 * Blind `count` fresh tokens for a key. Checks that the published key really hashes to its token_key_id, so a
 * router cannot hand different clients different keys under one id.
 */
export async function blindTokens(key: DirectoryKey, challengeDigestHex: string, count: number): Promise<PendingToken[]> {
  const spki = decodeBase64(key.token_key);
  if (!spki || tokenKeyId(spki) !== key.token_key_id) throw new Error("issuer key does not match its token_key_id");
  const pk = await importIssuerPublicKey(spki);
  const out: PendingToken[] = [];
  for (let i = 0; i < count; i++) {
    const input = tokenInput(crypto.getRandomValues(new Uint8Array(32)), unhex(challengeDigestHex), unhex(key.token_key_id));
    const { blindedMsg, inv } = await suite().blind(pk, input);
    out.push({ keyId: key.token_key_id, input, blindedMsg, inv });
  }
  return out;
}

/** Unblind the router's signatures (in request order) into finished tokens, base64url, ready for `PrivateToken token=`. */
export async function finalizeTokens(key: DirectoryKey, pending: PendingToken[], signatures: string[]): Promise<string[]> {
  if (signatures.length !== pending.length) throw new Error("signature count does not match the request");
  const pk = await importIssuerPublicKey(decodeBase64(key.token_key)!);
  const tokens: string[] = [];
  for (const [i, p] of pending.entries()) {
    const sig = decodeBase64(signatures[i]);
    if (!sig) throw new Error(`signatures[${i}] is not base64url`);
    const authenticator = await suite().finalize(pk, p.input, sig, p.inv); // throws unless the signature verifies
    tokens.push(b64url(encodeToken({ nonce: p.input.subarray(2, 34), challengeDigest: p.input.subarray(34, 66), keyId: p.input.subarray(66, 98), authenticator })));
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
    body: JSON.stringify({ token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => b64url(p.blindedMsg)) }),
  });
  const json = (await res.json()) as { data?: { signatures: string[]; cost_usd: string; epoch: number; denomination: number }; error?: { message: string; type?: string } };
  if (!res.ok || !json.data) throw new Error(`purchase failed (${res.status}): ${json.error?.message ?? "unknown error"}`);
  return { tokens: await finalizeTokens(key, pending, json.data.signatures), denomination: json.data.denomination, epoch: json.data.epoch, costUsd: json.data.cost_usd, keyId: key.token_key_id };
}

export { authorizationHeader };

/** The nullifier the router will record for a finished token (SHA-256 of the token bytes). Also what its receipt shows. */
export const tokenNullifier = (token: string) => nullifierOf(decodeBase64(token)!);
