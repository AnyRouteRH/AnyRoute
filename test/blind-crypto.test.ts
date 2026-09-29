import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { RSABSSA, type BlindRSA } from "@cloudflare/blindrsa-ts";
import { generateIssuerKey, importIssuerPublicKey, issuerSpki, isValidBlindedMsg, parseIssuerSpki, Signer, suite, tokenKeyId } from "../src/blind/rsa.ts";
import { challengeDigest, decodeBase64, decodeToken, encodeToken, hex, nullifierOf, parsePrivateToken, sha256Bytes, signedPart, tokenChallenge, tokenInput, unhex, TOKEN_LEN } from "../src/blind/token.ts";
import { epochCommitment } from "../src/blind/issuer.ts";
import vectors from "./fixtures/blind-vectors.json";

setDefaultTimeout(60_000); // 4096-bit blinding in the reference JavaScript implementation is slow

// Public test vectors: RFC 9474 Appendix A (RSABSSA) and RFC 9578 Appendix A.2 (token type 0x0002).

type V9474 = Record<"p" | "q" | "n" | "e" | "d" | "msg" | "msg_prefix" | "prepared_msg" | "salt" | "encoded_msg" | "inv" | "blinded_msg" | "blind_sig" | "sig" | "variant", string>;
type V9578 = Record<"skI" | "pkI" | "token_challenge" | "nonce" | "blind" | "salt" | "token_request" | "token_response" | "token", string>;

const big = (h: string) => BigInt("0x" + h);
const bytesOf = (v: bigint, len: number) => unhex(v.toString(16).padStart(len * 2, "0"));
function modInv(a: bigint, m: bigint) {
  let [r0, r1, s0, s1] = [m, ((a % m) + m) % m, 0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}
const b64 = (h: string) => Buffer.from(h, "hex").toString("base64url");

/** PKCS#8 for an RSA private key given as hex p, q, n, e, d (CRT values derived). */
function pkcs8FromParts(v: { p: string; q: string; n: string; e: string; d: string }) {
  const [p, q, d] = [big(v.p), big(v.q), big(v.d)];
  const enc = (x: bigint) => b64(x.toString(16).padStart(x.toString(16).length + (x.toString(16).length % 2), "0"));
  const jwk = { kty: "RSA", n: b64(v.n), e: b64(v.e.padStart(v.e.length + (v.e.length % 2), "0")), d: b64(v.d), p: b64(v.p), q: b64(v.q), dp: enc(d % (p - 1n)), dq: enc(d % (q - 1n)), qi: enc(modInv(q, p)) };
  return new Uint8Array(createPrivateKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "pkcs8" }));
}

function suiteFor(variant: string): BlindRSA {
  const family = variant.includes("PSSZERO") ? RSABSSA.SHA384.PSSZero : RSABSSA.SHA384.PSS;
  return variant.endsWith("Randomized") ? family.Randomized() : family.Deterministic();
}

/** Import a public key (n, e hex) for the library's SHA-384 RSA-PSS operations. */
const publicKeyOf = (n: string, e: string) =>
  crypto.subtle.importKey("jwk", { kty: "RSA", n: b64(n), e: b64(e.padStart(e.length + (e.length % 2), "0")), alg: "PS384", ext: true }, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);

describe("RFC 9474 test vectors through @cloudflare/blindrsa-ts", () => {
  for (const v of vectors.rfc9474 as V9474[]) {
    test(v.variant, async () => {
      const s = suiteFor(v.variant);
      const pk = await publicKeyOf(v.n, v.e);
      const signer = new Signer(pkcs8FromParts(v), 4096);

      // The issuer's operation reproduces the RFC's blind signature exactly.
      expect(hex(signer.blindSign(unhex(v.blinded_msg)))).toBe(v.blind_sig);

      // Blinding with the vector's salt and blinding factor reproduces the RFC's blinded message and inverse.
      const r = modInv(big(v.inv), big(v.n));
      const queue = [unhex(v.salt), bytesOf(r, 512)];
      const rng = spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
        if (a.length === queue[0]?.length) a.set(queue.shift()!);
        else throw new Error(`unexpected randomness request of ${a.length} bytes`);
        return a;
      }) as never);
      let blinded;
      try {
        blinded = await s.blind(pk, unhex(v.prepared_msg));
      } finally {
        rng.mockRestore();
      }
      expect(hex(blinded.blindedMsg)).toBe(v.blinded_msg);
      expect(hex(blinded.inv)).toBe(v.inv);

      // Unblinding gives the RFC's signature, and it verifies as plain RSA-PSS.
      const sig = await s.finalize(pk, unhex(v.prepared_msg), unhex(v.blind_sig), unhex(v.inv));
      expect(hex(sig)).toBe(v.sig);
      expect(await s.verify(pk, unhex(v.sig), unhex(v.prepared_msg))).toBe(true);
      const wrong = unhex(v.prepared_msg);
      wrong[0] ^= 1;
      expect(await s.verify(pk, unhex(v.sig), wrong)).toBe(false);
    });
  }

  test("the library's own BlindSign matches the native signer (PSS-Deterministic vector)", async () => {
    const v = (vectors.rfc9474 as V9474[]).find((x) => x.variant === "RSABSSA-SHA384-PSS-Deterministic")!;
    const pkcs8 = pkcs8FromParts(v);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-384" }, true, ["sign"]);
    expect(hex(await suiteFor(v.variant).blindSign(key, unhex(v.blinded_msg)))).toBe(v.blind_sig);
  }, 60_000);
});

