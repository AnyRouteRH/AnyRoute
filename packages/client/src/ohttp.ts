import { AnyRouteError } from "./errors.js";
import type { Fetch } from "./types.js";

// Chunked Oblivious HTTP (draft-ietf-ohai-chunked-ohttp-08) for the unlinkable lane. `obliviousFetch` returns a fetch
// that sends every call through a relay to the router's gateway, encrypted to the gateway's key: the relay sees the
// client and ciphertext, the gateway sees the request and the relay, and neither sees both. The response is decrypted
// chunk by chunk as it arrives, so `stream: true` works: tokens reach the caller as they are produced.
//
//   const f = obliviousFetch({ relayUrl, keyConfig });          // keyConfig: from the signed key list you checked
//   const client = new AnyRoute({ baseUrl: routerUrl, privateToken, fetch: f, receiptKeys: pinnedKeys });
//   for await (const chunk of await client.chat.completions.stream({ model, messages })) ...
//
// A response is complete only once its final chunk opened (its AAD says "final"). A stream that ends before that is an
// error with code `ohttp_truncated`, and a chunk that fails authentication is `ohttp_decrypt_failed`: a cut or altered
// response is never passed off as a shorter one. Only the router's gateway allow-list is reachable this way (chat,
// completions, embeddings, blind-token purchase and keys, models), so pin the receipt keys rather than fetching them.
//
// The HPKE and chunk encryption come from optional peer dependencies, loaded only when this module is used:
//   npm install ohttp-ts@0.6.0 hpke@1.1.7

export const CHUNKED_REQUEST_MEDIA_TYPE = "message/ohttp-chunked-req";
export const CHUNKED_RESPONSE_MEDIA_TYPE = "message/ohttp-chunked-res";
/** Most plaintext in one chunk: what every implementation accepts (draft section 3). */
const CHUNK_BYTES = 16_384;
const TAG_BYTES = 16;
/** DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM: the one suite the gateway offers. The response nonce is max(Nn, Nk). */
const SUITE_IDS = { kem: 0x0020, kdf: 0x0001, aead: 0x0001 } as const;
const RESPONSE_NONCE_BYTES = 16;
const FIELD_LIMITS = { maxFields: 100, maxLength: 16 * 1024, maxSection: 64 * 1024 };

type Lib = { ohttp: typeof import("ohttp-ts"); hpke: typeof import("hpke") };
let loaded: Promise<Lib> | null = null;

function lib(): Promise<Lib> {
  loaded ??= Promise.all([import("ohttp-ts"), import("hpke")])
    .then(([ohttp, hpke]) => ({ ohttp, hpke }))
    .catch(() => {
      loaded = null;
      throw new AnyRouteError("Oblivious HTTP needs the optional dependencies ohttp-ts and hpke (npm install ohttp-ts@0.6.0 hpke@1.1.7).", "ohttp_unavailable");
    });
  return loaded;
}

export type ObliviousOptions = {
  /** The relay's URL, for example https://relay.example/relay (from GET /api/v1/relays: pick an independent operator). */
  relayUrl: string;
  /**
   * The gateway's key configuration (RFC 9458 section 3), serialized: the base64url-decoded `config` of a key in the
   * signed key list (GET /api/v1/ohttp/key-list) after you checked its signature against a key you pinned. Never take
   * it from the relay, which could then read everything.
   */
  keyConfig: Uint8Array;
  /** The gateway the relay should forward to, when it serves several (`?gateway=<name>`). */
  gateway?: string;
  fetch?: Fetch;
  /** Most bytes of decrypted response to accept. Default 64 MiB. */
  maxResponseBytes?: number;
};

// ---- small byte helpers ----------------------------------------------------------------------------------------------

const utf8 = new TextEncoder();
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A QUIC variable-length integer (RFC 9000 section 16), shortest form. */
function varint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 2 ** 62) throw new RangeError("varint out of range");
  if (n < 0x40) return Uint8Array.of(n);
  if (n < 0x4000) return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
  if (n < 0x40000000) return Uint8Array.of(0x80 | (n >>> 24), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n) | (0xc0n << 56n));
  return out;
}

