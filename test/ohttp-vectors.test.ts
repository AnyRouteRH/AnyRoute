import { describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { BhttpError, DEFAULT_LIMITS, decodeRequest, decodeResponse, encodeRequest, encodeResponse, encodeVarint } from "../src/ohttp/bhttp.ts";
import {
  OHTTPErrorCode,
  REQUEST_PREFIX,
  SUITE,
  generateGatewayKey,
  isOHTTPError,
  loadGatewayKey,
  openRequest,
  parseKeyConfig,
  parseKeyConfigList,
  sealRequest,
  selectKeyConfig,
  serializeKeyConfig,
  serializeKeyConfigList,
} from "../src/ohttp/ohttp.ts";

// Published test vectors: RFC 9292 section 5 (binary HTTP) and RFC 9458 Appendix A (Oblivious HTTP), plus the RFC 9000
// variable-length integer examples. Values are copied from the RFCs; nothing here was produced by this code.
//
// Oblivious HTTP itself is done by ohttp-ts and hpke, so these tests check the pinned libraries against the RFC and
// against a second, independent computation of the RFC's formulas made here with node:crypto and hpke's single-shot
// calls: the published request must open, the published response must open under the published key schedule,
// what the libraries produce must open under the same independent computation, and what the independent side
// produces must open in the libraries.

const unhex = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ""), "hex"));
const hex = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("hex");
const text = (b: Uint8Array) => new TextDecoder().decode(b);

// ---- RFC 9292 ------------------------------------------------------------------------------------------------------

/** Figure 8: known-length encoding of the request in Figure 7. */
const FIG8 = "0003474554056874747073000a2f68656c6c6f2e747874406c0a757365722d6167656e74346375726c2f372e31362e33206c69626375726c2f372e31362e33204f70656e53534c2f302e392e376c207a6c69622f312e322e3304686f73740f7777772e6578616d706c652e636f6d0f6163636570742d6c616e677561676506656e2c206d690000";
/** Figure 9: the same request, indeterminate-length, with 10 bytes of padding. */
const FIG9 = "0203474554056874747073000a2f68656c6c6f2e7478740a757365722d6167656e74346375726c2f372e31362e33206c69626375726c2f372e31362e33204f70656e53534c2f302e392e376c207a6c69622f312e322e3304686f73740f7777772e6578616d706c652e636f6d0f6163636570742d6c616e677561676506656e2c206d6900000000000000000000000000";
/** Figure 11: indeterminate-length response with informational responses 102 and 103. */
const FIG11 = "0340660772756e6e696e670a22736c65657020313522004067046c696e6b233c2f7374796c652e6373733e3b2072656c3d7072656c6f61643b2061733d7374796c65046c696e6b243c2f7363726970742e6a733e3b2072656c3d7072656c6f61643b2061733d7363726970740040c804646174651d4d6f6e2c203237204a756c20323030392031323a32383a353320474d5406736572766572064170616368650d6c6173742d6d6f6469666965641d5765642c203232204a756c20323030392031393a31353a353620474d5404657461671422333461613338372d642d3135363865623030220d6163636570742d72616e6765730562797465730e636f6e74656e742d6c656e67746802353104766172790f4163636570742d456e636f64696e670c636f6e74656e742d747970650a746578742f706c61696e003348656c6c6f20576f726c6421204d7920636f6e74656e7420696e636c75646573206120747261696c696e672043524c462e0d0a0000";
/** Figure 13: known-length response with a trailer. */
const FIG13 = "0140c8001d5468697320636f6e74656e7420636f6e7461696e732043524c462e0d0a0d07747261696c65720474657874";

const HELLO_HEADERS = [
  ["user-agent", "curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3"],
  ["host", "www.example.com"],
  ["accept-language", "en, mi"],
];

