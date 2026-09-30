import { base64ToBytes, bytesToHex } from "./bytes.js";

// The token file: blind tokens on disk, in one format shared by the private proxy (which keeps it at
// ~/.anyroute/tokens.json), the browser page that buys them ("Private tokens" on the site, which writes it as a
// download), this SDK, and any tool that spends them. Nothing here needs the optional blind-signature library:
// reading and writing a file only checks a token's layout.
//
//   {
//     "version": 1,
//     "tokens": [
//       {
//         "token": "<base64url, 354 bytes>",      the value that follows `Authorization: PrivateToken token=`
//         "key_id": "<64 hex>",                   the issuer key it was signed under (bytes 66..98 of the token)
//         "denomination": 1000,                   units; one call may cost at most its value
//         "epoch": 2900,
//         "value_usd": "0.002",                   what one token is worth, as the router published it when it was bought
//         "redeem_until": "2026-10-13T00:00:00.000Z",   after this the router no longer accepts it
//         "bought_at": "2026-09-30T00:00:00.000Z"       when it was bought (the browser page writes the day, not the minute)
//       }
//     ],
//     "unconfirmed": []                           tokens a tool sent whose outcome it never learned; never used again
//   }
//
// Rules:
//  - `version` is required and a reader refuses a version it does not know. `unconfirmed` may be missing on read; a
//    writer always writes it.
//  - Every field of an entry is required. `key_id` must equal the key id inside the token, so a token cannot be filed
//    under a key that did not sign it.
//  - A tool that spends a token removes it from `tokens` (`withoutTokens`). A token it sent without learning the outcome
//    moves to `unconfirmed` and is not used again: it may or may not have been spent. A second spend is refused by the
//    router, so a token left in `tokens` by mistake costs a rejected call and nothing else.
//  - The file holds no API key, wallet address or account. Keep it readable by you only (mode 0600): anyone who has
//    it can spend its tokens. To add a download to a file that already exists, use `mergeTokenFiles`; copying it over
//    the old file would drop the tokens that were there.
//  - Unknown top-level fields are dropped on read.

export const TOKEN_FILE_VERSION = 1;
/** Where tools look by default, relative to the home directory. */
export const TOKEN_FILE_PATH = ".anyroute/tokens.json";

/** Privacy Pass token type 0x0002 (RFC 9578): type, nonce, challenge digest, key id, 256-byte authenticator. */
const TOKEN_LEN = 2 + 32 + 32 + 32 + 256;
const DECIMAL = /^\d+(\.\d{1,12})?$/;

export type StoredToken = {
  token: string;
  key_id: string;
  denomination: number;
  epoch: number;
  value_usd: string;
  redeem_until: string;
  bought_at: string;
};
export type UnconfirmedToken = StoredToken & { sent_at: string };
export type TokenFile = { version: typeof TOKEN_FILE_VERSION; tokens: StoredToken[]; unconfirmed: UnconfirmedToken[] };
/** What a directory key (GET /api/v1/blind/keys) says about the tokens it signed. */
export type TokenKeyInfo = { token_key_id?: string; denomination: number; epoch: number; value_usd: string; redeem_until: string };

export class TokenFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenFileError";
  }
}

const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** The key id inside a finished token; throws TokenFileError unless it has the layout of a type 0x0002 token. */
export function tokenKeyIdOf(token: string): string {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(token);
  } catch {
    throw new TokenFileError("A token is not base64url.");
  }
  if (bytes.length !== TOKEN_LEN || ((bytes[0] << 8) | bytes[1]) !== 0x0002) throw new TokenFileError(`A token must be ${TOKEN_LEN} bytes of type 0x0002.`);
  return bytesToHex(bytes.subarray(66, 98));
}