describe("RFC 9578 type 0x0002 test vectors", () => {
  for (const [i, v] of (vectors.rfc9578 as V9578[]).entries()) {
    test(`issuance protocol 2, vector ${i + 1}`, async () => {
      const pem = Buffer.from(v.skI, "hex").toString("utf8");
      const priv = createPrivateKey(pem);
      const signer = new Signer(new Uint8Array(priv.export({ format: "der", type: "pkcs8" })));

      // The SPKI we build for an issuer key is byte-for-byte the RFC's, and so is its key id.
      expect(hex(signer.spki)).toBe(v.pkI);
      const pkI = unhex(v.pkI);
      expect(hex(issuerSpki(parseIssuerSpki(pkI).n, parseIssuerSpki(pkI).e))).toBe(v.pkI);
      const keyId = tokenKeyId(pkI);

      // The token is 0x0002 || nonce || SHA256(challenge) || token_key_id || authenticator.
      const token = unhex(v.token);
      expect(token.length).toBe(TOKEN_LEN);
      const parsed = decodeToken(token)!;
      expect(hex(parsed.nonce)).toBe(v.nonce);
      expect(hex(parsed.challengeDigest)).toBe(hex(challengeDigest(unhex(v.token_challenge))));
      expect(hex(parsed.keyId)).toBe(keyId);
      expect(hex(encodeToken(parsed))).toBe(v.token);
      expect(nullifierOf(token)).toBe(hex(sha256Bytes(token)));

      // Issuer side: the TokenRequest's blinded message yields the RFC's TokenResponse.
      const request = unhex(v.token_request);
      expect(request.length).toBe(2 + 1 + 256);
      expect(request[2]).toBe(parseInt(keyId.slice(-2), 16)); // truncated_token_key_id is the last byte
      expect(hex(signer.blindSign(request.subarray(3)))).toBe(v.token_response);

      // Client side: blinding with the vector's nonce, salt and blind reproduces the TokenRequest, and
      // finalizing the response yields the authenticator inside the RFC's token.
      const pk = await importIssuerPublicKey(pkI);
      const input = tokenInput(parsed.nonce, parsed.challengeDigest, parsed.keyId);
      expect(hex(input)).toBe(hex(signedPart(token)));
      const { n } = parseIssuerSpki(pkI);
      const queue = [unhex(v.salt), unhex(v.blind)];
      const rng = spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
        if (a.length === queue[0]?.length) a.set(queue.shift()!);
        else throw new Error(`unexpected randomness request of ${a.length} bytes`);
        return a;
      }) as never);
      let blinded;
      try {
        blinded = await suite().blind(pk, input);
      } finally {
        rng.mockRestore();
      }
      expect(hex(blinded.blindedMsg)).toBe(hex(request.subarray(3)));
      expect(isValidBlindedMsg(blinded.blindedMsg, n)).toBe(true);
      const authenticator = await suite().finalize(pk, input, unhex(v.token_response), blinded.inv);
      expect(hex(authenticator)).toBe(hex(parsed.authenticator));

      // Anyone can verify the token with an ordinary RSA-PSS verifier (SHA-384, MGF1-SHA-384, 48-byte salt).
      expect(await suite().verify(pk, parsed.authenticator, signedPart(token))).toBe(true);
      const tampered = new Uint8Array(token);
      tampered[2] ^= 1; // a different nonce
      expect(await suite().verify(pk, decodeToken(tampered)!.authenticator, signedPart(tampered))).toBe(false);
    });
  }
});