describe("RFC 9000 variable-length integers (as used by RFC 9292)", () => {
  test("the RFC's examples encode to the same bytes and non-minimal forms decode", () => {
    expect(hex(encodeVarint(494878333))).toBe("9d7f3e7d");
    expect(hex(encodeVarint(15293))).toBe("7bbd");
    expect(hex(encodeVarint(37))).toBe("25");
    expect(hex(encodeVarint(0))).toBe("00");
    expect(hex(encodeVarint(63))).toBe("3f");
    expect(hex(encodeVarint(64))).toBe("4040");
    expect(hex(encodeVarint(2 ** 30))).toBe("c000000040000000");
    // "0x4025 also decodes to 37": a request whose framing indicator is written in two bytes (0x4000 = 0) is valid.
    const twoByteFraming = Buffer.concat([unhex("4000"), unhex(FIG8).subarray(1)]);
    expect(decodeRequest(twoByteFraming).path).toBe("/hello.txt");
  });

  test("an 8-byte value beyond 2^53 is refused rather than rounded", () => {
    // 0xc2197c5eff14e88c is the RFC's 151288809941952652 example.
    expect(() => decodeRequest(Buffer.concat([unhex("c2197c5eff14e88c")]))).toThrow(/too large/);
  });
});

describe("RFC 9292 binary HTTP", () => {
  test("Figure 8: the known-length request decodes, and this encoder reproduces it byte for byte", () => {
    const req = decodeRequest(unhex(FIG8));
    expect(req).toMatchObject({ method: "GET", scheme: "https", authority: "", path: "/hello.txt", headers: HELLO_HEADERS, trailers: [] });
    expect(req.body).toHaveLength(0);
    expect(hex(encodeRequest({ method: "GET", scheme: "https", authority: "", path: "/hello.txt", headers: HELLO_HEADERS as never }))).toBe(FIG8);
  });

  test("Figure 9: the indeterminate-length encoding, padding included, means the same message", () => {
    expect(decodeRequest(unhex(FIG9))).toEqual(decodeRequest(unhex(FIG8)));
  });

  test("truncating the empty content and trailers of Figure 8 changes nothing (RFC 9292 section 5.1)", () => {
    const full = unhex(FIG8);
    for (const cut of [1, 2]) expect(decodeRequest(full.subarray(0, full.length - cut))).toEqual(decodeRequest(full));
    // Anything up to 12 bytes may be removed from the padded Figure 9.
    const padded = unhex(FIG9);
    for (const cut of [1, 5, 12]) expect(decodeRequest(padded.subarray(0, padded.length - cut))).toEqual(decodeRequest(unhex(FIG8)));
  });

  test("Figure 11: informational responses are read and skipped, the final response is complete", () => {
    const res = decodeResponse(unhex(FIG11));
    expect(res.informational.map((i) => i.status)).toEqual([102, 103]);
    expect(res.informational[0].headers).toEqual([["running", '"sleep 15"']]);
    expect(res.informational[1].headers).toEqual([
      ["link", "</style.css>; rel=preload; as=style"],
      ["link", "</script.js>; rel=preload; as=script"],
    ]);
    expect(res.status).toBe(200);
    expect(res.headers).toContainEqual(["content-type", "text/plain"]);
    expect(res.headers).toContainEqual(["content-length", "51"]);
    expect(res.headers).toContainEqual(["etag", '"34aa387-d-1568eb00"']);
    expect(text(res.body)).toBe("Hello World! My content includes a trailing CRLF.\r\n");
    expect(res.body).toHaveLength(51);
  });

  test("Figure 13: the known-length response with a trailer, and an encoder round trip", () => {
    const res = decodeResponse(unhex(FIG13));
    expect(res).toMatchObject({ status: 200, headers: [], trailers: [["trailer", "text"]], informational: [] });
    expect(text(res.body)).toBe("This content contains CRLF.\r\n");
    expect(hex(encodeResponse({ status: 200, body: res.body, trailers: [["trailer", "text"]] }))).toBe(FIG13);
    // RFC 9458 Appendix A's minimal response: 200, nothing else.
    expect(hex(encodeResponse({ status: 200 }))).toBe("0140c8000000");
    expect(decodeResponse(unhex("0140c8"))).toMatchObject({ status: 200, headers: [], trailers: [] });
  });

  test("padding: encoded messages can be padded with zero bytes, and only zero bytes", () => {
    const padded = encodeResponse({ status: 200, body: new TextEncoder().encode("hi") }, { padTo: 64 });
    expect(padded.length % 64).toBe(0);
    expect(text(decodeResponse(padded).body)).toBe("hi");
    const dirty = Buffer.from(padded);
    dirty[dirty.length - 1] = 1;
    expect(() => decodeResponse(dirty)).toThrow(/padding/);
  });

  test("invalid messages are refused, not repaired", () => {
    const fig8 = unhex(FIG8);
    const bad = (bytes: Uint8Array | Buffer, re: RegExp, decode: (b: Uint8Array) => unknown = decodeRequest) => expect(() => decode(bytes)).toThrow(re);
    bad(unhex("01" + FIG8.slice(2)), /not a binary HTTP request/); // a response framing indicator on a request
    bad(unhex("05"), /not a binary HTTP request/);
    bad(unhex(FIG13.replace(/^01/, "00")), /not a binary HTTP response/, decodeResponse);
    bad(fig8.subarray(0, 40), /truncated/); // cut in the middle of the header section
    bad(fig8.subarray(0, 8), /truncated/); // cut inside the control data
    bad(unhex(""), /truncated/);
    const req = (over: Record<string, unknown>) => encodeRequest({ method: "GET", path: "/x", headers: [], ...over } as never);
    expect(() => req({ path: "" })).toThrow(BhttpError);
    // Hand-built messages for what the encoder itself will not write.
    const raw = (method: string, path: string, fields: [string, string][], tail = "0000") => {
      const lp = (s: string) => Buffer.concat([encodeVarint(Buffer.byteLength(s, "latin1")), Buffer.from(s, "latin1")]);
      const section = Buffer.concat(fields.map(([n, v]) => Buffer.concat([lp(n), lp(v)])));
      return Buffer.concat([unhex("00"), lp(method), lp("https"), lp(""), lp(path), encodeVarint(section.length), section, unhex(tail)]);
    };
    expect(decodeRequest(raw("GET", "/x", [["accept", "*/*"]])).headers).toEqual([["accept", "*/*"]]);
    bad(raw("GET", "/x", [[":method", "POST"]]), /pseudo-field/);
    bad(raw("GET", "/x", [["Accept", "*/*"]]), /invalid field name/); // upper case would make an HTTP/2 message malformed
    bad(raw("GET", "/x", [["bad name", "x"]]), /invalid field name/);
    bad(raw("GET", "/x", [["x", "a\r\nb: c"]]), /invalid field value/);
    bad(raw("GET", "/x", [["x", "a\nb"]]), /invalid field value/);
    bad(raw("GET", "/x", [["x", "a\u0000b"]]), /invalid field value/);
    bad(raw("GET", "/x", [["x", " a"]]), /whitespace/);
    bad(raw("GET", "/x", [["x", "a "]]), /whitespace/);
    bad(raw("GE T", "/x", []), /invalid method/);
    bad(raw("GET", "/a b", []), /invalid path/);
    bad(raw("GET", "/é", []), /invalid path/);
    bad(raw("GET", "", []), /empty path/);
    bad(raw("GET", "/x", [], "000001"), /padding is not zero/);
    // A length that claims more bytes than the message holds never allocates them.
    bad(Buffer.concat([unhex("000347455405687474707300012f"), unhex("3fffffff")]), /truncated/);
  });

  test("robustness: random and mutated messages are decoded or refused with a BhttpError, never anything else", () => {
    let seed = 0x9e3779b9; // fixed, so a failure reproduces
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const attempt = (b: Uint8Array) => {
      for (const decode of [decodeRequest, decodeResponse]) {
        try {
          decode(b);
        } catch (e) {
          if (!(e instanceof BhttpError)) throw e;
        }
      }
    };
    const seeds = [FIG8, FIG9, FIG11, FIG13, "00034745540568747470730b6578616d706c652e636f6d012f"].map(unhex);
    for (let i = 0; i < 3000; i++) {
      const junk = new Uint8Array(Math.floor(rand() * 64));
      for (let j = 0; j < junk.length; j++) junk[j] = Math.floor(rand() * 256);
      attempt(junk);
      const base = Buffer.from(seeds[i % seeds.length]);
      for (let k = 0; k < 1 + (i % 4); k++) base[Math.floor(rand() * base.length)] = Math.floor(rand() * 256); // flip a few bytes
      attempt(base);
      attempt(base.subarray(0, Math.floor(rand() * base.length))); // and cut it anywhere
    }
  });

  test("limits: too many fields, an oversized field, an oversized section", () => {
    const many = encodeRequest({ method: "GET", path: "/x", headers: Array.from({ length: 101 }, (_, i) => [`x-${i}`, "v"]) as never });
    expect(() => decodeRequest(many, DEFAULT_LIMITS)).toThrow(/too many fields/);
    const long = encodeRequest({ method: "GET", path: "/x", headers: [["x", "a".repeat(20_000)]] });
    expect(() => decodeRequest(long)).toThrow(/too long/);
    const big = encodeRequest({ method: "GET", path: "/x", headers: Array.from({ length: 10 }, (_, i) => [`x-${i}`, "a".repeat(10_000)]) as never });
    expect(() => decodeRequest(big)).toThrow(/section is too large/);
    expect(decodeRequest(big, { maxFields: 100, maxFieldBytes: 20_000, maxSectionBytes: 200_000 }).headers).toHaveLength(10);
  });
});