/** A varint at `at`, or null when `b` ends before it does. */
function readVarint(b: Uint8Array, at: number): { value: number; size: number } | null {
  if (at >= b.length) return null;
  const size = 1 << (b[at] >> 6);
  if (at + size > b.length) return null;
  let v = BigInt(b[at] & 0x3f);
  for (let i = 1; i < size; i++) v = (v << 8n) | BigInt(b[at + i]);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("a length in the response is too large");
  return { value: Number(v), size };
}

const lp = (b: Uint8Array) => concat([varint(b.length), b]);
const invalid = (what: string) => new AnyRouteError(`The gateway's response is not valid: ${what}.`, "ohttp_invalid_response");
const truncated = () => new AnyRouteError("The response ended before its final chunk: it was cut off on the way and is incomplete.", "ohttp_truncated");

// ---- Binary HTTP (RFC 9292) ------------------------------------------------------------------------------------------

/** A known-length request (framing indicator 0). The authority is left empty: the gateway serves its own routes only. */
function encodeRequest(method: string, path: string, headers: [string, string][], body: Uint8Array): Uint8Array {
  const fields = concat(headers.map(([n, v]) => concat([lp(utf8.encode(n.toLowerCase())), lp(utf8.encode(v))])));
  return concat([varint(0), lp(utf8.encode(method)), lp(utf8.encode("https")), lp(new Uint8Array(0)), lp(utf8.encode(path)), lp(fields), lp(body), lp(new Uint8Array(0))]);
}

type Head = { status: number; headers: Headers };

/**
 * Decodes a response (framing indicator 1 or 3) as its bytes arrive: the head once the header section is complete,
 * then content as it comes. Interim (1xx) responses are skipped; trailers are read and dropped; padding must be zeros.
 */
class ResponseDecoder {
  head: Head | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private state: "framing" | "status" | "fields" | "content" | "trailers" | "padding" = "framing";
  private known = false;
  private status = 0;
  private fields: [string, string][] = [];
  private sectionBytes = 0;
  /** Content bytes still to come in the current known-length content or indeterminate chunk (-1: a length is next). */
  private contentLeft = -1;
  private contentSeen = false;
  private readonly latin1 = new TextDecoder("latin1");

  /** Feed bytes; returns the content they completed. */
  push(bytes: Uint8Array): Uint8Array[] {
    this.buf = this.buf.length ? concat([this.buf, bytes]) : bytes;
    const out: Uint8Array[] = [];
    let at = 0;
    const need = (n: number) => this.buf.length - at >= n;
    const vi = () => {
      const r = readVarint(this.buf, at);
      if (r) at += r.size;
      return r?.value ?? null;
    };
    for (;;) {
      if (this.state === "framing") {
        const f = vi();
        if (f === null) break;
        if (f !== 1 && f !== 3) throw invalid("not a binary HTTP response");
        this.known = f === 1;
        this.state = "status";
      } else if (this.state === "status") {
        const s = vi();
        if (s === null) break;
        if (s < 100 || s > 599) throw invalid("status code out of range");
        this.status = s;
        this.fields = [];
        this.sectionBytes = 0;
        this.state = "fields";
      } else if (this.state === "fields" || this.state === "trailers") {
        // Both advance `at` only past complete units, so a section that has not fully arrived resumes where it stopped.
        const done = this.known ? this.knownSection(at, (n) => (at = n)) : this.indeterminateSection(at, (n) => (at = n));
        if (done === null) break;
        if (this.state === "trailers") {
          this.state = "padding";
          continue;
        }
        if (this.status < 200) {
          this.state = "status"; // an interim response; the final one follows
          continue;
        }
        const headers = new Headers();
        try {
          for (const [n, v] of this.fields) headers.append(n, v);
        } catch {
          throw invalid("a header field is malformed");
        }
        this.head = { status: this.status, headers };
        this.state = "content";
      } else if (this.state === "content") {
        if (this.contentLeft < 0) {
          const n = vi();
          if (n === null) break;
          if (this.known || n > 0) {
            this.contentLeft = n;
            this.contentSeen = true;
          }
          if (n === 0) {
            this.contentLeft = -1;
            this.state = "trailers";
            this.fields = [];
            this.sectionBytes = 0;
          }
          continue;
        }
        if (!need(1) && this.contentLeft > 0) break;
        const take = Math.min(this.contentLeft, this.buf.length - at);
        if (take > 0) out.push(this.buf.slice(at, at + take));
        at += take;
        this.contentLeft -= take;
        if (this.contentLeft === 0) {
          this.contentLeft = -1;
          if (this.known) {
            this.state = "trailers";
            this.fields = [];
            this.sectionBytes = 0;
          }
        }
      } else {
        for (; at < this.buf.length; at++) if (this.buf[at] !== 0) throw invalid("padding is not zero");
        break;
      }
    }
    this.buf = this.buf.slice(at);
    return out;
  }

