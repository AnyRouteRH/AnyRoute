import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { ChunkedOHTTPClient } from "ohttp-ts";
import { AnyRoute, AnyRouteError, type KeySet } from "../packages/client/src/index.ts";
import { buyTokens } from "../packages/client/src/blind.ts";
import { CHUNKED_REQUEST_MEDIA_TYPE, obliviousFetch } from "../packages/client/src/ohttp.ts";
import { loadConfig } from "../src/config.ts";
import { blindNullifiers } from "../src/db/schema.ts";
import { authorizationHeader, decodeBase64 } from "../src/blind/privacy-token.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { BhttpError, decodeRequest, decodeResponse, encodeRequest, encodeResponse } from "../src/ohttp/bhttp.ts";
import { CHUNK_BYTES, MEDIA_CHUNKED_REQ, MEDIA_CHUNKED_RES, encodeResponseHead, openChunkedRequest, streamChunkedResponse } from "../src/ohttp/chunked.ts";
import { fetchKeyConfig, sendViaRelay } from "../src/ohttp/client.ts";
import { SUITE, generateGatewayKey, loadGatewayKey, parseKeyConfig } from "../src/ohttp/ohttp.ts";
import { loadConfig as loadRelayConfig } from "../relay/src/config.ts";
import { createRelay } from "../relay/src/relay.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";

// Chunked Oblivious HTTP (draft-ietf-ohai-chunked-ohttp-08): the gateway's chunked encapsulation, the relay passing it
// on as it arrives, and the TypeScript SDK decrypting it chunk by chunk, down to a stand-in upstream that can be held
// half-way through its answer.

setDefaultTimeout(60_000);

const LLAMA = MODELS.llama.slug;
const REPLY = "alpha bravo gamma delta epsilon theta lambda sigma omega";
const chat = { model: LLAMA, messages: [{ role: "user", content: "hello" }], max_tokens: 50 };
const OLD = "2025-01-15";
const claim = { source: "https://provider.example/terms", as_of: OLD };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SECRET_ALPHA = "alpha-relay-secret-value-0001";
const RELAYS = [
  { operator: "Alpha Relay Co", url: "https://relay.alpha.example/relay", key_id: "alpha-1", secret_sha256: sha(SECRET_ALPHA) },
  { operator: "Beta Relay Org", url: "https://relay.beta.example/relay", key_id: "beta-1", secret_sha256: sha("beta-relay-secret-value-0003") },
];
const OHTTP_ENV = { ANYROUTE_FEATURE_BLIND: "true", OHTTP_ENABLED: "true", BLIND_PURCHASE_RPM: "1000", RELAY_OPERATORS: JSON.stringify(RELAYS) };

/** The stand-in upstream holds its stream before content part `holdAt` until the test releases it. */
const upstream = { gate: null as Promise<void> | null, holdAt: 1, reached: -1 };
const PROVIDERS = [
  { id: "vendor", name: "Vendor", models: [MODELS.llama] },
  {
    id: "enclave",
    name: "Enclave",
    models: [MODELS.llama],
    tee: "dev" as const,
    reply: () => REPLY,
    holdStream: (part: number) => {
      upstream.reached = Math.max(upstream.reached, part);
      return part === upstream.holdAt && upstream.gate ? upstream.gate : undefined;
    },
  },
];

const shim = (h: Harness) => (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input), "http://router.test");
  return h.app.request(u.pathname + u.search, init);
}) as typeof fetch;

async function attestEnclave(h: Harness) {
  const declare = (id: string, json: unknown) => h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json });
  expect((await declare("enclave", { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } })).status).toBe(200);
  await runAttestor(h.ctx);
}

const streamOf = (pieces: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const p of pieces) if (p.length) ctl.enqueue(p);
      ctl.close();
    },
  });

/** A body re-cut into pieces of `size` bytes, so every parser meets lengths and chunks split across reads. */
function rechunk(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let rest = new Uint8Array(0);
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      while (rest.length < size) {
        const r = await reader.read();
        if (r.done) break;
        rest = new Uint8Array(Buffer.concat([rest, r.value]));
      }
      if (!rest.length) return ctl.close();
      ctl.enqueue(rest.slice(0, size));
      rest = rest.slice(size);
    },
  });
}

