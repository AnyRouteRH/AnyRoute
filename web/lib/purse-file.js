// The token file: what "Download token file" writes. It is the file the private proxy keeps at ~/.anyroute/tokens.json
// and the SDK reads (packages/client/src/blind-file.ts is the same format, with its documentation). One JSON object:
//
//   {
//     "version": 1,
//     "tokens": [
//       {
//         "token": "<base64url, 354 bytes>",     the value that follows `PrivateToken token=`
//         "key_id": "<64 hex>",                  the issuer key it was signed under (bytes 66..98 of the token)
//         "denomination": 1000,                  units; one call may cost at most its value
//         "epoch": 2900,
//         "value_usd": "0.002",
//         "redeem_until": "2026-10-13T00:00:00.000Z",   after this the router no longer accepts it
//         "bought_at": "2026-09-30T00:00:00.000Z"       when it was bought (this page writes the day, not the minute)
//       }
//     ],
//     "unconfirmed": []                          tokens a tool sent whose outcome it never learned; never used again
//   }
//
// It holds no API key, wallet address or account. A tool that spends a token removes it from `tokens`.

import { TOKEN_LEN, TOKEN_TYPE, fromBase64, toHex } from "./blind-rsa.js";

export const TOKEN_FILE_VERSION = 1;
export const TOKEN_FILE_NAME = "anyroute-tokens.json";

export class TokenFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenFileError";
  }
}

/** The key id inside a finished token, or throws TokenFileError when it is not a type 0x0002 token of the right size. */
export function inspectToken(token) {
  let bytes;
  try {
    bytes = fromBase64(token);
  } catch {
    throw new TokenFileError("A token is not base64url.");
  }
  if (bytes.length !== TOKEN_LEN || ((bytes[0] << 8) | bytes[1]) !== TOKEN_TYPE) throw new TokenFileError(`A token must be ${TOKEN_LEN} bytes of type 0x0002.`);
  return { keyId: toHex(bytes.subarray(66, 98)) };
}

const DECIMAL = /^\d+(\.\d{1,12})?$/;
const isoOrNull = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Midnight UTC of a moment: the page files the day a token was bought, not the minute. */
export const dayOf = (when = new Date()) => new Date(Math.floor(new Date(when).getTime() / 86_400_000) * 86_400_000).toISOString();

/** One file entry from a finished token and the directory key it was signed under. */
export function entryFor(token, key, boughtAt = dayOf()) {
  const { keyId } = inspectToken(token);
  if (key?.token_key_id && key.token_key_id !== keyId) throw new TokenFileError("A token was not signed under the key it is filed with.");
  const value = String(key?.value_usd ?? "");
  const redeem = isoOrNull(key?.redeem_until);
  if (!Number.isInteger(key?.denomination) || !Number.isInteger(key?.epoch) || !DECIMAL.test(value) || !redeem) throw new TokenFileError("A token needs its size, epoch, value and expiry from the key that signed it.");
  return { token, key_id: keyId, denomination: key.denomination, epoch: key.epoch, value_usd: value, redeem_until: redeem, bought_at: isoOrNull(boughtAt) ?? dayOf() };
}

/** A stored entry, checked as strictly as the private proxy checks it. */
function checkEntry(e, where) {
  if (!e || typeof e !== "object" || typeof e.token !== "string") throw new TokenFileError(`${where} has no token.`);
  const { keyId } = inspectToken(e.token);
  if (e.key_id !== keyId) throw new TokenFileError(`${where}: the token was not signed under the key_id it is filed with.`);
  if (!Number.isInteger(e.denomination) || !Number.isInteger(e.epoch)) throw new TokenFileError(`${where} has no denomination or epoch.`);
  if (typeof e.value_usd !== "string" || !DECIMAL.test(e.value_usd)) throw new TokenFileError(`${where} has no value_usd.`);
  if (!isoOrNull(e.redeem_until)) throw new TokenFileError(`${where} has no redeem_until.`);
  if (typeof e.bought_at !== "string") throw new TokenFileError(`${where} has no bought_at.`);
  return { token: e.token, key_id: e.key_id, denomination: e.denomination, epoch: e.epoch, value_usd: e.value_usd, redeem_until: e.redeem_until, bought_at: e.bought_at };
}

