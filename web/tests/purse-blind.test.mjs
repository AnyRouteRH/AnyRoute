import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { NK, TOKEN_LEN, blind, blindTokens, emsaPssEncode, finalize, finalizeTokens, fromBase64, fromHex, importPublicKey, parseIssuerSpki, sha256, systemRandom, toBase64Url, toHex, tokenInput, tokenKeyId, verifyToken } from "../lib/blind-rsa.js";
import { issuerKeys } from "./purse-helpers.mjs";

// Public vectors: RFC 9474 appendix A (RSABSSA-SHA384-PSS-Deterministic) and RFC 9578 appendix A.2 (token type 0x0002).
const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/blind-vectors.json", import.meta.url), "utf8"));

const big = (h) => BigInt("0x" + h);
function modInv(a, m) {
  let [r0, r1, s0, s1] = [m, ((a % m) + m) % m, 0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}
/** A random source that hands out the given byte strings in order, one per request, and checks each request's size. */
const scripted = (...queue) => (buf) => {
  const next = queue.shift();
  assert.ok(next, "more randomness was requested than the vector provides");
  assert.equal(buf.length, next.length, "randomness requested in an unexpected size");
  buf.set(next);
  return buf;
};

test("RFC 9474 vector: blinding, unblinding and the final signature come out byte for byte", async () => {
  const v = vectors.rfc9474[0];
  assert.equal(v.variant, "RSABSSA-SHA384-PSS-Deterministic");
  const pk = { n: fromHex(v.n), e: fromHex(v.e.length % 2 ? "0" + v.e : v.e) };
  const msg = fromHex(v.prepared_msg);
  const r = modInv(big(v.inv), big(v.n));
  const random = scripted(fromHex(v.salt), fromHex(r.toString(16).padStart(v.n.length, "0")));
  // The PSS encoding alone reproduces the RFC's encoded message.
  assert.equal(toHex(await emsaPssEncode(msg, 4095, fromHex(v.salt))), v.encoded_msg);
  const { blindedMsg, inv } = await blind(pk, msg, random);
  assert.equal(toHex(blindedMsg), v.blinded_msg);
  assert.equal(toHex(inv), v.inv);
  const sig = await finalize(pk, await importPublicKey(pk), msg, fromHex(v.blind_sig), inv);
  assert.equal(toHex(sig), v.sig);
});

test("RFC 9578 vector: blindTokens and finalizeTokens rebuild the RFC's token request and token", async () => {
  const v = vectors.rfc9578[0];
  const spki = fromHex(v.pkI);
  const key = { token_key: toBase64Url(spki), token_key_id: await tokenKeyId(spki) };
  const digest = toHex(await sha256(fromHex(v.token_challenge)));
  const [pending] = await blindTokens(key, digest, 1, scripted(fromHex(v.nonce), fromHex(v.salt), fromHex(v.blind)));
  // TokenRequest = type(2) || truncated key id(1) || blinded message(256)
  assert.equal(toHex(pending.blindedMsg), v.token_request.slice(6));
  assert.equal(v.token_request.slice(4, 6), key.token_key_id.slice(-2));
  assert.equal(pending.blindedMsg.length, NK);
  const [token] = await finalizeTokens(key, [pending], [toBase64Url(fromHex(v.token_response))]);
  assert.equal(toHex(fromBase64(token)), v.token);
  assert.equal(fromBase64(token).length, TOKEN_LEN);
  assert.equal(await verifyToken(token, key, digest), true);
});

test("tokens blinded here are signed by a real issuer key and verify as ordinary RSA-PSS", async () => {
  const [issuer] = issuerKeys();
  const key = { token_key: toBase64Url(issuer.spki), token_key_id: issuer.keyId };
  const digest = toHex(await sha256(new TextEncoder().encode("router.example")));
  const pending = await blindTokens(key, digest, 6);
  const signatures = pending.map((p) => toBase64Url(crypto.privateDecrypt({ key: issuer.privateKey, padding: crypto.constants.RSA_NO_PADDING }, p.blindedMsg)));
  const tokens = await finalizeTokens(key, pending, signatures);
  assert.equal(new Set(tokens).size, 6);
  for (const t of tokens) {
    const bytes = fromBase64(t);
    assert.equal(bytes.length, 354);
    assert.deepEqual([bytes[0], bytes[1]], [0, 2]);
    assert.equal(toHex(bytes.subarray(66, 98)), issuer.keyId);
    assert.equal(toHex(bytes.subarray(34, 66)), digest);
    // Node's own RSA-PSS verifier agrees, with the parameters of RFC 9578.
    assert.equal(crypto.verify("sha384", bytes.subarray(0, 98), { key: issuer.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, bytes.subarray(98)), true);
    assert.equal(await verifyToken(t, key, digest), true);
  }
});

test("what is sent to the router does not contain the token, and each request differs", async () => {
  const [issuer] = issuerKeys();
  const key = { token_key: toBase64Url(issuer.spki), token_key_id: issuer.keyId };
  const pending = await blindTokens(key, "ab".repeat(32), 4);
  const seen = new Set();
  for (const p of pending) {
    const nonce = toHex(p.input.subarray(2, 34));
    const wire = toHex(p.blindedMsg);
    assert.ok(!wire.includes(nonce));
    assert.equal(p.blindedMsg.length, NK);
    assert.ok(big(wire) < big(toHex(parseIssuerSpki(issuer.spki).n)), "below the modulus");
    seen.add(wire);
    seen.add(nonce);
  }
  assert.equal(seen.size, 8);
});

test("a signature that does not verify never becomes a token", async () => {
  const [issuer] = issuerKeys();
  const key = { token_key: toBase64Url(issuer.spki), token_key_id: issuer.keyId };
  const pending = await blindTokens(key, "ab".repeat(32), 1);
  const good = crypto.privateDecrypt({ key: issuer.privateKey, padding: crypto.constants.RSA_NO_PADDING }, pending[0].blindedMsg);
  const flipped = Uint8Array.from(good);
  flipped[100] ^= 1;
  await assert.rejects(finalizeTokens(key, pending, [toBase64Url(flipped)]), /invalid signature/);
  await assert.rejects(finalizeTokens(key, pending, [toBase64Url(good.subarray(1))]), /unexpected input size/);
  await assert.rejects(finalizeTokens(key, pending, []), /signature count/);
  // a well-formed number that is simply not the signature
  const wrong = crypto.randomBytes(256);
  wrong[0] = 0;
  await assert.rejects(finalizeTokens(key, pending, [toBase64Url(wrong)]), /invalid signature/);
  // a signature at or above the modulus is refused before any arithmetic
  await assert.rejects(finalizeTokens(key, pending, [toBase64Url(new Uint8Array(256).fill(0xff))]), /below the modulus/);
});

test("an issuer key that does not hash to its id is refused before anything is requested", async () => {
  const [issuer] = issuerKeys();
  const other = issuerKeys()[1];
  await assert.rejects(blindTokens({ token_key: toBase64Url(issuer.spki), token_key_id: other.keyId }, "ab".repeat(32), 1), /does not match its id/);
});

test("only the key shape RFC 9578 fixes is accepted", async () => {
  const [issuer] = issuerKeys();
  assert.equal(parseIssuerSpki(issuer.spki).n.length, 256);
  const plain = issuer.publicKey.export({ type: "spki", format: "der" }); // plain rsaEncryption, not RSASSA-PSS
  assert.throws(() => parseIssuerSpki(new Uint8Array(plain)), /RSASSA-PSS/);
  const big3072 = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey.export({ type: "spki", format: "der" });
  assert.throws(() => parseIssuerSpki(new Uint8Array(big3072)));
  assert.throws(() => parseIssuerSpki(issuer.spki.subarray(0, 40)), /truncated|invalid/);
  assert.throws(() => parseIssuerSpki(Uint8Array.of(1, 2, 3)));
  assert.throws(() => parseIssuerSpki(new Uint8Array([...issuer.spki, 0])), /invalid SPKI/);
  assert.equal(await tokenKeyId(issuer.spki), issuer.keyId);
});

test("a token is verified against the key, the challenge and its own layout", async () => {
  const [issuer, other] = issuerKeys();
  const key = { token_key: toBase64Url(issuer.spki), token_key_id: issuer.keyId };
  const digest = "ab".repeat(32);
  const [p] = await blindTokens(key, digest, 1);
  const [t] = await finalizeTokens(key, [p], [toBase64Url(crypto.privateDecrypt({ key: issuer.privateKey, padding: crypto.constants.RSA_NO_PADDING }, p.blindedMsg))]);
  assert.equal(await verifyToken(t, key, digest), true);
  assert.equal(await verifyToken(t, key, "cd".repeat(32)), false); // another challenge
  assert.equal(await verifyToken(t, { token_key: toBase64Url(other.spki), token_key_id: other.keyId }, digest), false); // another key
  const tampered = fromBase64(t);
  tampered[5] ^= 1; // a different nonce
  assert.equal(await verifyToken(toBase64Url(tampered), key, digest), false);
  assert.equal(await verifyToken(t.slice(0, -4), key, digest), false);
  assert.equal(await verifyToken("!!!", key, digest), false);
});

test("token_input has a fixed layout and rejects the wrong sizes", () => {
  const input = tokenInput(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3));
  assert.equal(input.length, 98);
  assert.deepEqual([input[0], input[1], input[2], input[34], input[66]], [0, 2, 1, 2, 3]);
  assert.throws(() => tokenInput(new Uint8Array(31), new Uint8Array(32), new Uint8Array(32)), /invalid token input/);
  assert.throws(() => tokenInput(new Uint8Array(32), new Uint8Array(32), new Uint8Array(33)), /invalid token input/);
});

test("the default randomness is the platform's", () => {
  const a = systemRandom(new Uint8Array(32));
  const b = systemRandom(new Uint8Array(32));
  assert.notDeepEqual(a, b);
});
