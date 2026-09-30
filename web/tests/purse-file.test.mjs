import test from "node:test";
import assert from "node:assert/strict";
import { TOKEN_FILE_NAME, TOKEN_FILE_VERSION, TokenFileError, buildTokenFile, dayOf, entryFor, inspectToken, mergeTokenFiles, parseTokenFile, picoToUsdText, serializeTokenFile, summarize, usdToPico, withoutTokens } from "../lib/purse-file.js";
import { TOKEN_LEN, toBase64Url } from "../lib/blind-rsa.js";

// A token has the layout of RFC 9578 type 0x0002: type, nonce, challenge digest, key id, 256-byte authenticator.
// The file format checks that layout, not the signature (that needs the issuer's key).
function token(keyByte = 0x11, seed = 1) {
  const b = new Uint8Array(TOKEN_LEN);
  b[1] = 0x02;
  b.fill(seed, 2, 34); // nonce
  b.fill(0x33, 34, 66); // challenge digest
  b.fill(keyByte, 66, 98); // token_key_id
  b.fill(0x77, 98); // authenticator
  return toBase64Url(b);
}
const keyId = (byte) => byte.toString(16).padStart(2, "0").repeat(32);
const dirKey = (byte, extra = {}) => ({ token_key_id: keyId(byte), denomination: 1000, value_usd: "0.002", epoch: 2900, redeem_until: "2026-10-13T00:00:00Z", ...extra });
const entry = (seed, byte = 0x11, extra) => entryFor(token(byte, seed), dirKey(byte, extra), "2026-09-30T13:45:10Z");

test("the file is one JSON object with a version, the tokens and the ones a tool could not confirm", () => {
  const file = buildTokenFile([entry(1), entry(2)]);
  assert.deepEqual(Object.keys(file), ["version", "tokens", "unconfirmed"]);
  assert.equal(file.version, TOKEN_FILE_VERSION);
  assert.equal(file.version, 1);
  assert.deepEqual(file.unconfirmed, []);
  assert.deepEqual(Object.keys(file.tokens[0]), ["token", "key_id", "denomination", "epoch", "value_usd", "redeem_until", "bought_at"]);
  assert.deepEqual(file.tokens[0], { token: token(0x11, 1), key_id: keyId(0x11), denomination: 1000, epoch: 2900, value_usd: "0.002", redeem_until: "2026-10-13T00:00:00.000Z", bought_at: "2026-09-30T13:45:10.000Z" });
  const text = serializeTokenFile(file);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text), file);
  assert.equal(TOKEN_FILE_NAME, "anyroute-tokens.json");
});

test("the day a token was bought is filed, not the minute", () => {
  assert.equal(dayOf("2026-09-30T13:45:10Z"), "2026-09-30T00:00:00.000Z");
  assert.equal(dayOf("2026-09-30T00:00:00Z"), "2026-09-30T00:00:00.000Z");
  assert.equal(dayOf("2026-09-30T23:59:59.999Z"), "2026-09-30T00:00:00.000Z");
  assert.match(entryFor(token(), dirKey(0x11)).bought_at, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
});

test("a file written by the page reads back exactly", () => {
  const entries = [entry(1), entry(2), entry(3, 0x22, { denomination: 10000, value_usd: "0.02" })];
  const file = buildTokenFile(entries);
  assert.deepEqual(parseTokenFile(serializeTokenFile(file)), file);
  assert.deepEqual(parseTokenFile(serializeTokenFile(file)).tokens, entries);
});

test("the file holds no key, wallet address or account", () => {
  const text = serializeTokenFile(buildTokenFile([entry(1)]));
  const names = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        names.add(k);
        walk(x);
      }
  };
  walk(JSON.parse(text));
  assert.deepEqual([...names].sort(), ["bought_at", "denomination", "epoch", "key_id", "redeem_until", "token", "tokens", "unconfirmed", "value_usd", "version"]);
  assert.doesNotMatch(text, /sk-ar-v1|0x[0-9a-f]{40}|wallet|account|issuer/i);
});

test("a file that has no unconfirmed list is read as having none, and repeated tokens count once", () => {
  const e = entry(1);
  const read = parseTokenFile(JSON.stringify({ version: 1, tokens: [e, e, entry(2)] }));
  assert.deepEqual(read.unconfirmed, []);
  assert.equal(read.tokens.length, 2);
});

test("unconfirmed tokens survive a read and a write, with the time they were sent", () => {
  const sent = { ...entry(9), sent_at: "2026-09-30T14:00:00.000Z" };
  const file = parseTokenFile(JSON.stringify({ version: 1, tokens: [entry(1)], unconfirmed: [sent] }));
  assert.deepEqual(file.unconfirmed, [sent]);
  assert.deepEqual(parseTokenFile(serializeTokenFile(file)), file);
});

