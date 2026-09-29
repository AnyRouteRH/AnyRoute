import { createHash } from "node:crypto";

// RFC 6962 / RFC 9162 Merkle trees and the C2SP tlog-tiles layout.
//
//   leaf hash  = SHA-256(0x00 || entry)
//   node hash  = SHA-256(0x01 || left || right)
//   empty tree = SHA-256("")
//
// A tile at level L holds up to 256 consecutive node hashes from tree level 8L (tile height 8). Tile N at level L covers
// the level-8L nodes [256N, 256N + W); a full tile has W = 256 and never changes, a partial tile is a prefix of it.
// Sizes and indices are JavaScript numbers (safe to 2^53): shifts are written as division, never as 32-bit `>>`.

export const HASH_SIZE = 32;
export const TILE_HEIGHT = 8;
export const TILE_WIDTH = 1 << TILE_HEIGHT;
/** Entries in a tlog-tiles entry bundle carry a 16-bit length. */
export const MAX_ENTRY_BYTES = 0xffff;

const H = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const ZERO = Buffer.from([0]);
const ONE = Buffer.from([1]);

export const leafHash = (entry: Uint8Array): Buffer => H(ZERO, entry);
export const nodeHash = (left: Uint8Array, right: Uint8Array): Buffer => H(ONE, left, right);
export const EMPTY_ROOT: Buffer = H();

const odd = (x: number) => x % 2 === 1;
const half = (x: number) => Math.floor(x / 2);
const isPow2 = (n: number) => n > 0 && 2 ** Math.round(Math.log2(n)) === n;

/** The largest power of two strictly smaller than n (n >= 2). */
export function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * An append-only tree that keeps every complete node, so tiles, roots of any earlier size and proofs are cheap. It is
 * built from leaf hashes; the entries themselves live elsewhere.
 */
export class MerkleTree {
  /** levels[l][i] is the root of leaves [i * 2^l, (i + 1) * 2^l); only complete nodes are kept. */
  private readonly levels: Buffer[][] = [[]];

  constructor(leaves: Iterable<Uint8Array> = []) {
    for (const l of leaves) this.appendLeafHash(l);
  }

  get size(): number {
    return this.levels[0].length;
  }

  appendLeafHash(hash: Uint8Array): void {
    if (hash.length !== HASH_SIZE) throw new Error("a leaf hash is 32 bytes");
    let h: Buffer = Buffer.from(hash);
    let level = 0;
    for (;;) {
      const row = (this.levels[level] ??= []);
      row.push(h);
      const i = row.length - 1;
      if (!odd(i)) return;
      h = nodeHash(row[i - 1], row[i]);
      level++;
    }
  }

  appendEntry(entry: Uint8Array): Buffer {
    const h = leafHash(entry);
    this.appendLeafHash(h);
    return h;
  }

  /** The complete node at (level, index), or throws when the tree does not have it yet. */
  node(level: number, index: number): Buffer {
    const h = this.levels[level]?.[index];
    if (!h) throw new Error(`node ${level}/${index} is not complete`);
    return h;
  }

  /** How many complete nodes the tree of `size` leaves has at `level`. */
  static nodesAt(level: number, size: number): number {
    return Math.floor(size / 2 ** level);
  }

  /** MTH(D[lo:hi]) for hi <= size. */
  rangeHash(lo: number, hi: number): Buffer {
    const n = hi - lo;
    if (n < 0 || hi > this.size || lo < 0) throw new Error("range outside the tree");
    if (n === 0) return EMPTY_ROOT;
    if (isPow2(n) && lo % n === 0) return this.node(Math.log2(n), lo / n);
    const k = splitPoint(n);
    return nodeHash(this.rangeHash(lo, lo + k), this.rangeHash(lo + k, hi));
  }

  /** The root of the tree as it was at `size` leaves. */
  root(size = this.size): Buffer {
    return this.rangeHash(0, size);
  }

  /** RFC 6962 PATH(index, D[0:size]). */
  inclusionProof(index: number, size = this.size): Buffer[] {
    if (!(index >= 0 && index < size && size <= this.size)) throw new Error("index outside the tree");
    const path = (m: number, lo: number, hi: number): Buffer[] => {
      const n = hi - lo;
      if (n === 1) return [];
      const k = splitPoint(n);
      return m < k ? [...path(m, lo, lo + k), this.rangeHash(lo + k, hi)] : [...path(m - k, lo + k, hi), this.rangeHash(lo, lo + k)];
    };
    return path(index, 0, size);
  }

  /** RFC 6962 PROOF(from, D[0:to]); empty when from is 0 or equals to. */
  consistencyProof(from: number, to = this.size): Buffer[] {
    if (!(from >= 0 && from <= to && to <= this.size)) throw new Error("sizes outside the tree");
    if (from === 0 || from === to) return [];
    const sub = (m: number, lo: number, hi: number, whole: boolean): Buffer[] => {
      const n = hi - lo;
      if (m === n) return whole ? [] : [this.rangeHash(lo, hi)];
      const k = splitPoint(n);
      return m <= k ? [...sub(m, lo, lo + k, whole), this.rangeHash(lo + k, hi)] : [...sub(m - k, lo + k, hi, false), this.rangeHash(lo, lo + k)];
    };
    return sub(from, 0, to, true);
  }

