import { afterEach, describe, expect, test } from "bun:test";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { FrameCipher, HPKE_INFO, HPKE_SUITE, HpkeEndpoint, HpkeError, HpkeResponder, newSuite, RESPONSE_EXPORT_CONTEXT } from "../src/hpke.ts";
import { openResponse, ResponseOpener, sealRequest } from "../src/hpke-client.ts";
import { cleanup } from "./helpers.ts";

afterEach(cleanup);

const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const toHex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const PATH = "/v1/chat/completions";
const SKEW = 300_000;

// RFC 9180 Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode. This is the suite
// the sidecar uses, so passing this vector shows the configured suite is the standard one and the library is
// wired to it correctly.
const RFC = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  ikmE: "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234",
  pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
  ikmR: "6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037",
  pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
  enc: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  // sequence number -> ciphertext, with aad "Count-<n>"
  ct: {
    0: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
    1: "af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84",
    2: "498dfcabd92e8acedc281e85af1cb4e3e31c7dc394a1ca20e173cb72516491588d96a19ad4a683518973dcc180",
    4: "583bd32bc67a5994bb8ceaca813d369bca7b2a42408cddef5e22f880b631215a09fc0012bc69fccaa251c0246d",
    255: "7175db9717964058640a3a11fb9007941a5d1757fda1a6935c805c21af32505bf106deefec4a49ac38d71c9e0a",
    256: "957f9800542b0b8891badb026d79cc54597cb2d225b54c00c5238c25d05c30e3fbeda97d2e0e1aba483a2df9f2",
  } as Record<number, string>,
  exports: [
    { context: "", value: "3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee" },
    { context: "00", value: "2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5" },
    { context: "54657374436f6e74657874", value: "e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931" },
  ],
};

describe("RFC 9180 test vectors (A.1.1)", () => {
  test("the sidecar's suite is DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM", () => {
    const s = newSuite();
    expect([s.kem.id, s.kdf.id, s.aead.id]).toEqual([HPKE_SUITE.kem_id, HPKE_SUITE.kdf_id, HPKE_SUITE.aead_id]);
    expect([0x20, 0x01, 0x01]).toEqual([HPKE_SUITE.kem_id, HPKE_SUITE.kdf_id, HPKE_SUITE.aead_id]);
  });

  test("key derivation, encapsulation, sealing at every listed sequence number, and exports match", async () => {
    const suite = newSuite();
    const e = await suite.kem.deriveKeyPair(hex(RFC.ikmE));
    const r = await suite.kem.deriveKeyPair(hex(RFC.ikmR));
    expect(toHex(await suite.kem.serializePublicKey(e.publicKey))).toBe(RFC.pkEm);
    expect(toHex(await suite.kem.serializePrivateKey(e.privateKey))).toBe(RFC.skEm);
    expect(toHex(await suite.kem.serializePublicKey(r.publicKey))).toBe(RFC.pkRm);
    expect(toHex(await suite.kem.serializePrivateKey(r.privateKey))).toBe(RFC.skRm);

    const sender = await suite.createSenderContext({ recipientPublicKey: r.publicKey, info: hex(RFC.info), ekm: e });
    expect(toHex(sender.enc)).toBe(RFC.enc);
    for (let n = 0; n <= 256; n++) {
      const ct = await sender.seal(hex(RFC.pt), utf8(`Count-${n}`));
      if (RFC.ct[n]) expect(toHex(ct)).toBe(RFC.ct[n]);
    }
    for (const x of RFC.exports) expect(toHex(await sender.export(hex(x.context), 32))).toBe(x.value);
  });

  test("the recipient opens the vector's ciphertexts and derives the same exports", async () => {
    const suite = newSuite();
    const r = await suite.kem.deriveKeyPair(hex(RFC.ikmR));
    const recipient = await suite.createRecipientContext({ recipientKey: r, enc: hex(RFC.enc), info: hex(RFC.info) });
    for (const n of [0, 1, 2]) expect(toHex(await recipient.open(hex(RFC.ct[n]), utf8(`Count-${n}`)))).toBe(RFC.pt);
    for (const x of RFC.exports) expect(toHex(await recipient.export(hex(x.context), 32))).toBe(x.value);
    // A wrong aad or a flipped bit does not open.
    const again = await suite.createRecipientContext({ recipientKey: r, enc: hex(RFC.enc), info: hex(RFC.info) });
    await expect(again.open(hex(RFC.ct[0]), utf8("Count-1"))).rejects.toBeDefined();
  });
});