test("a reader refuses what is not a token file, with a reason", () => {
  const good = entry(1);
  const doc = (extra) => JSON.stringify({ version: 1, tokens: [good], ...extra });
  const cases = [
    ["", /empty/],
    ["   \n ", /empty/],
    ["not json at all", /not valid JSON/],
    [JSON.stringify([good.token]), /not a token file/],
    [JSON.stringify("token"), /not a token file/],
    [JSON.stringify({ tokens: [good] }), /version undefined is not supported/],
    [JSON.stringify({ version: 2, tokens: [good] }), /version 2 is not supported/],
    [JSON.stringify({ version: 1 }), /no tokens array/],
    [doc({ unconfirmed: "x" }), /unconfirmed must be an array/],
    [JSON.stringify({ version: 1, tokens: [{ nope: 1 }] }), /has no token/],
    [JSON.stringify({ version: 1, tokens: [42] }), /has no token/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, token: "!!!" }] }), /not base64url/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, token: toBase64Url(new Uint8Array(100)) }] }), /354 bytes of type 0x0002/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, key_id: keyId(0x22) }] }), /not signed under the key_id/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, denomination: "1000" }] }), /no denomination or epoch/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, epoch: 1.5 }] }), /no denomination or epoch/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, value_usd: 0.002 }] }), /no value_usd/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, value_usd: "1e-7" }] }), /no value_usd/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, redeem_until: "soon" }] }), /no redeem_until/],
    [JSON.stringify({ version: 1, tokens: [{ ...good, bought_at: undefined }] }), /no bought_at/],
    [doc({ unconfirmed: [{ ...good, key_id: "x" }] }), /Unconfirmed token 1/],
  ];
  for (const [text, message] of cases) assert.throws(() => parseTokenFile(text), (e) => e instanceof TokenFileError && message.test(e.message), `${text.slice(0, 70)} -> ${message}`);
  const wrongType = Uint8Array.from(Buffer.from(good.token, "base64url"));
  wrongType[1] = 0x01;
  assert.throws(() => parseTokenFile(JSON.stringify({ version: 1, tokens: [{ ...good, token: toBase64Url(wrongType) }] })), TokenFileError);
});

test("an entry is only made from a token and the key that signed it, and the key id is read from the token", () => {
  const t = token(0x11, 1);
  assert.throws(() => entryFor(t, dirKey(0x22)), /not signed under the key/);
  assert.equal(inspectToken(t).keyId, keyId(0x11));
  for (const bad of [{ denomination: "x" }, { value_usd: "1e-7" }, { epoch: 1.5 }, { redeem_until: "yesterday" }, { value_usd: undefined }]) assert.throws(() => entryFor(t, dirKey(0x11, bad)), TokenFileError, JSON.stringify(bad));
  assert.throws(() => entryFor(t, undefined), TokenFileError);
});

test("a download joins a file that already exists without repeating a token or touching the unconfirmed ones", () => {
  const existing = { ...buildTokenFile([entry(1), entry(2)]), unconfirmed: [{ ...entry(8), sent_at: "2026-09-30T14:00:00.000Z" }] };
  const download = buildTokenFile([entry(2), entry(3), entry(8)]);
  const merged = mergeTokenFiles(existing, download);
  assert.deepEqual(merged.tokens.map((t) => t.token), [token(0x11, 1), token(0x11, 2), token(0x11, 3)]);
  assert.deepEqual(merged.unconfirmed, existing.unconfirmed);
  assert.equal(existing.tokens.length, 2);
});

test("spent tokens are removed by value and the rest is untouched", () => {
  const file = buildTokenFile([entry(1), entry(2), entry(3)]);
  const after = withoutTokens(file, [file.tokens[1].token, "not in the file"]);
  assert.deepEqual(after.tokens.map((t) => t.token), [file.tokens[0].token, file.tokens[2].token]);
  assert.equal(after.version, file.version);
  assert.equal(file.tokens.length, 3);
});

test("dollar amounts are exact", () => {
  assert.equal(usdToPico("0.002"), 2_000_000_000n);
  assert.equal(usdToPico("5"), 5_000_000_000_000n);
  assert.equal(usdToPico("0.1234567890123456"), 123_456_789_012n); // extra digits are dropped, never rounded up
  assert.throws(() => usdToPico("1e-7"), /not a USD amount/);
  assert.throws(() => usdToPico("-1"), /not a USD amount/);
  assert.equal(picoToUsdText(2_000_000_000n), "0.002");
  assert.equal(picoToUsdText(5_000_000_000_000n), "5.00");
  assert.equal(picoToUsdText(0n), "0.00");
  assert.equal(picoToUsdText(1_500_000_000_000n), "1.50");
  for (const v of ["0.002", "0.02", "0.2", "12.345678"]) assert.equal(picoToUsdText(usdToPico(v)).replace(/0+$/, "").replace(/\.$/, ""), v);
});

test("a summary counts tokens, adds their value exactly and finds the first expiry", () => {
  const entries = [entry(1), entry(2), entry(3, 0x22, { denomination: 10000, value_usd: "0.02", redeem_until: "2026-10-10T00:00:00Z" }), entry(4, 0x33, { denomination: 100000, value_usd: "0.2" })];
  const s = summarize(entries);
  assert.equal(s.count, 4);
  assert.equal(s.valueUsd, "0.224");
  assert.equal(s.valuePico, usdToPico("0.224"));
  assert.deepEqual(s.sizes, [{ valueUsd: "0.002", count: 2 }, { valueUsd: "0.02", count: 1 }, { valueUsd: "0.2", count: 1 }]);
  assert.equal(s.firstExpiry, "2026-10-10T00:00:00.000Z");
  assert.deepEqual(summarize([]), { count: 0, valuePico: 0n, valueUsd: "0.00", sizes: [], firstExpiry: null });
});
