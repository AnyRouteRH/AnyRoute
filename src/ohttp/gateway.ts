import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { log, safeEqual, sha256 } from "../lib/util.ts";
import { addressBucket } from "../api/common.ts";
import { BhttpError, DEFAULT_LIMITS, decodeRequest, encodeResponse, utf8, type HeaderList } from "./bhttp.ts";
import { GENESIS_HASH, OhttpKeys, keyLog, type GatewayKey } from "./keys.ts";
import { markFromGateway, type RelayIdentity } from "./origin.ts";
import { MEDIA_KEYS, MEDIA_REQ, MEDIA_RES, OHTTPErrorCode, REQUEST_PREFIX, isOHTTPError, openRequest, serializeKeyConfigList, type OpenedRequest } from "./ohttp.ts";
import { INCREMENTAL_HEADERS, MEDIA_CHUNKED_REQ, MEDIA_CHUNKED_RES, openChunkedRequest, streamChunkedResponse, type OpenedChunkedRequest } from "./chunked.ts";
import { ReplayGuard } from "./replay.ts";

// The Oblivious HTTP gateway (RFC 9458) and the documents around it.
//
//   GET  /api/v1/ohttp/keys       application/ohttp-keys: the key configuration clients encapsulate to
//   GET  /.well-known/ohttp-gateway   the same, at the well-known location (RFC 9540)
//   POST /api/v1/ohttp/gateway    message/ohttp-req in, message/ohttp-res out (also at the well-known path); with
//                                 OHTTP_CHUNKED_ENABLED also message/ohttp-chunked-req in, message/ohttp-chunked-res out
//   GET  /api/v1/ohttp/key-list   the key history as a document signed with the receipt key, with a hash chain
//   GET  /api/v1/relays           the relays clients can use, by operator
//
// Only registered when OHTTP_ENABLED is on. The gateway unwraps a binary HTTP request, hands it to the router's own
// routes (an allow-list of them), and wraps whatever comes back. It logs nothing about the request.

const KEYS_PATHS = ["/api/v1/ohttp/keys", "/.well-known/ohttp-gateway"];
const GATEWAY_PATHS = ["/api/v1/ohttp/gateway", "/.well-known/ohttp-gateway"];
const PROBLEM_KEY = "https://iana.org/assignments/http-problem-types#ohttp-key";

/** The routes a gateway request may reach: method and exact path. Everything else is a 404 inside the encapsulation. */
const ROUTES: readonly { method: string; path: string; stream?: boolean }[] = [
  { method: "POST", path: "/api/v1/chat/completions", stream: true },
  { method: "POST", path: "/v1/chat/completions", stream: true },
  { method: "POST", path: "/api/v1/completions", stream: true },
  { method: "POST", path: "/v1/completions", stream: true },
  { method: "POST", path: "/api/v1/embeddings" },
  { method: "POST", path: "/v1/embeddings" },
  { method: "POST", path: "/api/v1/blind/purchase" },
  { method: "GET", path: "/api/v1/blind/keys" },
  { method: "GET", path: "/api/v1/models" },
  { method: "GET", path: "/v1/models" },
];

/** Request fields that reach the router. Anything else a client sends (user agent, language, cookies, trace ids) is dropped. */
const FORWARD_REQUEST_HEADERS = new Set(["authorization", "content-type", "accept", "x-anyroute-lane", "x-anyroute-lane-downgrade", "x-anyroute-disclosure-max"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "set-cookie"]);

const relayNoStore = { "cache-control": "no-store" };

/** An HTTP error outside the encapsulation (RFC 9458 section 5.2): the request could not be unwrapped. */
function plain(status: number, type: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: status, message, type } }), { status, headers: { "content-type": "application/json", ...relayNoStore, ...extra } });
}

function keyProblem(title: string): Response {
  return new Response(JSON.stringify({ type: PROBLEM_KEY, title }), { status: 422, headers: { "content-type": "application/problem+json", ...relayNoStore } });
}

/** A JSON error the gateway produces itself for the inner response (the request was unwrapped, so it is encapsulated). */
function innerError(status: number, type: string, message: string) {
  return { status, headers: [["content-type", "application/json"]] as HeaderList, body: utf8(JSON.stringify({ error: { code: status, message, type } })) };
}

