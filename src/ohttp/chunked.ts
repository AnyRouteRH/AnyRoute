import { ChunkedOHTTPServer, OHTTPError, OHTTPErrorCode, frameChunk, parseFramedChunk, type ChunkedServerResponseContext, type KeyConfigWithPrivate } from "ohttp-ts";
import { BhttpError, encodeVarint, type HeaderList } from "./bhttp.ts";
import { REQUEST_PREFIX } from "./ohttp.ts";

// Chunked Oblivious HTTP (draft-ietf-ohai-chunked-ohttp-08) for the gateway: a response that is encrypted and sent
// chunk by chunk as the router produces it, so a streamed completion reaches the client token by token while the relay
// still sees only ciphertext. The HPKE and AEAD work is ohttp-ts's chunked contexts, over the same suite and keys as
// ohttp.ts; this module adds the framing around them and the Binary HTTP (RFC 9292) indeterminate-length response.
//
//   request   header (key id, KEM, KDF, AEAD, enc) || { length (varint) || sealed chunk }* || 0 || sealed final chunk
//   response  nonce (16) || { length (varint) || sealed chunk }* || 0 || sealed final chunk
//
// Every chunk is sealed with an empty AAD except the last, whose AAD is "final". A receiver treats a message as complete
// only after that final chunk opened, so a response cut short (by the network, a relay or anything in between) is
// detected as truncated, never mistaken for a shorter answer. Chunks carry at most 16 KiB of plaintext, the size every
// implementation must accept (draft section 3). A non-final chunk is never empty.

export const MEDIA_CHUNKED_REQ = "message/ohttp-chunked-req";
export const MEDIA_CHUNKED_RES = "message/ohttp-chunked-res";
/** Most plaintext in one chunk, sent and accepted. */
export const CHUNK_BYTES = 16_384;
/** Asks intermediaries to forward the message as it arrives instead of buffering it (RFC 10036; draft section 5). */
export const INCREMENTAL_HEADERS = { incremental: "?1" } as const;

const cat = (parts: Uint8Array[]): Uint8Array => (parts.length === 1 ? parts[0] : new Uint8Array(Buffer.concat(parts)));
const asBytes = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

// ---- request -------------------------------------------------------------------------------------------------------

export type OpenedChunkedRequest = {
  /** The binary HTTP request, from every chunk up to and including the final one. */
  request: Uint8Array;
  /** The response side, bound to this request's HPKE context. Call it once. */
  responder(): Promise<ChunkedResponder>;
};

/**
 * Open a whole chunked request with one gateway key. Throws an OHTTPError as openRequest does: DecryptionFailed for a
 * request this key cannot open or a chunk that was altered, UnsupportedCipherSuite, InvalidMessage for a malformed or
 * truncated message (no final chunk), ChunkLimitExceeded for an oversized or empty non-final chunk, MessageTooLarge
 * past `maxMessageSize` bytes of plaintext.
 */
export async function openChunkedRequest(key: KeyConfigWithPrivate, encapsulated: Uint8Array, maxMessageSize: number): Promise<OpenedChunkedRequest> {
  const server = new ChunkedOHTTPServer([key], { padding: 0, maxMessageSize });
  const ctx = await server.createRequestContext(encapsulated);
  const parts: Uint8Array[] = [];
  let at = REQUEST_PREFIX;
  for (;;) {
    // No frame left before a final one: the request was cut short.
    const frame = parseFramedChunk(asBytes(encapsulated.subarray(at)));
    if (!frame) throw new OHTTPError(OHTTPErrorCode.InvalidMessage);
    if (frame.isFinal) {
      parts.push(await ctx.openFinalChunk(frame.ciphertext));
      break;
    }
    parts.push(await ctx.openChunk(frame.ciphertext));
    at += frame.bytesConsumed;
  }
  return { request: cat(parts), responder: async () => new ChunkedResponder(await ctx.createResponseContext()) };
}

// ---- response ------------------------------------------------------------------------------------------------------

/** Seals the chunks of one response. The nonce goes first on the wire. */
export class ChunkedResponder {
  constructor(private readonly ctx: ChunkedServerResponseContext) {}

  get nonce(): Uint8Array {
    return this.ctx.responseNonce;
  }

