import { beforeAll, describe, expect, test } from "bun:test";
import { AEAD_AES_128_GCM, AEAD_AES_256_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from "hpke";
import { ChunkedOHTTPServer, KeyConfig, type KeyConfigWithPrivate } from "ohttp-ts";
import { obliviousFetch, type ObliviousOptions } from "../src/ohttp.js";
import type { TransparencyLog } from "../src/tlog.js";

// The package's own transparency log fits the option as it is (a compile-time check).
const fitsTransparency = (t: TransparencyLog): ObliviousOptions["transparency"] => t;
void fitsTransparency;

// The SDK's chunked Oblivious HTTP against a gateway built from the same library the router uses: the inner messages
// are written out byte by byte here, so the decoder meets the forms a gateway may send (known and indeterminate length,
// interim responses, trailers, padding) and the ways a response can go wrong.

const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
let key: KeyConfigWithPrivate;
let config: Uint8Array;
beforeAll(async () => {
  key = await KeyConfig.generate(suite, 3);
  config = KeyConfig.serialize(key);
});

const enc = new TextEncoder();
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(Buffer.concat(parts.map((p) => Uint8Array.from(p))));
const vi = (n: number) => (n < 64 ? [n] : [0x40 | (n >> 8), n & 0xff]);
const lp = (b: Uint8Array) => cat(vi(b.length), b);
const field = (n: string, v: string) => cat(lp(enc.encode(n)), lp(enc.encode(v)));

/** A gateway that opens the request and answers with `message`, optionally rewriting the encapsulated bytes. */
function gateway(message: (request: Uint8Array) => Uint8Array, edit: (b: Uint8Array) => Uint8Array = (b) => b, seen: { request?: Uint8Array; headers?: Headers } = {}) {
  const server = new ChunkedOHTTPServer([key], { padding: 0 });
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.headers = new Headers(init?.headers);
    const { request, createResponseContext } = await server.decapsulate(new Uint8Array(await new Response(init!.body).arrayBuffer()));
    seen.request = request;
    const out = await server.encapsulateResponse(await createResponseContext(), message(request));
    return new Response(edit(out) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "message/ohttp-chunked-res" } });
  }) as typeof fetch;
}
const client = (f: typeof fetch) => obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: config, fetch: f });

