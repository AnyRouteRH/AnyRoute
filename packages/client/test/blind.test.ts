import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { AnyRoute, base64ToBytes, parseTokenFile, serializeTokenFile, bytesToBase64, bytesToBase64Url, bytesToHex, concatBytes, hexToBytes, sha256 } from "../src/index.js";
import { authorizationHeader, blindTokens, boughtToFile, buyTokens, fetchDirectory, issuingKey, parseIssuerSpki, tokenInput, tokenKeyId, tokenNullifier, type Directory } from "../src/blind.js";
import { json, stubFetch } from "./helpers.js";

setDefaultTimeout(60_000);

// A stand-in issuer built from the same library the router uses, so the client is exercised against real blind RSA.
const suite = RSABSSA.SHA384.PSS.Deterministic();
const PSS_ALG = hexToBytes("303d06092a864886f70d01010a3030a00d300b0609608648016503040202a11a301806092a864886f70d010108300b0609608648016503040202a203020130");
const len = (n: number) => (n < 0x80 ? Uint8Array.of(n) : n < 0x100 ? Uint8Array.of(0x81, n) : Uint8Array.of(0x82, n >> 8, n & 0xff));
const tlv = (tag: number, body: Uint8Array) => concatBytes(Uint8Array.of(tag), len(body.length), body);
const int = (b: Uint8Array) => tlv(0x02, b[0] & 0x80 ? concatBytes(Uint8Array.of(0), b) : b);
const spkiOf = (n: Uint8Array, e: Uint8Array) => tlv(0x30, concatBytes(PSS_ALG, tlv(0x03, concatBytes(Uint8Array.of(0), tlv(0x30, concatBytes(int(n), int(e)))))));

async function issuer() {
  const { privateKey, publicKey } = await suite.generateKey({ modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) });
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const spki = spkiOf(base64ToBytes(jwk.n!), base64ToBytes(jwk.e!));
  const keyId = bytesToHex(await sha256(spki));
  const dir: Directory = {
    challenge_digest: "ab".repeat(32),
    unit_price_usd: "0.00001",
    max_batch: 10,
    epoch: 1,
    keys: [{ token_key_id: keyId, token_key: bytesToBase64(spki), epoch: 1, denomination: 1000, status: "issuing", value_usd: "0.01", issue_until: "2099-01-01T00:00:00Z", redeem_until: "2099-01-01T00:00:00Z" }],
  };
  return { privateKey, publicKey, spki, keyId, dir };
}