  /** The first `width` hashes of tile (level, index), concatenated; by default every hash the tree has for it. */
  tile(level: number, index: number, width = tileWidth(level, index, this.size)): Buffer {
    const w = width;
    if (!(w > 0 && w <= tileWidth(level, index, this.size))) throw new Error("tile does not exist yet");
    const nodeLevel = level * TILE_HEIGHT;
    const out: Buffer[] = [];
    for (let i = 0; i < w; i++) out.push(this.node(nodeLevel, index * TILE_WIDTH + i));
    return Buffer.concat(out);
  }
}

/** How many hashes tile (level, index) holds in a tree of `size` leaves (0 when it does not exist, at most 256). */
export function tileWidth(level: number, index: number, size: number): number {
  const nodes = MerkleTree.nodesAt(level * TILE_HEIGHT, size);
  return Math.max(0, Math.min(TILE_WIDTH, nodes - index * TILE_WIDTH));
}

// ---- verification (RFC 9162 section 2.1.3.2 and 2.1.4.2) ----------------------------------------------------------

export function verifyInclusion(index: number, size: number, leaf: Uint8Array, proof: Uint8Array[], root: Uint8Array): boolean {
  if (!(Number.isSafeInteger(index) && Number.isSafeInteger(size) && index >= 0 && index < size)) return false;
  let fn = index;
  let sn = size - 1;
  let r: Buffer = Buffer.from(leaf);
  for (const p of proof) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      r = nodeHash(p, r);
      if (!odd(fn)) while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else r = nodeHash(r, p);
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && r.equals(Buffer.from(root));
}

export function verifyConsistency(size1: number, size2: number, proof: Uint8Array[], root1: Uint8Array, root2: Uint8Array): boolean {
  if (!(Number.isSafeInteger(size1) && Number.isSafeInteger(size2) && size1 >= 0 && size1 <= size2)) return false;
  if (size1 === size2) return proof.length === 0 && Buffer.from(root1).equals(Buffer.from(root2));
  if (size1 === 0) return proof.length === 0; // every tree extends the empty one
  if (proof.length === 0) return false;
  const path = isPow2(size1) ? [root1, ...proof] : proof;
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (odd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr: Buffer = Buffer.from(path[0]);
  let sr: Buffer = Buffer.from(path[0]);
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!odd(fn)) while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else sr = nodeHash(sr, c);
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && fr.equals(Buffer.from(root1)) && sr.equals(Buffer.from(root2));
}

// ---- tile paths ---------------------------------------------------------------------------------------------------

/** tlog-tiles index encoding: 1234067 -> "x001/x234/067". */
export function encodeTileIndex(n: number): string {
  if (!(Number.isSafeInteger(n) && n >= 0)) throw new Error("bad tile index");
  let s = String(n);
  s = s.padStart(Math.ceil(s.length / 3) * 3, "0");
  const groups = s.match(/.{3}/g)!;
  return groups.map((g, i) => (i < groups.length - 1 ? "x" + g : g)).join("/");
}

/** Inverse of {@link encodeTileIndex}; null for anything that is not the canonical encoding. */
export function decodeTileIndex(path: string): number | null {
  const parts = path.split("/");
  if (!parts.length || parts.length > 6) return null;
  let s = "";
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const m = (last ? /^(\d{3})$/ : /^x(\d{3})$/).exec(parts[i]);
    if (!m) return null;
    s += m[1];
  }
  if (parts.length > 1 && parts[0] === "x000") return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export type TileRef = { level: number | "entries"; index: number; width: number | null };

/** The path of a tile under the log prefix: "tile/0/x001/234", "tile/entries/000.p/7". */
export function tilePath(t: TileRef): string {
  return `tile/${t.level}/${encodeTileIndex(t.index)}${t.width === null ? "" : `.p/${t.width}`}`;
}

/** Parse the part after "tile/"; null when it is not a canonical tile path. */
export function parseTilePath(rest: string): TileRef | null {
  const m = /^(entries|0|[1-9]\d?)\/(.+?)(?:\.p\/([1-9]\d{0,2}))?$/.exec(rest);
  if (!m) return null;
  const index = decodeTileIndex(m[2]);
  if (index === null) return null;
  const width = m[3] === undefined ? null : Number(m[3]);
  if (width !== null && width >= TILE_WIDTH) return null;
  const level = m[1] === "entries" ? "entries" : Number(m[1]);
  if (level !== "entries" && level > 63) return null;
  return { level, index, width };
}

/** An entry bundle: each entry as a big-endian uint16 length followed by its bytes. */
export function encodeEntryBundle(entries: Uint8Array[]): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    if (e.length > MAX_ENTRY_BYTES) throw new Error("entry too large for a bundle");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(e.length);
    out.push(len, Buffer.from(e));
  }
  return Buffer.concat(out);
}

export function decodeEntryBundle(bundle: Uint8Array): Buffer[] {
  const b = Buffer.from(bundle);
  const out: Buffer[] = [];
  let at = 0;
  while (at < b.length) {
    if (at + 2 > b.length) throw new Error("truncated entry bundle");
    const n = b.readUInt16BE(at);
    if (at + 2 + n > b.length) throw new Error("truncated entry bundle");
    out.push(b.subarray(at + 2, at + 2 + n));
    at += 2 + n;
  }
  return out;
}