describe("issuer keys and token encoding", () => {
  test("a generated issuer key round-trips through blind, sign (native), finalize and verify", async () => {
    const key = await generateIssuerKey();
    expect(key.keyId).toBe(tokenKeyId(key.spki));
    expect(parseIssuerSpki(key.spki).n.length).toBe(256);
    const signer = new Signer(key.pkcs8);
    expect(hex(signer.spki)).toBe(hex(key.spki));
    const pk = await importIssuerPublicKey(key.spki);
    const input = tokenInput(crypto.getRandomValues(new Uint8Array(32)), challengeDigest(tokenChallenge("router.example")), unhex(key.keyId));
    const { blindedMsg, inv } = await suite().blind(pk, input);
    const sig = await suite().finalize(pk, input, signer.blindSign(blindedMsg), inv);
    expect(await suite().verify(pk, sig, input)).toBe(true);
    // Another issuer key does not verify it.
    const other = await importIssuerPublicKey((await generateIssuerKey()).spki);
    expect(await suite().verify(other, sig, input)).toBe(false);
  }, 30_000);

  test("the signer refuses malformed blinded messages", async () => {
    const key = await generateIssuerKey();
    const signer = new Signer(key.pkcs8);
    expect(() => signer.blindSign(new Uint8Array(255))).toThrow(/size/);
    expect(() => signer.blindSign(new Uint8Array(257))).toThrow(/size/);
    expect(() => signer.blindSign(new Uint8Array(256).fill(0xff))).toThrow(/modulus/);
    expect(isValidBlindedMsg(new Uint8Array(256).fill(0xff), parseIssuerSpki(key.spki).n)).toBe(false);
  });

  test("parseIssuerSpki accepts only the RFC 9578 key shape", async () => {
    const key = await generateIssuerKey();
    const plain = new Uint8Array(await crypto.subtle.exportKey("spki", (await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-384" }, true, ["sign", "verify"])).publicKey));
    expect(() => parseIssuerSpki(plain)).toThrow(/RSASSA-PSS/); // a plain rsaEncryption SPKI is a different key id: refuse it
    expect(() => parseIssuerSpki(key.spki.subarray(0, key.spki.length - 1))).toThrow();
    expect(() => parseIssuerSpki(new Uint8Array(0))).toThrow();
  });

  test("token challenge, encoding and header parsing", () => {
    // RFC 9578 A.2 vector 2 challenge: issuer.example, empty redemption context, origin.example.
    const challenge = tokenChallenge("issuer.example", "origin.example");
    expect(hex(challenge)).toBe((vectors.rfc9578 as V9578[])[1].token_challenge);
    const token = unhex((vectors.rfc9578 as V9578[])[0].token);
    const header = `PrivateToken token=${Buffer.from(token).toString("base64url")}`;
    expect(hex(parsePrivateToken(header)!)).toBe(hex(token));
    expect(hex(parsePrivateToken(`privatetoken token="${Buffer.from(token).toString("base64")}"`)!)).toBe(hex(token)); // quoted, standard base64
    expect(parsePrivateToken("Bearer sk-ar-v1-abc")).toBeUndefined();
    expect(parsePrivateToken(undefined)).toBeUndefined();
    expect(parsePrivateToken("PrivateToken")).toBeNull();
    expect(parsePrivateToken("PrivateToken challenge=abc")).toBeNull();
    expect(parsePrivateToken("PrivateToken token=not*base64")).toBeNull();
    expect(decodeToken(token.subarray(0, TOKEN_LEN - 1))).toBeNull();
    expect(decodeToken(new Uint8Array([...token, 0]))).toBeNull();
    const wrongType = new Uint8Array(token);
    wrongType[1] = 1;
    expect(decodeToken(wrongType)).toBeNull();
    expect(decodeBase64("a b")).toBeNull();
  });
});

describe("epoch commitment", () => {
  test("matches the value contracts/test/BlindIssuer.t.sol asserts", () => {
    // keccak256(abi.encode(uint64 epoch, uint32[] denominations, bytes32[] keyIds)), the value BlindIssuer stores.
    const c = epochCommitment(2960, [
      { denomination: 1000, keyId: "11".repeat(32) },
      { denomination: 10000, keyId: "22".repeat(32) },
      { denomination: 100000, keyId: "33".repeat(32) },
    ]);
    expect(c.commitment).toBe("0x" + "3404ddb4c7387d86b25729fe273e10e8b8e1424395772ff9ecd4794262f82e19");
    expect(c.denominations).toEqual([1000, 10000, 100000]);
    expect(c.keyIds[0]).toBe("0x" + "11".repeat(32));
  });
});