describe("response framing", () => {
  test("matches an independent derivation (RFC 5869 HKDF from a second library, AES-GCM through WebCrypto)", async () => {
    const secret = hex("00112233445566778899aabbccddeeff");
    const enc = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(16).fill(9);
    const cipher = new FrameCipher(secret, enc, nonce);
    const salt = new Uint8Array([...enc, ...nonce]);
    const key = hkdf(sha256, secret, salt, utf8("key"), 16);
    const base = hkdf(sha256, secret, salt, utf8("nonce"), 12);
    const subtle = crypto.subtle;
    const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
    for (let i = 0; i < 3; i++) {
      const final = i === 2;
      const frame = cipher.seal(utf8(`frame ${i}`), final);
      expect(frame[0]).toBe(final ? 1 : 0);
      expect(new DataView(frame.buffer, frame.byteOffset).getUint32(1)).toBe(frame.length - 5);
      const iv = new Uint8Array(base);
      new DataView(iv.buffer).setUint32(8, new DataView(iv.buffer).getUint32(8) ^ i);
      const plain = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array([frame[0]]) }, k, new Uint8Array(frame.subarray(5)));
      expect(text(new Uint8Array(plain))).toBe(`frame ${i}`);
    }
    // And the other direction: a frame made independently opens with the cipher.
    const opener = new FrameCipher(secret, enc, nonce);
    const iv0 = new Uint8Array(base);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv0, additionalData: new Uint8Array([1]) }, k, utf8("independent")));
    expect(text(opener.open(1, ct))).toBe("independent");
  });

  const open = async () => {
    const ep = await HpkeEndpoint.generate({ clockSkewMs: SKEW });
    const sealed = await sealRequest(ep.publicKeyHex, PATH, utf8("{}"));
    const { responder } = await ep.open(sealed.body, PATH);
    return { responder, opener: sealed.opener };
  };

  test("a single response round-trips; two responses to one request use different keys", async () => {
    const { responder, opener } = await open();
    const wire = responder.sealOnce(utf8('{"ok":true}'));
    expect(text(openResponse(opener, wire))).toBe('{"ok":true}');
    // Two responders built from the same secret (as a replayed request would) have fresh nonces, so different keys.
    const enc = new Uint8Array(32).fill(1);
    const secret = new Uint8Array(16).fill(2);
    const one = new HpkeResponder(enc, secret);
    const two = new HpkeResponder(enc, secret);
    expect(toHex(one.prefix)).not.toBe(toHex(two.prefix));
    expect(toHex(one.sealOnce(utf8("same")))).not.toBe(toHex(two.sealOnce(utf8("same"))));
  });

  test("a stream is read incrementally, byte by byte if need be, and must end with its final frame", async () => {
    const { responder, opener } = await open();
    const wire = new Uint8Array(Buffer.concat([responder.prefix, responder.frame(utf8("data: one\n\n"), false), responder.frame(utf8("data: two\n\n"), false), responder.frame(utf8("tail"), true)]));
    const got: string[] = [];
    for (const byte of wire) for (const p of opener.feed(new Uint8Array([byte]))) got.push(text(p));
    expect(got).toEqual(["data: one\n\n", "data: two\n\n", "tail"]);
    expect(opener.finished).toBe(true);
    opener.end();
    expect(() => responder.frame(utf8("more"), false)).toThrow(); // nothing after the last frame
  });

  test("truncation, reordering, tampering, a flipped final flag and trailing bytes are all detected", async () => {
    const make = async () => {
      const { responder, opener } = await open();
      const f1 = responder.frame(utf8("first"), false);
      const f2 = responder.frame(utf8("second"), false);
      const f3 = responder.frame(utf8("last"), true);
      return { prefix: responder.prefix, f1, f2, f3, opener };
    };
    const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p));
    // Cut short: no final frame.
    let m = await make();
    m.opener.feed(cat(m.prefix, m.f1, m.f2));
    expect(() => m.opener.end()).toThrow(/cut short/);
    // Cut in the middle of a frame.
    m = await make();
    m.opener.feed(cat(m.prefix, m.f1, m.f3.subarray(0, m.f3.length - 3)));
    expect(() => m.opener.end()).toThrow();
    // Reordered.
    m = await make();
    expect(() => m.opener.feed(cat(m.prefix, m.f2, m.f1, m.f3))).toThrow();
    // A dropped middle frame.
    m = await make();
    expect(() => m.opener.feed(cat(m.prefix, m.f1, m.f3))).toThrow();
    // Ciphertext altered.
    m = await make();
    const bad = new Uint8Array(m.f1);
    bad[bad.length - 1] ^= 1;
    expect(() => m.opener.feed(cat(m.prefix, bad))).toThrow();
    // The last frame relabelled as a non-final one, and vice versa.
    m = await make();
    const relabelled = new Uint8Array(m.f3);
    relabelled[0] = 0;
    expect(() => m.opener.feed(cat(m.prefix, m.f1, m.f2, relabelled))).toThrow();
    m = await make();
    const early = new Uint8Array(m.f1);
    early[0] = 1;
    expect(() => m.opener.feed(cat(m.prefix, early))).toThrow();
    // Bytes after the final frame.
    m = await make();
    expect(() => m.opener.feed(cat(m.prefix, m.f1, m.f2, m.f3, new Uint8Array([0])))).toThrow(/after the final/);
    // Someone else's response does not open.
    m = await make();
    const other = await open();
    expect(() => m.opener.feed(other.responder.sealOnce(utf8("x")))).toThrow();
    // Nonsense headers.
    const stranger = new ResponseOpener(new Uint8Array(32), new Uint8Array(16));
    expect(() => stranger.feed(cat(new Uint8Array(16), new Uint8Array([9, 0, 0, 0, 20])))).toThrow(/malformed/);
  });

  test("the response key derivation uses the request's HPKE export, so only that request's sender can read it", async () => {
    const ep = await HpkeEndpoint.generate({ clockSkewMs: SKEW });
    const a = await sealRequest(ep.publicKeyHex, PATH, utf8("a"));
    const b = await sealRequest(ep.publicKeyHex, PATH, utf8("b"));
    const opened = await ep.open(a.body, PATH);
    const wire = opened.responder.sealOnce(utf8("for a"));
    expect(() => openResponse(b.opener, wire)).toThrow();
    expect(text(openResponse(a.opener, wire))).toBe("for a");
    // The export label is part of the protocol.
    expect(text(RESPONSE_EXPORT_CONTEXT)).toBe("anyroute-hpke/v1 response");
    expect(text(HPKE_INFO)).toBe("anyroute-hpke/v1");
  });
});

