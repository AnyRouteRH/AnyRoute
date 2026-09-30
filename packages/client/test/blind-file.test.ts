import { describe, expect, test } from "bun:test";
import { TOKEN_FILE_VERSION, TokenFileError, buildTokenFile, bytesToBase64Url, mergeTokenFiles, parseTokenFile, serializeTokenFile, storedToken, tokenKeyIdOf, withoutTokens } from "../src/index.js";

// A token has the layout of RFC 9578 type 0x0002: type, nonce, challenge digest, key id, 256-byte authenticator.
// The file format checks that layout, not the signature (that needs the issuer's key).
function token(keyByte = 0x11, seed = 1): string {
  const b = new Uint8Array(354);
  b[1] = 0x02;
  b.fill(seed, 2, 34);
  b.fill(0x33, 34, 66);
  b.fill(keyByte, 66, 98);
  b.fill(0x77, 98);
  return bytesToBase64Url(b);
}
const keyId = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32);
const info = (byte: number, extra: Record<string, unknown> = {}) => ({ token_key_id: keyId(byte), denomination: 1000, epoch: 2900, value_usd: "0.002", redeem_until: "2026-10-13T00:00:00Z", ...extra });
const at = "2026-09-30T00:00:00Z";
const entry = (seed: number, byte = 0x11, extra: Record<string, unknown> = {}) => storedToken(token(byte, seed), info(byte, extra) as never, at);

describe("token file", () => {
  test("one JSON object with a version, the tokens and the unconfirmed ones; it reads back exactly", () => {
    const file = buildTokenFile([entry(1), entry(2)]);
    expect(Object.keys(file)).toEqual(["version", "tokens", "unconfirmed"]);
    expect(file.version).toBe(TOKEN_FILE_VERSION);
    expect(file.version).toBe(1);
    expect(file.unconfirmed).toEqual([]);
    expect(file.tokens[0]).toEqual({ token: token(0x11, 1), key_id: keyId(0x11), denomination: 1000, epoch: 2900, value_usd: "0.002", redeem_until: "2026-10-13T00:00:00.000Z", bought_at: "2026-09-30T00:00:00.000Z" });
    expect(Object.keys(file.tokens[0])).toEqual(["token", "key_id", "denomination", "epoch", "value_usd", "redeem_until", "bought_at"]);
    const text = serializeTokenFile(file);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseTokenFile(text)).toEqual(file);
  });

  test("it holds nothing that names the buyer", () => {
    const text = serializeTokenFile(buildTokenFile([entry(1)]));
    expect(text).not.toMatch(/sk-ar-v1|0x[0-9a-f]{40}|wallet|account|issuer/i);
  });

  test("a missing unconfirmed list reads as empty, repeated tokens count once, and unconfirmed ones keep their time", () => {
    const e = entry(1);
    const read = parseTokenFile(JSON.stringify({ version: 1, tokens: [e, e, entry(2)] }));
    expect(read.unconfirmed).toEqual([]);
    expect(read.tokens).toHaveLength(2);
    const sent = { ...entry(9), sent_at: "2026-09-30T14:00:00.000Z" };
    const withSent = parseTokenFile(JSON.stringify({ version: 1, tokens: [], unconfirmed: [sent], extra: "dropped" }));
    expect(withSent.unconfirmed).toEqual([sent]);
    expect(Object.keys(withSent)).toEqual(["version", "tokens", "unconfirmed"]);
  });

  test("what is not a token file is refused with a reason", () => {
    const good = entry(1);
    const cases: [string, RegExp][] = [
      ["", /empty/],
      ["not json", /not valid JSON/],
      [JSON.stringify([good.token]), /not a token file/],
      [JSON.stringify({ tokens: [good] }), /version undefined is not supported/],
      [JSON.stringify({ version: 2, tokens: [good] }), /version 2 is not supported/],
      [JSON.stringify({ version: 1 }), /no tokens array/],
      [JSON.stringify({ version: 1, tokens: [good], unconfirmed: "x" }), /unconfirmed must be an array/],
      [JSON.stringify({ version: 1, tokens: [{ nope: 1 }] }), /has no token/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, token: "!!!" }] }), /not base64url/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, token: bytesToBase64Url(new Uint8Array(100)) }] }), /354 bytes of type 0x0002/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, key_id: keyId(0x22) }] }), /not signed under the key_id/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, denomination: "1000" }] }), /no denomination or epoch/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, value_usd: 0.002 }] }), /no value_usd/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, redeem_until: "soon" }] }), /no redeem_until/],
      [JSON.stringify({ version: 1, tokens: [{ ...good, bought_at: undefined }] }), /no bought_at/],
      [JSON.stringify({ version: 1, tokens: [], unconfirmed: [{ ...good, key_id: "x" }] }), /Unconfirmed token 1/],
    ];
    for (const [text, message] of cases) expect(() => parseTokenFile(text)).toThrow(message);
    expect(() => parseTokenFile("")).toThrow(TokenFileError);
  });

  test("an entry needs the key that signed the token, and the key id is read from the token", () => {
    const t = token(0x11);
    expect(() => storedToken(t, info(0x22) as never)).toThrow(/not signed under the key/);
    expect(tokenKeyIdOf(t)).toBe(keyId(0x11));
    for (const bad of [{ denomination: "x" }, { value_usd: "1e-7" }, { epoch: 1.5 }, { redeem_until: "yesterday" }]) expect(() => storedToken(t, info(0x11, bad) as never)).toThrow(TokenFileError);
    expect(storedToken(t, info(0x11) as never, new Date("2026-09-30T13:45:10Z")).bought_at).toBe("2026-09-30T13:45:10.000Z");
  });

  test("a download joins a file that exists without repeating a token or touching the unconfirmed ones", () => {
    const existing = { ...buildTokenFile([entry(1), entry(2)]), unconfirmed: [{ ...entry(8), sent_at: "2026-09-30T14:00:00.000Z" }] };
    const merged = mergeTokenFiles(existing, buildTokenFile([entry(2), entry(3), entry(8)]));
    expect(merged.tokens.map((t) => t.token)).toEqual([token(0x11, 1), token(0x11, 2), token(0x11, 3)]);
    expect(merged.unconfirmed).toEqual(existing.unconfirmed);
    expect(existing.tokens).toHaveLength(2);
  });

  test("spent tokens are removed by value", () => {
    const file = buildTokenFile([entry(1), entry(2), entry(3)]);
    const after = withoutTokens(file, [file.tokens[1].token, "absent"]);
    expect(after.tokens.map((t) => t.token)).toEqual([file.tokens[0].token, file.tokens[2].token]);
    expect(file.tokens).toHaveLength(3);
  });
});