export function buildTokenFile(entries, unconfirmed = []) {
  return { version: TOKEN_FILE_VERSION, tokens: entries.map((e) => checkEntry(e, "A token entry")), unconfirmed: unconfirmed.map((e) => ({ ...checkEntry(e, "An unconfirmed entry"), sent_at: String(e.sent_at ?? "") })) };
}

export const serializeTokenFile = (file) => JSON.stringify(file, null, 2) + "\n";

/** Read a token file. Throws TokenFileError, with a reason, unless every entry is one this format defines. */
export function parseTokenFile(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new TokenFileError("The file is empty.");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new TokenFileError("The file is not valid JSON.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new TokenFileError("This is not a token file.");
  if (doc.version !== TOKEN_FILE_VERSION) throw new TokenFileError(`Token file version ${JSON.stringify(doc.version)} is not supported (this reader supports ${TOKEN_FILE_VERSION}).`);
  if (!Array.isArray(doc.tokens)) throw new TokenFileError("The file has no tokens array.");
  const unconfirmed = doc.unconfirmed ?? [];
  if (!Array.isArray(unconfirmed)) throw new TokenFileError("unconfirmed must be an array.");
  const seen = new Set();
  const tokens = [];
  for (const [i, item] of doc.tokens.entries()) {
    const e = checkEntry(item, `Token ${i + 1}`);
    if (!seen.has(e.token)) tokens.push(e);
    seen.add(e.token);
  }
  return { version: TOKEN_FILE_VERSION, tokens, unconfirmed: unconfirmed.map((u, i) => ({ ...checkEntry(u, `Unconfirmed token ${i + 1}`), sent_at: typeof u.sent_at === "string" ? u.sent_at : "" })) };
}

/** Add another file's tokens to this one without repeating any, so a download can join a file that already exists. */
export function mergeTokenFiles(base, more) {
  const have = new Set([...base.tokens, ...base.unconfirmed].map((t) => t.token));
  return { ...base, tokens: [...base.tokens, ...more.tokens.filter((t) => !have.has(t.token))] };
}

/** The file without the tokens that were spent. */
export function withoutTokens(file, spent) {
  const gone = new Set(spent);
  return { ...file, tokens: file.tokens.filter((t) => !gone.has(t.token)) };
}

// ---- amounts (exact: pico-dollars as BigInt) -------------------------------------------------------------------

/** A decimal USD string to pico-dollars (10^-12), rounded down. Throws on anything that is not a plain decimal. */
export function usdToPico(text) {
  const s = String(text ?? "").trim();
  if (!/^\d+(\.\d*)?$/.test(s)) throw new Error("not a USD amount");
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** 12n + BigInt((frac + "0".repeat(12)).slice(0, 12));
}

/** Pico-dollars to a plain USD string with the fewest decimals (at least two). */
export function picoToUsdText(pico) {
  const v = BigInt(pico);
  const whole = v / 10n ** 12n;
  const frac = (v % 10n ** 12n).toString().padStart(12, "0").replace(/0+$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

const usdToPicoSafe = (text) => {
  try {
    return usdToPico(text);
  } catch {
    return 0n;
  }
};

/** What a set of entries holds: count, exact value, the sizes, and the earliest time one stops working. */
export function summarize(entries) {
  let value = 0n;
  const bySize = new Map();
  let firstExpiry = null;
  for (const e of entries) {
    value += usdToPicoSafe(e.value_usd);
    const size = e.value_usd ?? "?";
    bySize.set(size, (bySize.get(size) ?? 0) + 1);
    const t = Date.parse(e.redeem_until ?? "");
    if (Number.isFinite(t) && (firstExpiry === null || t < firstExpiry)) firstExpiry = t;
  }
  return {
    count: entries.length,
    valuePico: value,
    valueUsd: picoToUsdText(value),
    sizes: [...bySize].map(([valueUsd, count]) => ({ valueUsd, count })).sort((a, b) => Number(usdToPicoSafe(a.valueUsd) - usdToPicoSafe(b.valueUsd))),
    firstExpiry: firstExpiry === null ? null : new Date(firstExpiry).toISOString(),
  };
}