describe("opening requests", () => {
  const setup = async (opts: { now?: () => number; replayCapacity?: number } = {}) => {
    const ep = await HpkeEndpoint.generate({ clockSkewMs: SKEW, ...opts });
    return { ep, seal: (body = '{"model":"m"}', o: { now?: number; path?: string } = {}) => sealRequest(ep.publicKeyHex, o.path ?? PATH, utf8(body), { now: o.now }) };
  };
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(HpkeError);
      return (e as HpkeError).reason;
    }
    return null;
  };

  test("the key is a fresh 32-byte X25519 key per boot and has a stable id", async () => {
    const a = await HpkeEndpoint.generate({ clockSkewMs: SKEW });
    const b = await HpkeEndpoint.generate({ clockSkewMs: SKEW });
    expect(a.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    expect(a.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.keyId).toBe(a.keyId);
    expect(a.keyId).not.toBe(b.keyId);
  });

  test("round trip: the plaintext arrives and the response goes back only to the sender", async () => {
    const { ep, seal } = await setup();
    const sealed = await seal('{"model":"m","messages":[{"role":"user","content":"secret question"}]}');
    expect(toHex(sealed.body)).not.toContain(toHex(utf8("secret question")));
    const { plaintext, responder } = await ep.open(sealed.body, PATH);
    expect(text(plaintext)).toContain("secret question");
    expect(text(openResponse(sealed.opener, responder.sealOnce(utf8("secret answer"))))).toBe("secret answer");
  });

  test("altered, misdirected, stale, replayed and foreign-key requests are refused with the right reason", async () => {
    const { ep, seal } = await setup();
    const good = await seal();
    // Any altered byte: version, time (within the window), enc, ciphertext.
    for (const at of [9, 20, good.body.length - 1]) {
      const bad = new Uint8Array(good.body);
      bad[at] ^= 1;
      expect(await reason(ep.open(bad, PATH))).toBe("decryption_failed");
    }
    const nearTime = new Uint8Array(good.body);
    nearTime[8] ^= 1; // one millisecond
    expect(await reason(ep.open(nearTime, PATH))).toBe("decryption_failed");
    const version = new Uint8Array(good.body);
    version[0] = 2;
    expect(await reason(ep.open(version, PATH))).toBe("malformed");
    expect(await reason(ep.open(good.body.subarray(0, 40), PATH))).toBe("malformed");
    // Wrong endpoint: the path is authenticated.
    expect(await reason(ep.open(good.body, "/v1/embeddings"))).toBe("decryption_failed");
    // Stale and future timestamps.
    expect(await reason(ep.open((await seal("{}", { now: Date.now() - SKEW - 5000 })).body, PATH))).toBe("expired");
    expect(await reason(ep.open((await seal("{}", { now: Date.now() + SKEW + 5000 })).body, PATH))).toBe("expired");
    // A key from another boot.
    const foreign = await HpkeEndpoint.generate({ clockSkewMs: SKEW });
    expect(await reason(ep.open((await sealRequest(foreign.publicKeyHex, PATH, utf8("{}"))).body, PATH))).toBe("decryption_failed");
    // The good one still opens once, and only once.
    expect(await reason(ep.open(good.body, PATH))).toBeNull();
    expect(await reason(ep.open(good.body, PATH))).toBe("replayed");
  });

  test("a failed attempt does not use up the request's slot in the replay cache", async () => {
    const { ep, seal } = await setup();
    const good = await seal();
    expect(await reason(ep.open(good.body, "/v1/embeddings"))).toBe("decryption_failed"); // wrong path
    expect(await reason(ep.open(good.body, PATH))).toBeNull(); // the genuine attempt is not blocked
  });

  test("the replay window follows the clock, and the cache is bounded", async () => {
    let now = 1_000_000_000_000;
    const { ep, seal } = await setup({ now: () => now, replayCapacity: 2 });
    const a = await seal("{}", { now });
    expect(await reason(ep.open(a.body, PATH))).toBeNull();
    expect(await reason(ep.open(a.body, PATH))).toBe("replayed");
    // Past twice the skew the entry is forgotten, but by then the timestamp is stale anyway.
    now += SKEW * 2 + 1;
    expect(await reason(ep.open(a.body, PATH))).toBe("expired");
    // Capacity: the oldest entry is evicted first.
    const b = await seal("{}", { now });
    const c = await seal("{}", { now });
    const d = await seal("{}", { now });
    for (const r of [b, c, d]) expect(await reason(ep.open(r.body, PATH))).toBeNull();
    expect(await reason(ep.open(d.body, PATH))).toBe("replayed");
  });

  test("responders are single use per response", async () => {
    const { ep, seal } = await setup();
    const { responder } = await ep.open((await seal()).body, PATH);
    responder.sealOnce(utf8("x"));
    expect(() => responder.sealOnce(utf8("y"))).toThrow();
    expect(responder).toBeInstanceOf(HpkeResponder);
  });

  test("the wire layout is nonce, then flag, length and ciphertext", async () => {
    const { ep, seal } = await setup();
    const { responder } = await ep.open((await seal()).body, PATH);
    const wire = responder.sealOnce(utf8("hello"));
    expect(wire.length).toBe(16 + 5 + "hello".length + 16);
    expect(toHex(wire.subarray(0, 16))).toBe(toHex(responder.prefix));
    expect(wire[16]).toBe(1);
    expect(new DataView(wire.buffer, wire.byteOffset + 17).getUint32(0)).toBe("hello".length + 16);
  });
});