  /** The message ended: it must not stop inside a field, a length or content that was announced. */
  end(): void {
    if (this.buf.length) throw invalid("the message ends inside a field");
    const boundary =
      this.state === "padding" ||
      this.state === "trailers" ||
      (this.state === "content" && this.contentLeft < 0 && (this.known || !this.contentSeen)); // RFC 9292 section 3.8
    if (!this.head || !boundary || (this.state === "trailers" && this.fields.length)) throw invalid("the message is incomplete");
  }

  private addField(name: Uint8Array, value: Uint8Array) {
    if (!name.length) throw invalid("empty field name");
    if (this.fields.length >= FIELD_LIMITS.maxFields) throw invalid("too many fields");
    if (name.length > FIELD_LIMITS.maxLength || value.length > FIELD_LIMITS.maxLength) throw invalid("a field is too long");
    this.sectionBytes += name.length + value.length;
    if (this.sectionBytes > FIELD_LIMITS.maxSection) throw invalid("a field section is too large");
    this.fields.push([this.latin1.decode(name), this.latin1.decode(value)]);
  }

  /** A length-prefixed field section; null until all of it has arrived. */
  private knownSection(at: number, moveTo: (n: number) => void): true | null {
    const r = readVarint(this.buf, at);
    if (!r) return null;
    if (r.value > FIELD_LIMITS.maxSection + 4 * FIELD_LIMITS.maxFields) throw invalid("a field section is too large");
    const end = at + r.size + r.value;
    if (end > this.buf.length) return null;
    let p = at + r.size;
    while (p < end) {
      const n = readVarint(this.buf, p);
      if (!n || p + n.size + n.value > end) throw invalid("a field section is malformed");
      const name = this.buf.subarray(p + n.size, p + n.size + n.value);
      p += n.size + n.value;
      const v = readVarint(this.buf, p);
      if (!v || p + v.size + v.value > end) throw invalid("a field section is malformed");
      this.addField(name, this.buf.subarray(p + v.size, p + v.size + v.value));
      p += v.size + v.value;
    }
    moveTo(end);
    return true;
  }

  /** Field lines up to a zero length; null until the terminator has arrived (fields read so far are kept). */
  private indeterminateSection(at: number, moveTo: (n: number) => void): true | null {
    for (;;) {
      const n = readVarint(this.buf, at);
      if (!n) return null;
      if (n.value === 0) {
        moveTo(at + n.size);
        return true;
      }
      if (n.value > FIELD_LIMITS.maxLength) throw invalid("a field is too long");
      const v = readVarint(this.buf, at + n.size + n.value);
      if (!v) return null;
      if (v.value > FIELD_LIMITS.maxLength) throw invalid("a field is too long");
      const end = at + n.size + n.value + v.size + v.value;
      if (end > this.buf.length) return null;
      this.addField(this.buf.subarray(at + n.size, at + n.size + n.value), this.buf.subarray(at + n.size + n.value + v.size, end));
      at = end;
      moveTo(at);
    }
  }
}

// ---- the chunked response ------------------------------------------------------------------------------------------

type Opener = { openChunk(ct: Uint8Array): Promise<Uint8Array>; openFinalChunk(ct: Uint8Array): Promise<Uint8Array> };

/**
 * The plaintext of each chunk, in order, as the chunks arrive. Throws `ohttp_truncated` when the body ends before the
 * final chunk, and `ohttp_decrypt_failed` when a chunk does not authenticate (altered, reordered, or not for this request).
 */