  /** Framed non-final chunks for `plaintext`, split at CHUNK_BYTES. Nothing for empty input. */
  async chunks(plaintext: Uint8Array): Promise<Uint8Array> {
    const out: Uint8Array[] = [];
    for (let i = 0; i < plaintext.length; i += CHUNK_BYTES) out.push(frameChunk(await this.ctx.sealChunk(plaintext.subarray(i, i + CHUNK_BYTES)), false));
    return out.length ? cat(out) : new Uint8Array(0);
  }

  /** `plaintext` as the end of the response: non-final chunks for all but its last CHUNK_BYTES, then the final chunk. */
  async end(plaintext: Uint8Array): Promise<Uint8Array> {
    const cut = plaintext.length > CHUNK_BYTES ? plaintext.length - (plaintext.length % CHUNK_BYTES || CHUNK_BYTES) : 0;
    const head = await this.chunks(plaintext.subarray(0, cut));
    return cat([head, frameChunk(await this.ctx.sealFinalChunk(plaintext.subarray(cut)), true)]);
  }

  /** A whole binary HTTP response as one chunked response body. */
  async whole(message: Uint8Array): Promise<Uint8Array> {
    return cat([this.nonce, await this.end(message)]);
  }
}

// ---- Binary HTTP, indeterminate length (RFC 9292 section 3.2) ------------------------------------------------------

const NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const latin1 = (s: string) => Buffer.from(s, "latin1");

/** Framing indicator 3, the final status code and the header section, ending with its content terminator. */
export function encodeResponseHead(status: number, headers: HeaderList): Uint8Array {
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new BhttpError("invalid status code");
  const parts: Uint8Array[] = [encodeVarint(3), encodeVarint(status)];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!NAME.test(name)) throw new BhttpError("invalid field name");
    if (/[\0\r\n]/.test(value) || /^[ \t]|[ \t]$/.test(value)) throw new BhttpError("invalid field value");
    const n = latin1(name);
    const v = latin1(value);
    parts.push(encodeVarint(n.length), n, encodeVarint(v.length), v);
  }
  parts.push(encodeVarint(0));
  return cat(parts);
}

export type StreamOptions = {
  /** Zero-pad the whole binary HTTP message to a multiple of this many bytes (0 or 1: none). */
  padTo: number;
  /** Most content bytes carried; past this the response is cut off without a final chunk. */
  maxBytes: number;
};

/**
 * The encapsulated response body for an inner response, produced as the inner body is read: the nonce with the
 * header section first, then each piece of content as a chunk as soon as it arrives, then a final chunk that closes the
 * content and the (empty) trailer section. If the inner body fails, or grows past `maxBytes`, the stream ends without
 * a final chunk, which the client detects as a truncated response. (It ends rather than errors: the HTTP server would
 * end the response the same way, and report the error besides; the gateway reports nothing about a request.)
 * Cancelling the stream cancels the inner body.
 */
export function streamChunkedResponse(responder: ChunkedResponder, head: { status: number; headers: HeaderList }, body: ReadableStream<Uint8Array> | null, opts: StreamOptions): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  const stop = (ctl: ReadableStreamDefaultController<Uint8Array>) => {
    void reader?.cancel().catch(() => undefined);
    try {
      ctl.close();
    } catch {
      /* already cancelled by the reader */
    }
  };
  let started = false;
  let total = 0; // bytes of the binary HTTP message so far, for the padding
  let content = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctl) {
        try {
          if (!started) {
            started = true;
            const h = encodeResponseHead(head.status, head.headers);
            total += h.length;
            ctl.enqueue(cat([responder.nonce, await responder.chunks(h)]));
            return;
          }
          // Read until there is something to send: a pull that enqueues nothing would not be called again.
          for (;;) {
            const next = reader ? await reader.read() : ({ done: true, value: undefined } as const);
            if (next.done) {
              // Content terminator, empty trailer section, then zero padding.
              const block = opts.padTo > 1 ? opts.padTo : 1;
              const tail = 2 + ((block - ((total + 2) % block)) % block);
              ctl.enqueue(await responder.end(new Uint8Array(tail)));
              ctl.close();
              return;
            }
            if (!next.value?.length) continue;
            content += next.value.length;
            if (content > opts.maxBytes) return stop(ctl); // larger than the gateway will encapsulate
            const piece = cat([encodeVarint(next.value.length), next.value]);
            total += piece.length;
            ctl.enqueue(await responder.chunks(piece));
            return;
          }
        } catch {
          stop(ctl);
        }
      },
      cancel(reason) {
        void reader?.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