/** Where each chunk of an encapsulated response sits: after the 16-byte nonce, a varint length and the sealed chunk; a zero length marks the final one. */
function responseFrames(b: Uint8Array) {
  const out: { at: number; ct: number; end: number; final: boolean }[] = [];
  let at = 16;
  while (at < b.length) {
    const size = 1 << (b[at] >> 6);
    let len = b[at] & 0x3f;
    for (let i = 1; i < size; i++) len = len * 256 + b[at + i];
    if (len === 0) {
      out.push({ at, ct: at + size, end: b.length, final: true });
      break;
    }
    out.push({ at, ct: at + size, end: at + size + len, final: false });
    at += size + len;
  }
  return out;
}

const content = (c: unknown) => ((c as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]?.delta?.content ?? "") as string;

/** Iterate a chat stream to its end or its error; what arrived before either is kept. */
async function drain(it: AsyncIterator<Record<string, unknown>>) {
  let text = "";
  try {
    for (;;) {
      const n = await it.next();
      if (n.done) return { text, error: null as AnyRouteError | null };
      text += content(n.value);
    }
  } catch (e) {
    return { text, error: e as AnyRouteError };
  }
}

// ---- framing ---------------------------------------------------------------------------------------------------------

describe("chunk framing", () => {
  let key: Awaited<ReturnType<typeof loadGatewayKey>>;
  let config: Uint8Array;
  beforeAll(async () => {
    const g = await generateGatewayKey(7);
    key = await loadGatewayKey(7, g.publicKey, g.privateKey);
    config = g.config;
  });

  /** A gateway in miniature: opens the chunked request with the gateway code and answers with `answer`. */
  const gatewayStub = (answer: (req: ReturnType<typeof decodeRequest>, responder: Awaited<ReturnType<Awaited<ReturnType<typeof openChunkedRequest>>["responder"]>>) => Promise<ReadableStream<Uint8Array>>, seen: { requestFrames?: number } = {}, cut = 7) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("content-type")).toBe(MEDIA_CHUNKED_REQ);
      const body = new Uint8Array(await new Response(init!.body).arrayBuffer());
      seen.requestFrames = responseFrames(body.subarray(39 - 16)).length; // the same framing after the 39-byte header
      const opened = await openChunkedRequest(key, body, 1 << 24);
      const stream = await answer(decodeRequest(opened.request), await opened.responder());
      return new Response(cut ? rechunk(stream, cut) : stream, { headers: { "content-type": MEDIA_CHUNKED_RES } });
    }) as typeof fetch;

  test("a request of several chunks and a streamed response of many round-trip, whatever the transport cuts them into", async () => {
    const big = Uint8Array.from({ length: 40_000 }, (_, i) => (i * 31) % 256); // three request chunks
    const pieces = [Uint8Array.of(1), new Uint8Array(100).fill(2), new Uint8Array(20_000).fill(3), new Uint8Array(0), new Uint8Array(5_000).fill(4)];
    for (const cut of [1, 7, 4096, 1 << 20]) {
      const seen: { requestFrames?: number } = {};
      const f = obliviousFetch({
        relayUrl: "https://relay.test/relay",
        keyConfig: config,
        fetch: gatewayStub(
          async (req, responder) => {
            expect(req).toMatchObject({ method: "POST", path: "/echo?x=1", authority: "" });
            expect(req.headers).toContainEqual(["x-thing", "yes"]);
            expect(Buffer.from(req.body).equals(Buffer.from(big))).toBe(true);
            return streamChunkedResponse(responder, { status: 201, headers: [["content-type", "application/octet-stream"], ["x-echo", req.path]] }, streamOf(pieces), { padTo: 256, maxBytes: 1 << 20 });
          },
          seen,
          cut,
        ),
      });
      const res = await f("https://router.invalid/echo?x=1", { method: "POST", headers: { "x-thing": "yes" }, body: big });
      expect(seen.requestFrames).toBe(3);
      expect(res.status).toBe(201);
      expect(res.headers.get("x-echo")).toBe("/echo?x=1");
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.concat(pieces))).toBe(true);
    }
  });

  test("a whole message (known length, as the gateway sends errors) spans chunks too, and ohttp-ts's own reader agrees with ours", async () => {
    const body = new Uint8Array(50_000).fill(9);
    const f = obliviousFetch({ relayUrl: "https://relay.test/relay", keyConfig: config, fetch: gatewayStub(async (_req, responder) => streamOf([await responder.whole(encodeResponse({ status: 404, headers: [["x-a", "b"]], body }, { padTo: 256 }))])) });
    const res = await f("https://router.invalid/x");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-a")).toBe("b");
    expect((await res.arrayBuffer()).byteLength).toBe(body.length);

    // The library's buffered client opens what the gateway streams, and the router's decoder reads the message.
    const client = new ChunkedOHTTPClient(SUITE, parseKeyConfig(config), { padding: 0 });
    const sent = await client.encapsulate(encodeRequest({ method: "GET", path: "/y" }));
    const opened = await openChunkedRequest(key, sent.encapsulatedRequest, 1 << 24);
    expect(decodeRequest(opened.request).path).toBe("/y");
    const out = new Uint8Array(await new Response(streamChunkedResponse(await opened.responder(), { status: 200, headers: [["content-type", "text/plain"]] }, streamOf([new TextEncoder().encode("one "), new TextEncoder().encode("two")]), { padTo: 64, maxBytes: 1024 })).arrayBuffer());
    const inner = decodeResponse(await client.decapsulateResponse(sent.createResponseContext, out));
    expect(inner.status).toBe(200);
    expect(new TextDecoder().decode(inner.body)).toBe("one two");
    // Chunks are at most 16 KiB of plaintext, and the whole binary HTTP message is padded to the block.
    const frames = responseFrames(out);
    expect(frames.at(-1)!.final).toBe(true);
    expect(frames.every((fr) => fr.end - fr.ct <= CHUNK_BYTES + 16)).toBe(true);
  });

  test("the gateway refuses a request without its final chunk, or with an altered chunk", async () => {
    const client = new ChunkedOHTTPClient(SUITE, parseKeyConfig(config), { padding: 0 });
    const sent = await client.encapsulate(encodeRequest({ method: "POST", path: "/z", body: new Uint8Array(20_000).fill(5) }));
    const frames = responseFrames(sent.encapsulatedRequest.subarray(39 - 16));
    const finalAt = 39 - 16 + frames.find((fr) => fr.final)!.at;
    await expect(openChunkedRequest(key, sent.encapsulatedRequest.subarray(0, finalAt), 1 << 24)).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    const altered = sent.encapsulatedRequest.slice();
    altered[60] ^= 1;
    await expect(openChunkedRequest(key, altered, 1 << 24)).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    expect(() => encodeResponseHead(200, [["bad name", "x"]])).toThrow(BhttpError);
    expect(() => encodeResponseHead(200, [["x", "line\nbreak"]])).toThrow(BhttpError);
  });

  test("a response the gateway cuts off (too large, or the upstream failed) is reported as truncated, after what did arrive", async () => {
    for (const failure of ["too-large", "upstream-error"] as const) {
      let pulls = 0;
      const upstreamBody = new ReadableStream<Uint8Array>(
        {
          pull(ctl) {
            if (pulls++ === 0) ctl.enqueue(new TextEncoder().encode("first "));
            else if (failure === "too-large") ctl.enqueue(new Uint8Array(2048));
            else ctl.error(new Error("upstream went away"));
          },
        },
        { highWaterMark: 0 },
      );
      // Passed straight through: a stream that fails loses what it had not handed over yet.
      const f = obliviousFetch({ relayUrl: "https://relay.test/relay", keyConfig: config, fetch: gatewayStub(async (_req, responder) => streamChunkedResponse(responder, { status: 200, headers: [] }, upstreamBody, { padTo: 0, maxBytes: 1024 }), {}, 0) });
      const res = await f("https://router.invalid/x");
      const reader = res.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first ");
      await expect(reader.read()).rejects.toMatchObject({ code: "ohttp_truncated" });
    }
  });
});