describe("blind tokens", () => {
  test("buy, unblind and spend: tokens carry the router's signature and the documented layout", async () => {
    const iss = await issuer();
    const purchases: any[] = [];
    const { fetch } = stubFetch({
      "/api/v1/blind/keys": () => json({ data: iss.dir }),
      "POST /api/v1/blind/purchase": async ({ init }) => {
        const body = JSON.parse(String(init!.body));
        purchases.push({ auth: (init!.headers as Record<string, string>).authorization, body });
        const signatures = await Promise.all(body.blinded_msgs.map(async (m: string) => bytesToBase64Url(await suite.blindSign(iss.privateKey, base64ToBytes(m)))));
        return json({ data: { signatures, cost_usd: "0.02", epoch: 1, denomination: 1000 } });
      },
    });
    const bought = await buyTokens({ baseUrl: "https://router.test", apiKey: "sk-key", denomination: 1000, count: 2, fetch });
    expect(bought.tokens).toHaveLength(2);
    expect(purchases[0].auth).toBe("Bearer sk-key");
    expect(purchases[0].body.token_key_id).toBe(iss.keyId);
    // The purchase carries blinded messages only: nothing in it equals a finished token or its nonce.
    for (const t of bought.tokens) {
      const bytes = base64ToBytes(t);
      expect(bytes.length).toBe(2 + 32 + 32 + 32 + 256);
      expect(bytes[0]).toBe(0);
      expect(bytes[1]).toBe(2);
      expect(bytesToHex(bytes.subarray(2 + 32 + 32, 2 + 32 + 32 + 32))).toBe(iss.keyId);
      expect(bytesToHex(bytes.subarray(2 + 32, 2 + 64))).toBe("ab".repeat(32));
      await suite.verify(iss.publicKey, bytes.subarray(98), bytes.subarray(0, 98)); // throws unless valid
      for (const m of purchases[0].body.blinded_msgs) expect(bytesToBase64Url(bytes).includes(m)).toBe(false);
    }
    expect(new Set(bought.tokens).size).toBe(2);
    expect(await tokenNullifier(bought.tokens[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(authorizationHeader(base64ToBytes(bought.tokens[0]))).toBe(`PrivateToken token=${bought.tokens[0]}`);
  });

  test("a purchase becomes a token file that reads back, with the key's size and expiry", async () => {
    const iss = await issuer();
    const { fetch } = stubFetch({
      "/api/v1/blind/keys": () => json({ data: iss.dir }),
      "POST /api/v1/blind/purchase": async ({ init }) => {
        const body = JSON.parse(String(init!.body));
        const signatures = await Promise.all(body.blinded_msgs.map(async (m: string) => bytesToBase64Url(await suite.blindSign(iss.privateKey, base64ToBytes(m)))));
        return json({ data: { signatures, cost_usd: "0.02", epoch: 1, denomination: 1000 } });
      },
    });
    const bought = await buyTokens({ baseUrl: "https://router.test", apiKey: "sk-key", denomination: 1000, count: 3, fetch });
    const file = boughtToFile(bought, new Date("2026-09-30T13:45:10Z"));
    const read = parseTokenFile(serializeTokenFile(file));
    expect(read).toEqual(file);
    expect(read.tokens.map((t) => t.token)).toEqual(bought.tokens);
    expect(read.tokens[0]).toMatchObject({ key_id: iss.keyId, denomination: 1000, value_usd: "0.01", epoch: 1, bought_at: "2026-09-30T13:45:10.000Z" });
  });

  test("a router that publishes a key under the wrong id is refused before anything is blinded", async () => {
    const iss = await issuer();
    const lying = { ...iss.dir, keys: [{ ...iss.dir.keys[0], token_key_id: "cd".repeat(32) }] };
    await expect(blindTokens(lying.keys[0], lying.challenge_digest, 1)).rejects.toThrow(/token_key_id/);
  });

  test("a signature made by another key does not finish into a token", async () => {
    const iss = await issuer();
    const other = await issuer();
    const { fetch } = stubFetch({
      "/api/v1/blind/keys": () => json({ data: iss.dir }),
      "POST /api/v1/blind/purchase": async ({ init }) => {
        const body = JSON.parse(String(init!.body));
        return json({ data: { signatures: await Promise.all(body.blinded_msgs.map(async (m: string) => bytesToBase64Url(await suite.blindSign(other.privateKey, base64ToBytes(m))))), cost_usd: "0", epoch: 1, denomination: 1000 } });
      },
    });
    await expect(buyTokens({ baseUrl: "https://router.test", apiKey: "k", denomination: 1000, count: 1, fetch })).rejects.toThrow();
  });

  test("directory helpers and the SPKI reader", async () => {
    const iss = await issuer();
    const { fetch } = stubFetch({ "/api/v1/blind/keys": () => json({ data: iss.dir }) });
    const dir = await fetchDirectory("https://router.test", fetch);
    expect(issuingKey(dir, 1000).token_key_id).toBe(iss.keyId);
    expect(() => issuingKey(dir, 5)).toThrow(/no key is issuing/);
    expect(parseIssuerSpki(iss.spki).n.length).toBe(256);
    expect(() => parseIssuerSpki(iss.spki.slice(0, 40))).toThrow();
    expect(await tokenKeyId(iss.spki)).toBe(iss.keyId);
    expect(() => tokenInput(new Uint8Array(31), new Uint8Array(32), new Uint8Array(32))).toThrow();
  });

  test("a client made with a token spends it instead of the API key", async () => {
    const iss = await issuer();
    const { fetch, calls } = stubFetch({
      "/api/v1/blind/keys": () => json({ data: iss.dir }),
      "POST /api/v1/blind/purchase": async ({ init }) => {
        const body = JSON.parse(String(init!.body));
        return json({ data: { signatures: await Promise.all(body.blinded_msgs.map(async (m: string) => bytesToBase64Url(await suite.blindSign(iss.privateKey, base64ToBytes(m))))), cost_usd: "0.01", epoch: 1, denomination: 1000 } });
      },
      "POST /api/v1/chat/completions": ({ init }) => json({ auth: (init!.headers as Record<string, string>).authorization, choices: [] }),
    });
    const c = new AnyRoute({ baseUrl: "https://router.test", apiKey: "sk-key", fetch });
    const { tokens } = await buyTokens({ baseUrl: "https://router.test", apiKey: "sk-key", denomination: 1000, count: 1, fetch });
    const spender = c.withPrivateToken(tokens[0]);
    const res: any = await spender.chat.completions.create({ model: "m", messages: [] }, { verifyReceipt: false });
    expect(res.auth).toBe(`PrivateToken token=${tokens[0]}`);
    expect(calls.filter((x) => x.init?.method === "POST").map((x) => new URL(x.url).pathname)).toEqual(["/api/v1/blind/purchase", "/api/v1/chat/completions"]);
  });
});