/** One file entry from a finished token and the directory key that signed it. `boughtAt` defaults to now. */
export function storedToken(token: string, key: TokenKeyInfo, boughtAt: string | Date = new Date()): StoredToken {
  const keyId = tokenKeyIdOf(token);
  if (key.token_key_id && key.token_key_id !== keyId) throw new TokenFileError("A token was not signed under the key it is filed with.");
  const redeem = iso(key.redeem_until);
  if (!Number.isInteger(key.denomination) || !Number.isInteger(key.epoch) || !DECIMAL.test(String(key.value_usd)) || !redeem) throw new TokenFileError("A token needs its size, epoch, value and expiry from the key that signed it.");
  return { token, key_id: keyId, denomination: key.denomination, epoch: key.epoch, value_usd: String(key.value_usd), redeem_until: redeem, bought_at: iso(boughtAt instanceof Date ? boughtAt.toISOString() : boughtAt) ?? new Date().toISOString() };
}

function checkEntry(e: unknown, where: string): StoredToken {
  const o = e as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.token !== "string") throw new TokenFileError(`${where} has no token.`);
  if (o.key_id !== tokenKeyIdOf(o.token)) throw new TokenFileError(`${where}: the token was not signed under the key_id it is filed with.`);
  if (!Number.isInteger(o.denomination) || !Number.isInteger(o.epoch)) throw new TokenFileError(`${where} has no denomination or epoch.`);
  if (typeof o.value_usd !== "string" || !DECIMAL.test(o.value_usd)) throw new TokenFileError(`${where} has no value_usd.`);
  if (!iso(o.redeem_until)) throw new TokenFileError(`${where} has no redeem_until.`);
  if (typeof o.bought_at !== "string") throw new TokenFileError(`${where} has no bought_at.`);
  return { token: o.token, key_id: o.key_id as string, denomination: o.denomination as number, epoch: o.epoch as number, value_usd: o.value_usd, redeem_until: o.redeem_until as string, bought_at: o.bought_at };
}

export function buildTokenFile(tokens: StoredToken[], unconfirmed: UnconfirmedToken[] = []): TokenFile {
  return { version: TOKEN_FILE_VERSION, tokens: tokens.map((t) => checkEntry(t, "A token entry")), unconfirmed: unconfirmed.map((t) => ({ ...checkEntry(t, "An unconfirmed entry"), sent_at: String(t.sent_at ?? "") })) };
}

export const serializeTokenFile = (file: TokenFile): string => JSON.stringify(file, null, 2) + "\n";

/** Read a token file. Throws TokenFileError, with a reason, unless every entry is one this format defines. */
export function parseTokenFile(text: string): TokenFile {
  const raw = String(text ?? "").trim();
  if (!raw) throw new TokenFileError("The file is empty.");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new TokenFileError("The file is not valid JSON.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new TokenFileError("This is not a token file.");
  const d = doc as Record<string, unknown>;
  if (d.version !== TOKEN_FILE_VERSION) throw new TokenFileError(`Token file version ${JSON.stringify(d.version)} is not supported (this reader supports ${TOKEN_FILE_VERSION}).`);
  if (!Array.isArray(d.tokens)) throw new TokenFileError("The file has no tokens array.");
  const unconfirmed = d.unconfirmed ?? [];
  if (!Array.isArray(unconfirmed)) throw new TokenFileError("unconfirmed must be an array.");
  const seen = new Set<string>();
  const tokens: StoredToken[] = [];
  d.tokens.forEach((item, i) => {
    const e = checkEntry(item, `Token ${i + 1}`);
    if (!seen.has(e.token)) tokens.push(e);
    seen.add(e.token);
  });
  return {
    version: TOKEN_FILE_VERSION,
    tokens,
    unconfirmed: unconfirmed.map((u, i) => ({ ...checkEntry(u, `Unconfirmed token ${i + 1}`), sent_at: typeof (u as { sent_at?: unknown }).sent_at === "string" ? (u as { sent_at: string }).sent_at : "" })),
  };
}

/** `more`'s tokens added to `base` without repeating any (or any that `base` has as unconfirmed). */
export function mergeTokenFiles(base: TokenFile, more: TokenFile): TokenFile {
  const have = new Set([...base.tokens, ...base.unconfirmed].map((t) => t.token));
  return { ...base, tokens: [...base.tokens, ...more.tokens.filter((t) => !have.has(t.token))] };
}

/** The file without the tokens that were spent. */
export function withoutTokens(file: TokenFile, spent: Iterable<string>): TokenFile {
  const gone = new Set(spent);
  return { ...file, tokens: file.tokens.filter((t) => !gone.has(t.token)) };
}