// ---- RFC 9458 Appendix A ---------------------------------------------------------------------------------------

const A = {
  skR: "3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a",
  keyConfig: "01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e79815500080001000100010003",
  request: "00034745540568747470730b6578616d706c652e636f6d012f",
  pkE: "4b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b472",
  info: "6d6573736167652f626874747020726571756573740001002000010001",
  encRequest:
    "010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e7965e7d86b83dd440b2c0185204b4d63525",
  response: "0140c8",
  secret: "62d87a6ba569ee81014c2641f52bea36",
  responseNonce: "c789e7151fcba46158ca84b04464910d",
  salt: "4b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b472c789e7151fcba46158ca84b04464910d",
  prk: "979aaeae066cf211ab407b31ae49767f344e1501e475c84e8aff547cc5a683db",
  aeadKey: "5d0172a080e428b16d298c4ea0db620d",
  aeadNonce: "f6bf1aeb88d6df87007fa263",
  encResponse: "c789e7151fcba46158ca84b04464910d86f9013e404feea014e7be4a441f234f857fbd",
};
const MAX = 1 << 20;

// The RFC's formulas (sections 4.3 and 4.4), written out here rather than taken from the libraries under test.
const REQUEST_LABEL = Buffer.from("message/bhttp request");
const RESPONSE_LABEL = Buffer.from("message/bhttp response");
const infoOf = (header: Uint8Array) => Buffer.concat([REQUEST_LABEL, Buffer.from([0]), header]);
function refResponseKeys(secret: Uint8Array, enc: Uint8Array, nonce: Uint8Array) {
  const salt = Buffer.concat([enc, nonce]);
  const prk = createHmac("sha256", salt).update(secret).digest(); // Extract(salt, secret)
  return { prk, key: Buffer.from(hkdfSync("sha256", secret, salt, "key", 16)), nonce: Buffer.from(hkdfSync("sha256", secret, salt, "nonce", 12)) };
}
const refSeal = (key: Uint8Array, nonce: Uint8Array, pt: Uint8Array) => {
  const c = createCipheriv("aes-128-gcm", key, nonce);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
};
const refOpen = (key: Uint8Array, nonce: Uint8Array, ct: Uint8Array) => {
  const d = createDecipheriv("aes-128-gcm", key, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
};
/** The published gateway key pair as hpke wants it (the public half is needed to decapsulate with a non-extractable private key). */
const hpkeKeys = async () => ({ privateKey: await SUITE.DeserializePrivateKey(unhex(A.skR), false), publicKey: await SUITE.DeserializePublicKey(parseKeyConfig(unhex(A.keyConfig)).publicKey) });

describe("RFC 9458 Appendix A", () => {
  test("the published encapsulated request has the length the format implies: 7 + 32 + 25 + 16 bytes", () => {
    // (The RFC's example HTTP framing shows Content-Length: 78; its own hex is 80 bytes, which is what the format gives.)
    expect(unhex(A.encRequest)).toHaveLength(REQUEST_PREFIX + unhex(A.request).length + 16);
  });

  test("key configuration: parses, serializes back to the same bytes, and lists in application/ohttp-keys form", () => {
    const cfg = parseKeyConfig(unhex(A.keyConfig));
    expect(cfg).toMatchObject({ keyId: 1, kemId: 0x20, symmetricAlgorithms: [{ kdfId: 1, aeadId: 1 }, { kdfId: 1, aeadId: 3 }] });
    expect(hex(cfg.publicKey)).toBe("31e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155");
    expect(hex(serializeKeyConfig(cfg))).toBe(A.keyConfig);
    const list = serializeKeyConfigList([cfg, cfg]);
    expect(hex(list)).toBe("002d" + A.keyConfig + "002d" + A.keyConfig);
    expect(parseKeyConfigList(list)).toEqual([cfg, cfg]);
    expect(selectKeyConfig([cfg]).keyId).toBe(1); // this client's suite (HKDF-SHA256, AES-128-GCM) is among the two offered
  });

  test("a client discards a key list with any encoding error", () => {
    const good = unhex(A.keyConfig);
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return isOHTTPError(e) ? e.code : "other";
      }
      return "none";
    };
    expect(err(() => parseKeyConfig(good.subarray(0, good.length - 1)))).toBe(OHTTPErrorCode.InvalidKeyConfig);
    expect(err(() => parseKeyConfig(Buffer.concat([good, unhex("00")])))).toBe(OHTTPErrorCode.InvalidKeyConfig);
    expect(err(() => parseKeyConfig(Buffer.concat([good.subarray(0, 1), unhex("1234"), good.subarray(3)])))).toBe(OHTTPErrorCode.UnsupportedCipherSuite); // a KEM nobody defined
    expect(err(() => parseKeyConfigList(unhex("002e" + A.keyConfig)))).toBe(OHTTPErrorCode.InvalidKeyConfig); // length prefix runs past the end
    expect(err(() => parseKeyConfigList(unhex("002d" + A.keyConfig + "00")))).toBe(OHTTPErrorCode.InvalidKeyConfig); // stray trailing byte
    const odd = Buffer.from(good);
    odd[35] = 0;
    odd[36] = 6; // the symmetric algorithm list must be whole (KDF, AEAD) pairs
    expect(err(() => parseKeyConfig(odd))).toBe(OHTTPErrorCode.InvalidKeyConfig);
    expect(err(() => selectKeyConfig([]))).not.toBe("none"); // nothing usable: the client must not pick blindly
  });

  test("the gateway opens the published encapsulated request with the published private key", async () => {
    const key = await loadGatewayKey(1, parseKeyConfig(unhex(A.keyConfig)).publicKey, unhex(A.skR));
    expect(key.keyPair.privateKey.extractable).toBe(false); // a loaded key cannot be exported again
    const opened = await openRequest(key, unhex(A.encRequest), MAX);
    expect(hex(opened.request)).toBe(A.request);
    // The request is the binary HTTP message `GET https://example.com/`. (Its header section is left out by truncation.)
    expect(decodeRequest(opened.request)).toMatchObject({ method: "GET", scheme: "https", authority: "example.com", path: "/", headers: [] });
    // The exporter secret the response is keyed from is the published one, computed here from HPKE's single-shot call.
    const enc = unhex(A.encRequest).subarray(7, REQUEST_PREFIX);
    expect(hex(enc)).toBe(A.pkE);
    expect(hex(await SUITE.ReceiveExport(await hpkeKeys(), enc, RESPONSE_LABEL, 16, { info: unhex(A.info) }))).toBe(A.secret);
  });

  test("the published response key schedule, and the published encapsulated response, open under the RFC's formulas", () => {
    expect(hex(Buffer.concat([unhex(A.pkE), unhex(A.responseNonce)]))).toBe(A.salt);
    const ks = refResponseKeys(unhex(A.secret), unhex(A.pkE), unhex(A.responseNonce));
    expect(hex(ks.prk)).toBe(A.prk);
    expect(hex(ks.key)).toBe(A.aeadKey);
    expect(hex(ks.nonce)).toBe(A.aeadNonce);
    const published = unhex(A.encResponse);
    expect(hex(published.subarray(0, 16))).toBe(A.responseNonce);
    expect(hex(refOpen(ks.key, ks.nonce, published.subarray(16)))).toBe(A.response);
    expect(hex(Buffer.concat([unhex(A.responseNonce), refSeal(ks.key, ks.nonce, unhex(A.response))]))).toBe(A.encResponse); // and sealing reproduces it
  });

  test("the gateway's response to the published request opens under the same independent computation", async () => {
    const key = await loadGatewayKey(1, parseKeyConfig(unhex(A.keyConfig)).publicKey, unhex(A.skR));
    const opened = await openRequest(key, unhex(A.encRequest), MAX);
    const reply = await opened.respond(unhex(A.response));
    expect(reply).toHaveLength(16 + 3 + 16); // response nonce, the three-byte response, the AEAD tag (as in the published 35 bytes)
    const enc = unhex(A.encRequest).subarray(7, REQUEST_PREFIX);
    const secret = await SUITE.ReceiveExport(await hpkeKeys(), enc, RESPONSE_LABEL, 16, { info: unhex(A.info) });
    const ks = refResponseKeys(secret, enc, reply.subarray(0, 16));
    expect(hex(refOpen(ks.key, ks.nonce, reply.subarray(16)))).toBe(A.response);
    // Fresh randomness each time: a second response to the same request has a different nonce.
    expect(hex((await opened.respond(unhex(A.response))).subarray(0, 16))).not.toBe(hex(reply.subarray(0, 16)));
  });

  test("the client's encapsulated request opens under the independent HPKE computation, and the client opens an independently made response", async () => {
    const cfg = parseKeyConfig(unhex(A.keyConfig));
    const sent = await sealRequest(cfg, unhex(A.request), MAX);
    const wire = sent.encapsulated;
    expect(hex(wire.subarray(0, 7))).toBe("01" + "0020" + "0001" + "0001"); // key id, X25519, HKDF-SHA256, AES-128-GCM
    expect(wire).toHaveLength(REQUEST_PREFIX + 25 + 16);
    const enc = wire.subarray(7, REQUEST_PREFIX);
    const info = infoOf(wire.subarray(0, 7));
    expect(hex(info)).toBe(A.info);
    expect(hex(await SUITE.Open(await hpkeKeys(), enc, wire.subarray(REQUEST_PREFIX), { info }))).toBe(A.request);
    // An answer built here, from the secret the recipient side derives, is what the client opens.
    const secret = await SUITE.ReceiveExport(await hpkeKeys(), enc, RESPONSE_LABEL, 16, { info });
    const nonce = randomBytes(16);
    const ks = refResponseKeys(secret, enc, nonce);
    const answer = Buffer.concat([nonce, refSeal(ks.key, ks.nonce, unhex(A.response))]);
    expect(hex(await sent.openResponse(answer))).toBe(A.response);
    // The published response belongs to the published exchange, not to this one.
    await expect(sent.openResponse(unhex(A.encResponse))).rejects.toMatchObject({ code: OHTTPErrorCode.DecryptionFailed });
  });

  test("tampering: a changed byte anywhere in a request or response is refused, and so is an unoffered ciphersuite", async () => {
    const key = await loadGatewayKey(1, parseKeyConfig(unhex(A.keyConfig)).publicKey, unhex(A.skR));
    const req = unhex(A.encRequest);
    const code = async (b: Uint8Array) => {
      try {
        await openRequest(key, b, MAX);
      } catch (e) {
        return isOHTTPError(e) ? e.code : "other";
      }
      return "opened";
    };
    for (const at of [7, 20, 45, 60, req.length - 1]) {
      const t = Buffer.from(req);
      t[at] ^= 1;
      expect(await code(t)).toBe(OHTTPErrorCode.DecryptionFailed);
    }
    const setByte = (at: number, v: number) => Object.assign(Buffer.from(req), { [at]: v });
    expect(await code(setByte(0, 2))).toBe(OHTTPErrorCode.UnknownKeyId); // a different key identifier
    for (const [at, v] of [[2, 0x10], [1, 0x12], [4, 2], [6, 2], [6, 3]] as const) expect(await code(setByte(at, v))).toBe(OHTTPErrorCode.UnsupportedCipherSuite); // KEM, KDF, AEAD not offered
    expect(await code(req.subarray(0, 30))).toBe(OHTTPErrorCode.InvalidMessage);
    expect(await code(req.subarray(0, 50))).toBe(OHTTPErrorCode.DecryptionFailed);
    // Another gateway key cannot open it.
    const other = await generateGatewayKey(1);
    expect(await code(req)).toBe("opened");
    await expect(openRequest(await loadGatewayKey(1, other.publicKey, other.privateKey), req, MAX)).rejects.toMatchObject({ code: OHTTPErrorCode.DecryptionFailed });
    // Responses: any changed byte, a changed nonce, a short message.
    const sent = await sealRequest(parseKeyConfig(unhex(A.keyConfig)), unhex(A.request), MAX);
    const enc = sent.encapsulated.subarray(7, REQUEST_PREFIX);
    const secret = await SUITE.ReceiveExport(await hpkeKeys(), enc, RESPONSE_LABEL, 16, { info: infoOf(sent.encapsulated.subarray(0, 7)) });
    const nonce = randomBytes(16);
    const ks = refResponseKeys(secret, enc, nonce);
    const good = Buffer.concat([nonce, refSeal(ks.key, ks.nonce, unhex(A.response))]);
    for (const at of [0, 15, 16, good.length - 1]) {
      const t = Buffer.from(good);
      t[at] ^= 1;
      await expect(sent.openResponse(t)).rejects.toMatchObject({ code: OHTTPErrorCode.DecryptionFailed });
    }
    await expect(sent.openResponse(unhex("00"))).rejects.toBeDefined();
  });

  test("limits: a message beyond the configured size is refused", async () => {
    const key = await loadGatewayKey(1, parseKeyConfig(unhex(A.keyConfig)).publicKey, unhex(A.skR));
    await expect(openRequest(key, unhex(A.encRequest), 10)).rejects.toMatchObject({ code: OHTTPErrorCode.MessageTooLarge });
    await expect(sealRequest(parseKeyConfig(unhex(A.keyConfig)), new Uint8Array(100), 10)).rejects.toMatchObject({ code: OHTTPErrorCode.MessageTooLarge });
  });

  test("a fresh gateway key round-trips a request and a response, with a new ephemeral key each time", async () => {
    const gen = await generateGatewayKey(9);
    expect(gen.publicKey).toHaveLength(32);
    expect(gen.privateKey).toHaveLength(32);
    const cfg = parseKeyConfig(gen.config);
    expect(cfg).toMatchObject({ keyId: 9, kemId: 0x20, symmetricAlgorithms: [{ kdfId: 1, aeadId: 1 }] });
    expect(hex(cfg.publicKey)).toBe(hex(gen.publicKey));
    const key = await loadGatewayKey(9, gen.publicKey, gen.privateKey);
    const bhttp = encodeRequest({ method: "POST", path: "/api/v1/embeddings", headers: [["content-type", "application/json"]], body: new TextEncoder().encode('{"a":1}') });
    const a = await sealRequest(cfg, bhttp, MAX);
    const b = await sealRequest(cfg, bhttp, MAX);
    expect(hex(a.encapsulated.subarray(7, REQUEST_PREFIX))).not.toBe(hex(b.encapsulated.subarray(7, REQUEST_PREFIX))); // enc differs per request
    for (const sent of [a, b]) {
      const opened = await openRequest(key, sent.encapsulated, MAX);
      expect(opened.request).toEqual(bhttp);
      const reply = await opened.respond(encodeResponse({ status: 201, headers: [["x-a", "b"]], body: new TextEncoder().encode("ok") }));
      const res = decodeResponse(await sent.openResponse(reply));
      expect(res).toMatchObject({ status: 201, headers: [["x-a", "b"]] });
      expect(text(res.body)).toBe("ok");
    }
    // A response for one request cannot be opened as the answer to another.
    const first = await openRequest(key, a.encapsulated, MAX);
    await expect(b.openResponse(await first.respond(encodeResponse({ status: 200 })))).rejects.toMatchObject({ code: OHTTPErrorCode.DecryptionFailed });
  });
});