describe("obliviousFetch", () => {
  test("sends a known-length request in a chunked encapsulation with the chunked media types", async () => {
    const seen: { request?: Uint8Array; headers?: Headers } = {};
    const res = await client(gateway(() => cat([1], vi(200), lp(new Uint8Array(0)), lp(enc.encode("ok"))), undefined, seen))("https://router.example/api/v1/models?x=1", { headers: { Accept: "application/json" } });
    expect(await res.text()).toBe("ok");
    expect(seen.headers?.get("content-type")).toBe("message/ohttp-chunked-req");
    expect(seen.headers?.get("accept")).toBe("message/ohttp-chunked-res");
    expect(seen.headers?.get("incremental")).toBe("?1");
    const expected = cat([0], lp(enc.encode("GET")), lp(enc.encode("https")), lp(new Uint8Array(0)), lp(enc.encode("/api/v1/models?x=1")), lp(field("accept", "application/json")), lp(new Uint8Array(0)), lp(new Uint8Array(0)));
    expect(seen.request).toEqual(expected); // the host is not sent
  });

  test("reads indeterminate-length messages with an interim response, trailers and padding, and known-length ones", async () => {
    const indeterminate = cat([3], vi(103), field("link", "</a>"), [0], vi(200), field("content-type", "text/plain"), field("x-a", "1"), [0], lp(enc.encode("hel")), lp(enc.encode("lo")), [0], field("x-trailer", "t"), [0], new Uint8Array(40));
    const a = await client(gateway(() => indeterminate))("https://router.example/x");
    expect(a.status).toBe(200);
    expect(a.headers.get("x-a")).toBe("1");
    expect(a.headers.get("link")).toBeNull();
    expect(await a.text()).toBe("hello");

    const known = cat([1], vi(404), lp(field("x-b", "2")), lp(enc.encode("gone")), lp(field("x-trailer", "t")), new Uint8Array(7));
    const b = await client(gateway(() => known))("https://router.example/x");
    expect(b.status).toBe(404);
    expect(b.headers.get("x-b")).toBe("2");
    expect(await b.text()).toBe("gone");

    // A body larger than one chunk.
    const big = new Uint8Array(50_000).fill(7);
    const c = await client(gateway(() => cat([1], vi(200), lp(new Uint8Array(0)), cat([0x80, 0, (big.length >> 8) & 0xff, big.length & 0xff]), big)))("https://router.example/x");
    expect(new Uint8Array(await c.arrayBuffer())).toEqual(big);
  });

  test("refuses what is not a whole, well-formed response", async () => {
    const ok = cat([3], vi(200), [0], lp(enc.encode("partial")), [0], [0]);
    const cases: [string, (r: Uint8Array) => Uint8Array, (b: Uint8Array) => Uint8Array, string][] = [
      ["non-zero padding", () => cat(ok, [0, 1]), (b) => b, "ohttp_invalid_response"],
      ["content cut inside a chunk", () => cat([3], vi(200), [0], vi(10), enc.encode("abc")), (b) => b, "ohttp_invalid_response"],
      ["content chunks without their terminator", () => cat([3], vi(200), [0], lp(enc.encode("abc"))), (b) => b, "ohttp_invalid_response"],
      ["a pseudo-header", () => cat([3], vi(200), field(":status", "200"), [0], [0], [0]), (b) => b, "ohttp_invalid_response"],
      ["not a response", () => cat([0], vi(200)), (b) => b, "ohttp_invalid_response"],
      ["the final chunk cut short", () => ok, (b) => b.subarray(0, b.length - 1), "ohttp_decrypt_failed"],
      ["an altered chunk", () => ok, (b) => ((b = b.slice()), (b[20] ^= 1), b), "ohttp_decrypt_failed"],
      ["only the nonce", () => ok, (b) => b.subarray(0, 16), "ohttp_truncated"],
      ["less than the nonce", () => ok, (b) => b.subarray(0, 9), "ohttp_truncated"],
    ];
    for (const [name, message, edit, code] of cases) {
      const outcome = await client(gateway(message, edit))("https://router.example/x")
        .then((r) => r.arrayBuffer())
        .then(
          () => "no error",
          (e) => e.code,
        );
      expect(`${name}: ${outcome}`).toBe(`${name}: ${code}`);
    }
  });

  test("a response cut before its final chunk is truncated, after the content that did arrive", async () => {
    const big = new Uint8Array(40_000).fill(1); // three chunks
    const message = cat([3], vi(200), [0], cat([0x80, 0, (big.length >> 8) & 0xff, big.length & 0xff]), big, [0], [0]);
    // Drop the final chunk: the last `0` length and what follows it.
    const cut = (b: Uint8Array) => {
      let at = 16;
      for (;;) {
        const size = 1 << (b[at] >> 6);
        let len = b[at] & 0x3f;
        for (let i = 1; i < size; i++) len = len * 256 + b[at + i];
        if (len === 0) return b.subarray(0, at);
        at += size + len;
      }
    };
    const res = await client(gateway(() => message, cut))("https://router.example/x");
    const reader = res.body!.getReader();
    let got = 0;
    const error = await (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return null;
        got += r.value.length;
      }
    })().catch((e) => e);
    expect(error?.code).toBe("ohttp_truncated");
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(big.length);
  });

  test("options and refusals", async () => {
    expect(() => obliviousFetch({ relayUrl: "", keyConfig: config })).toThrow(/relayUrl/);
    expect(() => obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: new Uint8Array(0) })).toThrow(/keyConfig/);
    const other = KeyConfig.serialize(await KeyConfig.generate(new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_256_GCM), 4));
    await expect(obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: other, fetch: gateway(() => new Uint8Array(0)) })("https://router.example/x")).rejects.toMatchObject({ code: "ohttp_bad_key_config" });
    await expect(obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: Uint8Array.of(1, 2, 3) })("https://router.example/x")).rejects.toMatchObject({ code: "ohttp_bad_key_config" });
    // A refusal before the request was unwrapped is plain JSON with a status: it is an error, never a response.
    const refusing = (async () => new Response(JSON.stringify({ error: { type: "unsupported_media_type" } }), { status: 415, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(refusing)("https://router.example/x")).rejects.toMatchObject({ code: "ohttp_refused", status: 415, details: { error: { type: "unsupported_media_type" } } });
    // With a transparency log, a configuration the log does not include is refused before anything is sent.
    let sent = 0;
    const counting = (async () => (sent++, new Response(null, { status: 500 }))) as unknown as typeof fetch;
    const refusingLog = { requireLogged: async () => Promise.reject(Object.assign(new Error("not in the log"), { code: "not_logged" })) };
    await expect(obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: config, fetch: counting, transparency: refusingLog })("https://router.example/x")).rejects.toMatchObject({ code: "not_logged" });
    expect(sent).toBe(0);
    const asked: [string, Uint8Array][] = [];
    const log = { requireLogged: async (kind: string, material: Uint8Array) => void asked.push([kind, material]) };
    const logged = obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: config, fetch: gateway(() => cat([1], vi(200), lp(new Uint8Array(0)), lp(enc.encode("ok")))), transparency: log });
    expect(await (await logged("https://router.example/x")).text()).toBe("ok");
    expect(await (await logged("https://router.example/x")).text()).toBe("ok");
    expect(asked).toEqual([["ohttp_key_config", config]]); // checked once, for the configuration in use

    // The relay's gateway choice goes in its query, never to the gateway.
    let url = "";
    const recording = (async (u: string) => ((url = u), new Response(null, { status: 403 }))) as unknown as typeof fetch;
    await obliviousFetch({ relayUrl: "https://relay.example/relay", keyConfig: config, gateway: "main", fetch: recording })("https://router.example/x").catch(() => undefined);
    expect(url).toBe("https://relay.example/relay?gateway=main");
  });
});