async function* openChunks(reader: ReadableStreamDefaultReader<Uint8Array>, open: (nonce: Uint8Array) => Promise<Opener>, isOhttpError: (e: unknown) => e is { code: string }, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  let buf: Uint8Array = new Uint8Array(0);
  let ended = false;
  const fill = async () => {
    let r: Awaited<ReturnType<typeof reader.read>>;
    try {
      r = await reader.read();
    } catch (e) {
      // The connection failed part way: whatever the cause, the response did not arrive whole. An abort stays an abort.
      if (signal?.aborted) throw e;
      throw Object.assign(truncated(), { cause: e });
    }
    if (r.done) ended = true;
    else if (r.value.length) buf = concat([buf, r.value]);
  };
  const guard = async (p: Promise<Uint8Array>) => {
    try {
      return await p;
    } catch (e) {
      if (isOhttpError(e) && e.code === "DECRYPTION_FAILED") throw new AnyRouteError("A response chunk failed authentication: the response was altered on the way or is not for this request.", "ohttp_decrypt_failed");
      if (isOhttpError(e) && e.code === "MESSAGE_TOO_LARGE") throw new AnyRouteError("The response is larger than this client accepts.", "ohttp_response_too_large");
      if (isOhttpError(e)) throw invalid("a chunk is malformed");
      throw e;
    }
  };
  while (buf.length < RESPONSE_NONCE_BYTES && !ended) await fill();
  if (buf.length < RESPONSE_NONCE_BYTES) throw truncated();
  const ctx = await open(buf.slice(0, RESPONSE_NONCE_BYTES));
  buf = buf.slice(RESPONSE_NONCE_BYTES);
  for (;;) {
    let len = readVarint(buf, 0);
    while (!len && !ended) {
      await fill();
      len = readVarint(buf, 0);
    }
    if (!len) throw truncated();
    if (len.value === 0) {
      // The final chunk runs to the end of the body.
      while (!ended) {
        await fill();
        if (buf.length > len.size + CHUNK_BYTES + TAG_BYTES) throw invalid("the final chunk is too large");
      }
      yield await guard(ctx.openFinalChunk(buf.slice(len.size)));
      return;
    }
    if (len.value > CHUNK_BYTES + TAG_BYTES) throw invalid("a chunk is too large");
    while (buf.length < len.size + len.value && !ended) await fill();
    if (buf.length < len.size + len.value) throw truncated();
    yield await guard(ctx.openChunk(buf.slice(len.size, len.size + len.value)));
    buf = buf.slice(len.size + len.value);
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Turn a `message/ohttp-chunked-res` into the inner response, whose body is decrypted as it is read. */
async function decapsulate(res: Response, open: (nonce: Uint8Array) => Promise<Opener>, isOhttpError: (e: unknown) => e is { code: string }, signal?: AbortSignal): Promise<Response> {
  if (!res.body) throw truncated();
  const reader = res.body.getReader();
  const chunks = openChunks(reader, open, isOhttpError, signal);
  const decoder = new ResponseDecoder();
  const pending: Uint8Array[] = [];
  let finished = false;
  const step = async () => {
    const next = await chunks.next();
    if (next.done) {
      decoder.end();
      finished = true;
    } else pending.push(...decoder.push(next.value));
  };
  const fail = (e: unknown) => {
    void reader.cancel().catch(() => undefined);
    return e;
  };
  try {
    while (!decoder.head && !finished) await step();
    if (!decoder.head) throw invalid("the message is incomplete");
  } catch (e) {
    throw fail(e);
  }
  const { status, headers } = decoder.head;
  if (NULL_BODY.has(status)) {
    try {
      while (!finished) await step();
    } catch (e) {
      throw fail(e);
    }
    return new Response(null, { status, headers });
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(ctl) {
        try {
          for (;;) {
            const piece = pending.shift();
            if (piece) {
              ctl.enqueue(piece);
              return;
            }
            if (finished) {
              ctl.close();
              return;
            }
            await step();
          }
        } catch (e) {
          ctl.error(fail(e));
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status, headers });
}

// ---- the fetch --------------------------------------------------------------------------------------------------------

async function requestParts(input: string | URL | Request, init: RequestInit = {}) {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input), "https://router.invalid");
  const method = (init.method ?? req?.method ?? "GET").toUpperCase();
  const headers: [string, string][] = [...new Headers(init.headers ?? req?.headers).entries()];
  let body: Uint8Array = new Uint8Array(0);
  if (init.body != null) body = new Uint8Array(await new Response(init.body).arrayBuffer());
  else if (req?.body) body = new Uint8Array(await req.arrayBuffer());
  return { method, path: url.pathname + url.search, headers, body, signal: init.signal ?? req?.signal ?? undefined };
}

/**
 * A fetch that carries each call through the relay as chunked Oblivious HTTP to the gateway, and returns the inner
 * response with a body decrypted as it arrives. The URL's path and query select the router route; its host is not sent.
 * Throws AnyRouteError `ohttp_refused` when the relay or the gateway refused before the request was unwrapped (the
 * status is on the error), and the response body errors with `ohttp_truncated` or `ohttp_decrypt_failed` as above.
 */
export function obliviousFetch(o: ObliviousOptions): Fetch {
  if (!o?.relayUrl) throw new AnyRouteError("relayUrl is required", "bad_options");
  if (!(o.keyConfig instanceof Uint8Array) || !o.keyConfig.length) throw new AnyRouteError("keyConfig is required: the gateway's key configuration from its signed key list", "bad_options");
  const f = o.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
  const target = new URL(o.relayUrl);
  if (o.gateway) target.searchParams.set("gateway", o.gateway);
  const maxResponseBytes = o.maxResponseBytes ?? 64 * 1024 * 1024;
  let client: Promise<import("ohttp-ts").ChunkedOHTTPClient> | null = null;

  const setup = async () => {
    const { ohttp, hpke } = await lib();
    let config: import("ohttp-ts").KeyConfig;
    try {
      config = ohttp.KeyConfig.parse(o.keyConfig);
    } catch {
      throw new AnyRouteError("The key configuration could not be parsed.", "ohttp_bad_key_config");
    }
    const offers = config.kemId === SUITE_IDS.kem && config.symmetricAlgorithms.some((a) => a.kdfId === SUITE_IDS.kdf && a.aeadId === SUITE_IDS.aead);
    if (!offers) throw new AnyRouteError("The key configuration does not offer DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM.", "ohttp_bad_key_config");
    const suite = new hpke.CipherSuite(hpke.KEM_DHKEM_X25519_HKDF_SHA256, hpke.KDF_HKDF_SHA256, hpke.AEAD_AES_128_GCM);
    return new ohttp.ChunkedOHTTPClient(suite, config, { padding: 0, maxMessageSize: maxResponseBytes });
  };

  return async (input, init) => {
    const { ohttp } = await lib();
    client ??= setup().catch((e) => {
      client = null;
      throw e;
    });
    const c = await client;
    const parts = await requestParts(input, init);
    const message = encodeRequest(parts.method, parts.path, parts.headers, parts.body);
    // A fresh HPKE context per request; the message is split into chunks of at most 16 KiB, the last one final.
    const ctx = await c.createRequestContext();
    const frames: Uint8Array[] = [ctx.header];
    const cut = message.length > CHUNK_BYTES ? message.length - (message.length % CHUNK_BYTES || CHUNK_BYTES) : 0;
    for (let i = 0; i < cut; i += CHUNK_BYTES) frames.push(ohttp.frameChunk(await ctx.sealChunk(message.subarray(i, i + CHUNK_BYTES)), false));
    frames.push(ohttp.frameChunk(await ctx.sealFinalChunk(message.subarray(cut)), true));

    const res = await f(target.toString(), {
      method: "POST",
      signal: parts.signal,
      headers: { "content-type": CHUNKED_REQUEST_MEDIA_TYPE, accept: CHUNKED_RESPONSE_MEDIA_TYPE, incremental: "?1" },
      body: concat(frames) as unknown as BodyInit,
    });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (res.status !== 200 || type !== CHUNKED_RESPONSE_MEDIA_TYPE) {
      const detail = await res.json().catch(() => null);
      throw new AnyRouteError(`The relay or the gateway refused the request before it was unwrapped (HTTP ${res.status}).`, "ohttp_refused", res.status, detail);
    }
    return decapsulate(res, (nonce) => ctx.createResponseContext(nonce), ohttp.isOHTTPError as (e: unknown) => e is { code: string }, parts.signal);
  };
}