// ---- through a relay and the gateway ---------------------------------------------------------------------------------

describe("a streamed completion through a relay and the gateway", () => {
  let h: Harness;
  let routerServer: ReturnType<typeof Bun.serve>;
  let relayServer: ReturnType<typeof Bun.serve>;
  let relay: ReturnType<typeof createRelay>;
  let relayUrl: string;
  let keyConfig: Uint8Array;
  let receiptKeys: KeySet;
  let tokens: string[] = [];
  let next = 0;
  const toGateway: { url: string; headers: Record<string, string> }[] = [];
  const fromGateway: Uint8Array[] = [];
  const spent = async () => (await h.ctx.db.select().from(blindNullifiers)).length;

  /** An SDK client on the unlinkable lane, paid with a fresh token, sending through `via` (the relay by default). */
  const sdk = (via?: typeof fetch) => new AnyRoute({ baseUrl: "https://router.invalid", privateToken: tokens[next++], fetch: obliviousFetch({ relayUrl, keyConfig, fetch: via }), receiptKeys, lane: "unlinkable" });
  /** A fetch to the relay that rewrites the encapsulated response before the SDK reads it. */
  const rewriting = (edit: (b: Uint8Array) => Uint8Array[]) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(url, init);
      return new Response(streamOf(edit(new Uint8Array(await res.arrayBuffer()))), { status: res.status, headers: res.headers });
    }) as typeof fetch;

  beforeAll(async () => {
    h = await startRouter({ env: { ...OHTTP_ENV, OHTTP_CHUNKED_ENABLED: "true" }, providers: PROVIDERS });
    routerServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, server) => h.app.fetch(req, server as never) });
    const base = `http://127.0.0.1:${routerServer.port}`;
    const relayCfg = loadRelayConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "router", url: `${base}/api/v1/ohttp/gateway`, credential: `alpha-1:${SECRET_ALPHA}` }]), RELAY_CHUNKED_ENABLED: "true" });
    // The relay's own fetch, watched: what it sends the gateway, and every byte it gets back.
    relay = createRelay(relayCfg, (async (url: string, init?: RequestInit) => {
      toGateway.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
      const res = await fetch(url, init);
      if (!res.body) return res;
      const [mine, theirs] = res.body.tee();
      void (async () => {
        const r = mine.getReader();
        for (;;) {
          const x = await r.read().catch(() => ({ done: true, value: undefined }));
          if (x.done || !x.value) break;
          fromGateway.push(x.value);
        }
      })();
      return new Response(theirs, { status: res.status, headers: res.headers });
    }) as never);
    relayServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: relay.handle, idleTimeout: 255 });
    relayUrl = `http://127.0.0.1:${relayServer.port}/relay`;
    keyConfig = (await fetchKeyConfig(base)).encoded;
    receiptKeys = (await (await h.request("/.well-known/anyroute-receipt-keys.json")).json()) as KeySet;
    await attestEnclave(h);
    const k = await h.fundedKey(10n);
    tokens = (await buyTokens({ baseUrl: "http://router.test", apiKey: k.secret, denomination: 10_000, count: 12, fetch: shim(h) })).tokens;
  });
  afterAll(async () => {
    relayServer?.stop(true);
    routerServer?.stop(true);
    await h?.close();
  });

  test("the first token reaches the client while the upstream is still producing, and the relay carries only ciphertext", async () => {
    let release!: () => void;
    upstream.gate = new Promise<void>((r) => (release = r));
    upstream.reached = -1;
    let released = false;
    try {
      const before = { requests: relay.counters.requests, ok: relay.counters.gateway.ok };
      fromGateway.length = 0;
      const stream = await sdk().chat.completions.stream(chat);
      const it = stream[Symbol.asyncIterator]();
      let first = "";
      while (!first) {
        const n = await it.next();
        expect(n.done).toBeFalsy();
        first = content(n.value);
      }
      // The upstream sent one part and is held before the next: this token crossed the relay before it finished.
      expect(first).toBe(REPLY.slice(0, 6));
      expect(upstream.reached).toBe(1);
      expect(released).toBe(false);
      expect(relay.counters.inflight).toBe(1); // the relay is still carrying the stream
      released = true;
      release();
      const rest = await drain(it);
      expect(rest.error).toBeNull();
      expect(first + rest.text).toBe(REPLY);

      const meta = await stream.meta();
      expect(meta.lane).toBe("unlinkable");
      expect(meta.receipt?.payload).toMatchObject({ lane: "unlinkable", disclosure: "attested", payer: null, provider: "enclave" });
      expect(meta.receiptVerification?.valid).toBe(true);

      // The relay forwarded its own headers and the ciphertext, and passed back bytes in which no word of the answer appears.
      const last = toGateway.at(-1)!;
      expect(Object.keys(last.headers).sort()).toEqual(["accept", "authorization", "content-type", "incremental", "user-agent"]);
      expect(last.headers).toMatchObject({ "content-type": MEDIA_CHUNKED_REQ, accept: MEDIA_CHUNKED_RES, incremental: "?1" });
      const carried = Buffer.concat(fromGateway);
      expect(carried.length).toBeGreaterThan(REPLY.length);
      for (const word of REPLY.split(" ").filter((w) => w.length >= 5)) expect(carried.includes(word)).toBe(false);
      expect(relay.counters).toMatchObject({ requests: before.requests + 1, inflight: 0, gateway: { ok: before.ok + 1 } });
    } finally {
      if (!released) release();
      upstream.gate = null;
    }
  });

  test("a stream cut off before its final chunk is reported as truncated, not as a shorter answer", async () => {
    // Cut just before the final chunk: every token arrived, but the end cannot be confirmed.
    const s1 = await sdk(rewriting((b) => [b.subarray(0, responseFrames(b).find((f) => f.final)!.at)])).chat.completions.stream(chat);
    const r1 = await drain(s1[Symbol.asyncIterator]());
    expect(r1.text).toBe(REPLY);
    expect(r1.error).toBeInstanceOf(AnyRouteError);
    expect(r1.error?.code).toBe("ohttp_truncated");
    await expect(s1.meta()).rejects.toMatchObject({ code: "ohttp_truncated" });

    // Cut part way: what arrived is delivered, then the same error.
    const s2 = await sdk(rewriting((b) => [b.subarray(0, responseFrames(b)[4].end)])).chat.completions.stream(chat);
    const r2 = await drain(s2[Symbol.asyncIterator]());
    expect(REPLY.startsWith(r2.text)).toBe(true);
    expect(r2.text.length).toBeLessThan(REPLY.length);
    expect(r2.error?.code).toBe("ohttp_truncated");

    // Cut inside a chunk, or inside the final chunk: either way it is refused.
    for (const at of [(b: Uint8Array) => responseFrames(b)[3].end - 3, (b: Uint8Array) => b.length - 1]) {
      const s = await sdk(rewriting((b) => [b.subarray(0, at(b))])).chat.completions.stream(chat);
      const r = await drain(s[Symbol.asyncIterator]());
      expect(["ohttp_truncated", "ohttp_decrypt_failed"]).toContain(r.error?.code);
    }
  });

  test("an altered or reordered chunk is rejected, and an altered request is refused before anything is spent", async () => {
    const flip = (b: Uint8Array) => {
      const c = b.slice();
      const f = responseFrames(c)[3];
      c[f.ct + 2] ^= 0x40;
      return [c];
    };
    const s1 = await sdk(rewriting(flip)).chat.completions.stream(chat);
    const r1 = await drain(s1[Symbol.asyncIterator]());
    expect(r1.error?.code).toBe("ohttp_decrypt_failed");
    expect(REPLY.startsWith(r1.text)).toBe(true);

    const swap = (b: Uint8Array) => {
      const [, , x, y] = responseFrames(b);
      return [b.subarray(0, x.at), b.subarray(y.at, y.end), b.subarray(x.at, x.end), b.subarray(y.end)];
    };
    const s2 = await sdk(rewriting(swap)).chat.completions.stream(chat);
    expect((await drain(s2[Symbol.asyncIterator]())).error?.code).toBe("ohttp_decrypt_failed");

    // The header chunk itself: the call fails before any response exists.
    const head = (b: Uint8Array) => {
      const c = b.slice();
      c[responseFrames(c)[0].ct] ^= 1;
      return [c];
    };
    await expect(sdk(rewriting(head)).chat.completions.stream(chat)).rejects.toMatchObject({ code: "ohttp_decrypt_failed" });

    // A request altered on the way does not open at the gateway: a plain 422, passed on by the relay; nothing spent.
    const before = await spent();
    const alterRequest = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = new Uint8Array(await new Response(init!.body).arrayBuffer());
      body[body.length - 3] ^= 1;
      return fetch(url, { ...init, body });
    }) as typeof fetch;
    await expect(sdk(alterRequest).chat.completions.stream(chat)).rejects.toMatchObject({ code: "ohttp_refused", status: 422 });
    expect(await spent()).toBe(before);
  });

  test("non-streamed calls, gateway errors and replays work over chunked OHTTP too", async () => {
    const c = sdk();
    const res = await c.chat.completions.create(chat);
    expect(res.anyroute.lane).toBe("unlinkable");
    expect(res.anyroute.receiptVerification?.valid).toBe(true);
    expect((res.choices as { message: { content: string } }[])[0].message.content).toBe(REPLY);

    const f = obliviousFetch({ relayUrl, keyConfig });
    const denied = await f("https://router.invalid/api/v1/keys", { method: "POST", body: "{}" });
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as { error: { type: string } }).error.type).toBe("route_not_allowed");

    // The same encapsulated request sent twice is answered, the second time, with an encapsulated 409.
    const client = new ChunkedOHTTPClient(SUITE, parseKeyConfig(keyConfig), { padding: 0 });
    const sent = await client.encapsulate(encodeRequest({ method: "GET", path: "/api/v1/models" }));
    const post = async () => {
      const r = await fetch(relayUrl, { method: "POST", headers: { "content-type": MEDIA_CHUNKED_REQ }, body: sent.encapsulatedRequest });
      expect(r.headers.get("content-type")).toBe(MEDIA_CHUNKED_RES);
      return decodeResponse(await client.decapsulateResponse(sent.createResponseContext, new Uint8Array(await r.arrayBuffer())));
    };
    expect((await post()).status).toBe(200);
    const again = await post();
    expect(again.status).toBe(409);
    expect(JSON.parse(new TextDecoder().decode(again.body)).error.type).toBe("replayed_request");
  });

  test("non-chunked Oblivious HTTP is unchanged: a whole response, and streaming still refused", async () => {
    const base = `http://127.0.0.1:${routerServer.port}`;
    const config = parseKeyConfig(keyConfig);
    const token = tokens[next++];
    const send = (body: unknown) =>
      sendViaRelay({ relayUrl, keyConfig: config, method: "POST", path: "/api/v1/chat/completions", headers: [["content-type", "application/json"], ["authorization", authorizationHeader(decodeBase64(token)!)]], body: JSON.stringify(body) });
    const streamed = await send({ ...chat, stream: true, provider: { lane: "unlinkable" } });
    expect(streamed.status).toBe(400);
    expect(streamed.json<{ error: { type: string } }>().error.type).toBe("stream_unsupported");
    const whole = await send({ ...chat, provider: { lane: "unlinkable" } });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("x-anyroute-lane")).toBe("unlinkable");
    expect(whole.json<{ choices: { message: { content: string } }[] }>().choices[0].message.content).toBe(REPLY);
    // The relay list says the gateway takes chunked requests.
    const relays = (await (await fetch(`${base}/api/v1/relays`)).json()) as { data: { gateway: Record<string, unknown> } };
    expect(relays.data.gateway.chunked).toEqual({ request: MEDIA_CHUNKED_REQ, response: MEDIA_CHUNKED_RES });
  });
});