/** Read a request body of at most `max` bytes, or null if it is longer. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return chunks.length === 1 ? chunks[0] : new Uint8Array(Buffer.concat(chunks));
}

/** The relay behind an `Authorization: Bearer <key_id>:<secret>` header, null when there is none, or a 401. */
export function authenticateRelay(ctx: Ctx, header: string | undefined): RelayIdentity | null {
  if (header === undefined) return null;
  const m = /^Bearer ([A-Za-z0-9._-]{1,64}):(\S{1,256})$/i.exec(header.trim());
  const relay = m ? ctx.cfg.ohttp.relays.find((r) => r.keyId === m[1]) : undefined;
  // Compare the hash of the presented secret with the stored one whether or not the key id exists.
  const presented = m ? sha256(m[2]) : sha256("");
  const ok = safeEqual(presented, relay?.secretSha256 ?? "0".repeat(64)) && !!relay;
  if (!ok || !relay) throw new ApiError(401, "Relay credential not recognised.", "relay_auth_invalid");
  return { operator: relay.operator, keyId: relay.keyId, independent: relay.operator.toLowerCase() !== ctx.cfg.ohttp.gatewayOperator.toLowerCase() };
}

/** What the inner request is dispatched as, or the encapsulated error to answer with. */
function planDispatch(req: ReturnType<typeof decodeRequest>, chunked = false): { url: string; init: RequestInit } | ReturnType<typeof innerError> {
  if (req.headers.some(([n, v]) => n === "expect" && /100-continue/i.test(v))) return innerError(400, "invalid_request", "Expect: 100-continue cannot be used with Oblivious HTTP.");
  if (!req.path.startsWith("/") || req.path.startsWith("//") || req.path.includes("\\")) return innerError(400, "invalid_request", "The request path is not valid.");
  let url: URL;
  try {
    url = new URL(req.path, "http://gateway.internal");
  } catch {
    return innerError(400, "invalid_request", "The request path is not valid.");
  }
  const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
  if (url.host !== "gateway.internal" || !route) return innerError(404, "route_not_allowed", `The Oblivious HTTP gateway does not serve ${req.method} ${url.pathname}. See /api/v1/relays for what it does.`);
  const headers = new Headers();
  for (const [name, value] of req.headers) if (FORWARD_REQUEST_HEADERS.has(name)) headers.append(name, value);
  if (route.stream && req.body.length && !chunked) {
    // A response is encapsulated as a whole, so a stream could not be delivered as it is produced. Refuse before the
    // request reaches the router, so nothing is spent on it.
    try {
      const parsed = JSON.parse(new TextDecoder().decode(req.body)) as { stream?: unknown };
      if (parsed && typeof parsed === "object" && parsed.stream === true) return innerError(400, "stream_unsupported", 'Streaming is not available through the Oblivious HTTP gateway: the response is encapsulated as a whole. Send "stream": false.');
    } catch {
      /* not JSON: the route reports that itself */
    }
  }
  return { url: url.pathname + url.search, init: { method: req.method, headers, ...(req.method === "GET" || req.method === "HEAD" || !req.body.length ? {} : { body: req.body }) } };
}

async function readResponse(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  return readCapped(res.body, max);
}

