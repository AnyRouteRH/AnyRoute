// Minimal deterministic CBOR (RFC 8949) for receipt v2: unsigned and negative integers, byte and text strings,
// arrays, maps, tags, true, false and null. No floats, no indefinite lengths. Encoding follows the core deterministic
// rules of RFC 8949 Section 4.2.1: shortest-form heads, definite lengths, map keys sorted by their encoded bytes.
// Plain objects encode as maps with text keys (undefined members dropped, as in JSON); a Map may use integer keys
// (COSE headers). Decoding returns every map as a Map, so integer and text keys never collide.

export class CborTag {
  constructor(
    readonly tag: number,
    readonly value: CborValue,
  ) {}
}

export type CborValue = number | bigint | string | boolean | null | Uint8Array | CborValue[] | Map<CborValue, CborValue> | CborTag | { [k: string]: CborValue | undefined };

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

function head(major: number, n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new Error("cbor: negative length");
  const m = major << 5;
  if (v < 24n) return Uint8Array.of(m | Number(v));
  if (v < 0x100n) return Uint8Array.of(m | 24, Number(v));
  if (v < 0x10000n) return Uint8Array.of(m | 25, Number(v >> 8n), Number(v & 0xffn));
  if (v < 0x100000000n) return Uint8Array.of(m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)));
  if (v < 1n << 64n) return Uint8Array.of(m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)));
  throw new Error("cbor: integer out of range");
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

function encodeMap(entries: [CborValue, CborValue][]): Uint8Array {
  const enc = entries.map(([k, v]) => [cborEncode(k), cborEncode(v)] as const).sort((a, b) => compareBytes(a[0], b[0]));
  for (let i = 1; i < enc.length; i++) if (compareBytes(enc[i - 1][0], enc[i][0]) === 0) throw new Error("cbor: duplicate map key");
  return concat([head(5, enc.length), ...enc.flat()]);
}

export function cborEncode(v: CborValue): Uint8Array {
  if (v === null) return Uint8Array.of(0xf6);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === false) return Uint8Array.of(0xf4);
  if (typeof v === "number" || typeof v === "bigint") {
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error("cbor: only safe integers are supported");
    const n = BigInt(v);
    return n >= 0n ? head(0, n) : head(1, -1n - n);
  }
  if (typeof v === "string") {
    const b = te.encode(v);
    return concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return concat([head(2, v.length), v]);
  if (Array.isArray(v)) return concat([head(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof CborTag) return concat([head(6, v.tag), cborEncode(v.value)]);
  if (v instanceof Map) return encodeMap([...v.entries()]);
  if (typeof v === "object") return encodeMap(Object.entries(v).filter(([, x]) => x !== undefined) as [string, CborValue][]);
  throw new Error(`cbor: cannot encode ${typeof v}`);
}

/** Decode exactly one item; trailing bytes, floats, indefinite lengths and non-shortest heads are errors. */
export function cborDecode(bytes: Uint8Array): CborValue {
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error("cbor: truncated");
  };
  const readHead = (): { major: number; n: bigint } => {
    need(1);
    const b = bytes[at++];
    const major = b >> 5;
    const info = b & 0x1f;
    if (major === 7) {
      if (info === 20 || info === 21 || info === 22) return { major, n: BigInt(info) };
      throw new Error("cbor: unsupported simple value or float");
    }
    if (info < 24) return { major, n: BigInt(info) };
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!len) throw new Error("cbor: indefinite or reserved length");
    need(len);
    let n = 0n;
    for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(bytes[at++]);
    const min = len === 1 ? 24n : len === 2 ? 0x100n : len === 4 ? 0x10000n : 0x100000000n;
    if (n < min) throw new Error("cbor: non-shortest integer head");
    return { major, n };
  };
  const toNumber = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
  const item = (): CborValue => {
    const { major, n } = readHead();
    switch (major) {
      case 0:
        return toNumber(n);
      case 1:
        return typeof toNumber(n) === "number" ? -1 - Number(n) : -1n - n;
      case 2:
      case 3: {
        const len = Number(n);
        need(len);
        const b = bytes.slice(at, at + len);
        at += len;
        return major === 2 ? b : td.decode(b);
      }
      case 4:
        return Array.from({ length: Number(n) }, item);
      case 5: {
        const m = new Map<CborValue, CborValue>();
        let prev: Uint8Array | null = null;
        for (let i = 0; i < Number(n); i++) {
          const start = at;
          const k = item();
          const kb = bytes.subarray(start, at);
          if (prev && compareBytes(prev, kb) >= 0) throw new Error("cbor: map keys not in deterministic order");
          prev = kb;
          m.set(k, item());
        }
        return m;
      }
      case 6:
        return new CborTag(Number(n), item());
      default:
        return n === 20n ? false : n === 21n ? true : null;
    }
  };
  const v = item();
  if (at !== bytes.length) throw new Error("cbor: trailing bytes");
  return v;
}

/** A decoded map with text keys as a plain object, recursively (the JSON view of a claim set). */
export function cborToJson(v: CborValue): unknown {
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of v) {
      if (typeof k !== "string") throw new Error("cbor: claim map keys must be text");
      out[k] = cborToJson(x);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(cborToJson);
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (typeof v === "bigint") return v.toString();
  return v;
}