// ---- off by default --------------------------------------------------------------------------------------------------

describe("off by default", () => {
  test("the flag defaults to off, and means nothing without the gateway", () => {
    expect(loadConfig({}).ohttp.chunked).toBe(false);
    expect(loadConfig({ OHTTP_CHUNKED_ENABLED: "true" }).ohttp).toMatchObject({ enabled: false, chunked: false });
    expect(loadConfig({ ...OHTTP_ENV }).ohttp).toMatchObject({ enabled: true, chunked: false });
    expect(loadConfig({ ...OHTTP_ENV, OHTTP_CHUNKED_ENABLED: "true" }).ohttp).toMatchObject({ enabled: true, chunked: true });
    const relayEnv = { RELAY_GATEWAYS: JSON.stringify([{ name: "g", url: "https://gateway.example/api/v1/ohttp/gateway" }]) };
    expect(loadRelayConfig(relayEnv).chunked).toBe(false);
    expect(loadRelayConfig({ ...relayEnv, RELAY_CHUNKED_ENABLED: "true" }).chunked).toBe(true);
    expect(() => loadRelayConfig({ ...relayEnv, RELAY_CHUNKED_ENABLED: "sometimes" })).toThrow(/RELAY_CHUNKED_ENABLED/);
  });

  test("with the gateway on and chunking off, a chunked request is refused like any other media type, before it is read", async () => {
    const h = await startRouter({ env: OHTTP_ENV, providers: PROVIDERS });
    try {
      const res = await h.request("/api/v1/ohttp/gateway", { method: "POST", headers: { "content-type": CHUNKED_REQUEST_MEDIA_TYPE }, body: new Uint8Array(64) });
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Expected content-type message/ohttp-req.");
      const relays = (await (await h.request("/api/v1/relays")).json()) as { data: { gateway: Record<string, unknown> } };
      expect(relays.data.gateway.chunked).toBeUndefined();
      // A relay left at its default refuses it too, without contacting any gateway.
      let contacted = 0;
      const r = createRelay(loadRelayConfig({ RELAY_GATEWAYS: JSON.stringify([{ name: "g", url: "https://gateway.example/api/v1/ohttp/gateway" }]) }), (async () => (contacted++, new Response(null))) as never);
      const refused = await r.handle(new Request("https://relay.test/relay", { method: "POST", headers: { "content-type": CHUNKED_REQUEST_MEDIA_TYPE }, body: new Uint8Array(64) }));
      expect(refused.status).toBe(415);
      expect(contacted).toBe(0);
    } finally {
      await h.close();
    }
  });
});