export function ohttpRoutes(app: Hono, ctx: Ctx) {
  const keys = ctx.ohttp!;
  const cfg = ctx.cfg.ohttp;
  const replay = new ReplayGuard();
  // Room for the binary HTTP message in either direction plus its padding.
  const maxMessage = Math.max(cfg.maxRequestBytes, cfg.maxResponseBytes) + 65_536;

  // ---- key configuration ---------------------------------------------------------------------------------------
  const keyConfig = async (c: Context) => {
    const k = await keys.serving();
    if (!k) return c.json(new ApiError(503, "The gateway has no usable key right now.", "ohttp_no_key").toJSON(), 503, { "retry-after": "30" });
    const maxAge = Math.min(3600, Math.floor(cfg.keyGraceSeconds / 2));
    return new Response(serializeKeyConfigList([OhttpKeys.config(k)]), { headers: { "content-type": MEDIA_KEYS, "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-cache" } });
  };
  for (const p of KEYS_PATHS) app.get(p, keyConfig);

  // ---- signed key history --------------------------------------------------------------------------------------
  app.get("/api/v1/ohttp/key-list", async (c) => {
    await keys.ensureCurrent();
    const history = await keys.history();
    const chain = keyLog(history);
    const shown = history.slice(-512);
    const offset = history.length - shown.length;
    const payload = {
      v: 1,
      kind: "ohttp-key-list",
      issued: new Date().toISOString(),
      router: ctx.cfg.publicUrl,
      gateway: { url: `${ctx.cfg.publicUrl}/api/v1/ohttp/gateway`, keys_url: `${ctx.cfg.publicUrl}/api/v1/ohttp/keys`, media_type: MEDIA_KEYS },
      suites: [{ kem: "DHKEM(X25519, HKDF-SHA256)", kem_id: 32, kdf: "HKDF-SHA256", kdf_id: 1, aead: "AES-128-GCM", aead_id: 1 }],
      epoch_seconds: cfg.keyEpochSeconds,
      grace_seconds: cfg.keyGraceSeconds,
      keys: shown.map((k, i) => ({
        epoch: k.epoch,
        key_id: k.keyId,
        kem_id: k.kemId,
        public_key: k.publicKey,
        config: k.config,
        config_sha256: k.configSha256,
        status: keys.status(k),
        valid_from: k.validFrom.toISOString(),
        accept_until: k.acceptUntil.toISOString(),
        private_key_destroyed: !k.privateEnc,
        entry_hash: chain.entries[offset + i].entry_hash,
      })),
      log: { algorithm: "sha256-chain", entries: history.length, head: chain.head, first_prev: offset > 0 ? chain.entries[offset - 1].entry_hash : GENESIS_HASH },
      relays: relayList(ctx),
    };
    const signed = ctx.signer.sign(payload);
    c.header("cache-control", "no-store");
    return c.json({ data: payload, signature: { alg: "Ed25519", key_id: signed.keyId, sig: signed.sig } });
  });

  // ---- relays --------------------------------------------------------------------------------------------------
  app.get("/api/v1/relays", (c) => {
    const relays = relayList(ctx);
    c.header("cache-control", "public, max-age=300");
    return c.json({
      data: {
        lane: "unlinkable",
        gateway: { operator: cfg.gatewayOperator, url: `${ctx.cfg.publicUrl}/api/v1/ohttp/gateway`, keys_url: `${ctx.cfg.publicUrl}/api/v1/ohttp/keys`, key_list_url: `${ctx.cfg.publicUrl}/api/v1/ohttp/key-list`, ...(cfg.chunked ? { chunked: { request: MEDIA_CHUNKED_REQ, response: MEDIA_CHUNKED_RES } } : {}) },
        relays,
        independent_operators: new Set(relays.filter((r) => r.independent).map((r) => r.operator.toLowerCase())).size,
        note: "Choose a relay whose operator is not the gateway operator. The unlinkable lane is only served through a relay marked independent, and only for requests paid with a blind token.",
      },
    });
  });

  // ---- the gateway ---------------------------------------------------------------------------------------------
  const gateway = async (c: Context): Promise<Response> => {
    const raw = c.req.raw;
    const type = (raw.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    // Chunked Oblivious HTTP (chunked.ts) is accepted only when switched on; otherwise it is refused like any other type.
    const chunked = cfg.chunked && type === MEDIA_CHUNKED_REQ;
    if (type !== MEDIA_REQ && !chunked) return plain(415, "unsupported_media_type", `Expected content-type ${MEDIA_REQ}.`);
    let relay: RelayIdentity | null;
    try {
      relay = authenticateRelay(ctx, raw.headers.get("authorization") ?? undefined);
    } catch (e) {
      const err = e as ApiError;
      return plain(err.status, err.type, err.message);
    }
    // Relays are limited by identity, everyone else by address (a relay's address means nothing to the client behind it).
    const from = addressBucket(c, ctx.cfg);
    const limit = await ctx.limiter.take(relay ? `ohttp-gw:relay:${relay.keyId}` : `ohttp-gw:ip:${from.id}`, 1, relay ? cfg.relayRpm : from.scale(cfg.directRpm), 60_000);
    if (!limit.ok) return plain(429, "rate_limited", "Too many requests.", { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) });

    if (Number(raw.headers.get("content-length") ?? 0) > cfg.maxRequestBytes) return plain(413, "payload_too_large", "Request body is too large.");
    const body = await readCapped(raw.body, cfg.maxRequestBytes);
    if (!body) return plain(413, "payload_too_large", "Request body is too large.");

    // header (7) + encapsulated key (32) + the AEAD tag (16) is the least an encapsulated request can be.
    if (body.length < REQUEST_PREFIX + 16) return plain(400, "invalid_request", "The encapsulated request is too short.");
    let opened: OpenedRequest | OpenedChunkedRequest | undefined;
    let key: GatewayKey | undefined;
    try {
      const candidates = await keys.accepting(body[0]);
      if (!candidates.length) return keyProblem("key identifier unknown");
      for (const k of candidates) {
        try {
          opened = chunked ? await openChunkedRequest(await keys.privateKey(k), body, maxMessage) : await openRequest(await keys.privateKey(k), body, maxMessage);
          key = k;
          break;
        } catch (e) {
          if (!isOHTTPError(e) || e.code !== OHTTPErrorCode.DecryptionFailed) throw e;
        }
      }
      if (!opened) return keyProblem("request could not be decrypted with the key it names");
    } catch (e) {
      if (isOHTTPError(e)) {
        if (e.code === OHTTPErrorCode.UnsupportedCipherSuite) return plain(422, "unsupported_suite", "The ciphersuite is not offered by this gateway.");
        if (e.code === OHTTPErrorCode.MessageTooLarge) return plain(413, "payload_too_large", "Request body is too large.");
        if (e.code === OHTTPErrorCode.UnknownKeyId || e.code === OHTTPErrorCode.DecryptionFailed) return keyProblem("key identifier unknown");
        return plain(400, "invalid_request", "The encapsulated request is malformed.");
      }
      throw e;
    }

    // From here the request is unwrapped: every outcome is an encapsulated response (a chunked one for a chunked request).
    const responder = chunked ? await (opened as OpenedChunkedRequest).responder() : null;
    const respond = async (inner: { status: number; headers: HeaderList; body: Uint8Array }) => {
      const message = encodeResponse(inner, { padTo: cfg.padBytes });
      if (responder) return new Response(await responder.whole(message), { status: 200, headers: { "content-type": MEDIA_CHUNKED_RES, ...relayNoStore, ...INCREMENTAL_HEADERS } });
      return new Response(await (opened as OpenedRequest).respond(message), { status: 200, headers: { "content-type": MEDIA_RES, ...relayNoStore } });
    };

    if (replay.seen(createHash("sha256").update(body.subarray(0, REQUEST_PREFIX)).digest("hex"), Math.max(0, key!.acceptUntil.getTime() - keys.now()))) return respond(innerError(409, "replayed_request", "This encapsulated request was already processed."));

    let decoded: ReturnType<typeof decodeRequest>;
    try {
      decoded = decodeRequest(opened.request, DEFAULT_LIMITS);
    } catch (e) {
      if (e instanceof BhttpError) return respond(innerError(400, "invalid_request", `Invalid binary HTTP request: ${e.message}.`));
      throw e;
    }
    const plan = planDispatch(decoded, chunked);
    if ("status" in plan) return respond(plan);

    let res: Response;
    try {
      const inner = new Request(`http://gateway.internal${plan.url}`, { ...plan.init, signal: raw.signal });
      markFromGateway(inner, { relay });
      res = await app.fetch(inner);
    } catch (e) {
      log.error("ohttp dispatch failed", { error: (e as Error)?.message });
      return respond(innerError(502, "internal", "The router could not handle the request."));
    }
    const headers: HeaderList = [];
    res.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name) && !name.startsWith("proxy-")) headers.push([name, value]);
    });
    const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
    if (responder) {
      // Sent as it is produced: a streamed completion reaches the client chunk by chunk. A body that says up front it
      // is too large is refused as a whole one is; one that grows too large on the way is cut off (no final chunk).
      if (Number(res.headers.get("content-length") ?? 0) > cfg.maxResponseBytes) {
        void res.body?.cancel().catch(() => undefined);
        return respond(innerError(502, "response_too_large", "The response is larger than the gateway will encapsulate."));
      }
      const stream = streamChunkedResponse(responder, { status, headers }, res.body, { padTo: cfg.padBytes, maxBytes: cfg.maxResponseBytes });
      return new Response(stream, { status: 200, headers: { "content-type": MEDIA_CHUNKED_RES, ...relayNoStore, ...INCREMENTAL_HEADERS } });
    }
    const out = await readResponse(res, cfg.maxResponseBytes);
    if (!out) return respond(innerError(502, "response_too_large", "The response is larger than the gateway will encapsulate."));
    return respond({ status, headers, body: out });
  };
  for (const p of GATEWAY_PATHS) app.post(p, gateway);
}

/** Published view of RELAY_OPERATORS: everything but the secrets' hashes. */
function relayList(ctx: Ctx) {
  const gw = ctx.cfg.ohttp.gatewayOperator.toLowerCase();
  return ctx.cfg.ohttp.relays.map((r) => ({ operator: r.operator, url: r.url, key_id: r.keyId, independent: r.operator.toLowerCase() !== gw }));
}
