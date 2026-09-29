// Binary HTTP messages (RFC 9292), the payload an Oblivious HTTP request and response carry.
//
// Decoding is strict on purpose (RFC 9292 section 8): it takes a whole message that is already in memory, every
// length is checked against the bytes that remain before anything is allocated, and anything the format calls
// invalid is refused rather than repaired.
//   - request framing 0 (known length) and 2 (indeterminate length); response framing 1 and 3
//   - truncation is accepted only between sections, where a missing length reads as zero (section 3.8); a message
//     cut inside a field, a length or the control data is invalid
//   - padding must be zero bytes
//   - field names must be lower-case tokens, values may not carry NUL, CR or LF or edge whitespace, and pseudo-fields
//     (":method" and the like) are refused in field sections
// Encoding produces the known-length form, with optional zero padding.

export class BhttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BhttpError";
  }
}

export type HeaderList = [name: string, value: string][];

export type BhttpRequest = { method: string; scheme: string; authority: string; path: string; headers: HeaderList; body: Uint8Array; trailers: HeaderList };
export type BhttpResponse = { status: number; headers: HeaderList; body: Uint8Array; trailers: HeaderList; informational: { status: number; headers: HeaderList }[] };

export type DecodeLimits = {
  /** Most field lines in the header section (and again in the trailer section). */
  maxFields: number;
  /** Longest field name or value, in bytes. */
  maxFieldBytes: number;
  /** Most bytes of names and values in one field section. */
  maxSectionBytes: number;
};
export const DEFAULT_LIMITS: DecodeLimits = { maxFields: 100, maxFieldBytes: 16 * 1024, maxSectionBytes: 64 * 1024 };

// ---- variable-length integers (RFC 9000 section 16) ------------------------------------------------------------

/** Encode with the shortest form that fits. */
export function encodeVarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new BhttpError("varint out of range");
  if (n < 0x40) return Uint8Array.of(n);
  if (n < 0x4000) return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
  if (n < 0x40000000) return Uint8Array.of(0x80 | (n >>> 24), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n) | (0xc0n << 56n));
  return out;
}

class Reader {
  at = 0;
  constructor(readonly b: Uint8Array) {}
  get done() {
    return this.at >= this.b.length;
  }
  get left() {
    return this.b.length - this.at;
  }
  /** A varint. Non-minimal encodings are accepted, as the RFC allows; values above 2^53 - 1 are refused. */
  varint(): number {
    if (this.done) throw new BhttpError("message is truncated");
    const first = this.b[this.at];
    const len = 1 << (first >> 6);
    if (this.left < len) throw new BhttpError("message is truncated");
    let v = BigInt(first & 0x3f);
    for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(this.b[this.at + i]);
    this.at += len;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new BhttpError("length is too large");
    return Number(v);
  }
  take(n: number): Uint8Array {
    if (n > this.left) throw new BhttpError("message is truncated");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** A length-prefixed byte string. */
  lp(): Uint8Array {
    return this.take(this.varint());
  }
  restIsZero(): boolean {
    for (let i = this.at; i < this.b.length; i++) if (this.b[i] !== 0) return false;
    return true;
  }
}

// ---- text rules ------------------------------------------------------------------------------------------------

const latin1 = new TextDecoder("latin1");
const asText = (b: Uint8Array) => latin1.decode(b);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/; // lower-case only: an upper-case name would make an HTTP/2 message malformed
const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function fieldName(b: Uint8Array): string {
  const s = asText(b);
  if (!TOKEN.test(s)) {
    if (s.startsWith(":")) throw new BhttpError("pseudo-fields are not allowed in a field section");
    throw new BhttpError("invalid field name");
  }
  return s;
}

function fieldValue(b: Uint8Array): string {
  for (const c of b) if (c === 0x00 || c === 0x0a || c === 0x0d) throw new BhttpError("invalid field value");
  if (b.length && (b[0] === 0x20 || b[0] === 0x09 || b[b.length - 1] === 0x20 || b[b.length - 1] === 0x09)) throw new BhttpError("field value has leading or trailing whitespace");
  return asText(b);
}

/** Path and authority are ASCII without spaces or controls. */
function visibleAscii(b: Uint8Array, what: string): string {
  for (const c of b) if (c < 0x21 || c > 0x7e) throw new BhttpError(`invalid ${what}`);
  return asText(b);
}

// ---- decoding --------------------------------------------------------------------------------------------------

type Section = { fields: HeaderList; bytes: number };

function checkField(sec: Section, name: Uint8Array, value: Uint8Array, lim: DecodeLimits) {
  if (sec.fields.length >= lim.maxFields) throw new BhttpError("too many fields");
  if (name.length > lim.maxFieldBytes || value.length > lim.maxFieldBytes) throw new BhttpError("field is too long");
  sec.bytes += name.length + value.length;
  if (sec.bytes > lim.maxSectionBytes) throw new BhttpError("field section is too large");
  sec.fields.push([fieldName(name), fieldValue(value)]);
}

function knownSection(r: Reader, lim: DecodeLimits): HeaderList {
  if (r.done) return []; // truncated here: RFC 9292 section 3.8 reads a missing length as zero (RFC 9458's own example ends after the control data)
  const len = r.varint();
  const sr = new Reader(r.take(len));
  const sec: Section = { fields: [], bytes: 0 };
  while (!sr.done) {
    const name = sr.lp();
    if (!name.length) throw new BhttpError("empty field name");
    checkField(sec, name, sr.lp(), lim);
  }
  return sec.fields;
}

function indeterminateSection(r: Reader, lim: DecodeLimits): HeaderList {
  const sec: Section = { fields: [], bytes: 0 };
  if (r.done) return sec.fields; // truncated here, as above
  for (;;) {
    const n = r.varint();
    if (n === 0) return sec.fields; // Content Terminator
    const name = r.take(n);
    checkField(sec, name, r.lp(), lim);
  }
}

function indeterminateContent(r: Reader): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const n = r.varint();
    if (n === 0) break;
    chunks.push(r.take(n));
  }
  return chunks.length === 1 ? chunks[0] : new Uint8Array(Buffer.concat(chunks));
}

/** Content and trailers after the header section; either may be missing where the RFC lets an encoder truncate. */
function tail(r: Reader, known: boolean, lim: DecodeLimits): { body: Uint8Array; trailers: HeaderList } {
  let body: Uint8Array = new Uint8Array(0);
  let trailers: HeaderList = [];
  if (!r.done) {
    body = known ? r.lp() : indeterminateContent(r);
    if (!r.done) trailers = known ? knownSection(r, lim) : indeterminateSection(r, lim);
  }
  if (!r.restIsZero()) throw new BhttpError("padding is not zero");
  return { body, trailers };
}

export function decodeRequest(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): BhttpRequest {
  const r = new Reader(bytes);
  const framing = r.varint();
  if (framing !== 0 && framing !== 2) throw new BhttpError("not a binary HTTP request");
  const known = framing === 0;
  const method = asText(r.lp());
  const scheme = asText(r.lp());
  const authority = r.lp();
  const path = r.lp();
  if (!METHOD.test(method)) throw new BhttpError("invalid method");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) throw new BhttpError("invalid scheme");
  if (!path.length) throw new BhttpError("empty path");
  const headers = known ? knownSection(r, limits) : indeterminateSection(r, limits);
  return { method, scheme, authority: visibleAscii(authority, "authority"), path: visibleAscii(path, "path"), headers, ...tail(r, known, limits) };
}

export function decodeResponse(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): BhttpResponse {
  const r = new Reader(bytes);
  const framing = r.varint();
  if (framing !== 1 && framing !== 3) throw new BhttpError("not a binary HTTP response");
  const known = framing === 1;
  const informational: BhttpResponse["informational"] = [];
  for (;;) {
    const status = r.varint();
    if (status < 100 || status > 599) throw new BhttpError("invalid status code");
    const headers = known ? knownSection(r, limits) : indeterminateSection(r, limits);
    if (status >= 200) return { status, headers, informational, ...tail(r, known, limits) };
    informational.push({ status, headers });
  }
}

// ---- encoding --------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const ascii = (s: string) => Buffer.from(s, "latin1");

function lpBytes(b: Uint8Array): Uint8Array {
  return Buffer.concat([encodeVarint(b.length), b]);
}

function fieldSection(fields: HeaderList): Uint8Array {
  const lines = fields.map(([name, value]) => {
    const n = name.toLowerCase();
    const nb = ascii(n);
    const vb = ascii(value);
    fieldName(nb);
    fieldValue(vb);
    return Buffer.concat([lpBytes(nb), lpBytes(vb)]);
  });
  return lpBytes(Buffer.concat(lines));
}

/** Zero bytes so the total length is a multiple of `block` (0 or 1: no padding). */
function padded(message: Uint8Array, block: number): Uint8Array {
  if (block <= 1) return message;
  const extra = (block - (message.length % block)) % block;
  return extra ? Buffer.concat([message, new Uint8Array(extra)]) : message;
}

export type EncodeOptions = { padTo?: number };

export function encodeRequest(req: { method: string; scheme?: string; authority?: string; path: string; headers?: HeaderList; body?: Uint8Array; trailers?: HeaderList }, opts: EncodeOptions = {}): Uint8Array {
  const method = ascii(req.method);
  if (!METHOD.test(req.method)) throw new BhttpError("invalid method");
  visibleAscii(ascii(req.path), "path");
  if (!req.path.length) throw new BhttpError("empty path");
  const parts = [
    encodeVarint(0),
    lpBytes(method),
    lpBytes(ascii(req.scheme ?? "https")),
    lpBytes(ascii(req.authority ?? "")),
    lpBytes(ascii(req.path)),
    fieldSection(req.headers ?? []),
    lpBytes(req.body ?? new Uint8Array(0)),
    fieldSection(req.trailers ?? []),
  ];
  return padded(Buffer.concat(parts), opts.padTo ?? 0);
}

export function encodeResponse(res: { status: number; headers?: HeaderList; body?: Uint8Array; trailers?: HeaderList }, opts: EncodeOptions = {}): Uint8Array {
  if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599) throw new BhttpError("invalid status code");
  const parts = [encodeVarint(1), encodeVarint(res.status), fieldSection(res.headers ?? []), lpBytes(res.body ?? new Uint8Array(0)), fieldSection(res.trailers ?? [])];
  return padded(Buffer.concat(parts), opts.padTo ?? 0);
}

export const utf8 = (s: string) => enc.encode(s);
