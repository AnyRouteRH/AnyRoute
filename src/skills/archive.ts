import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

// Skill archives: read a tarball (plain or gzip) or a zip into a list of files, and write the one canonical tar the registry
// hashes and serves. Nothing is extracted to disk: entries are parsed in memory under size, count and path limits, so a
// hostile archive (path traversal, zip bomb, device files, huge headers) is refused before any file is scanned.
//
// Canonical form: regular files and symlinks only, sorted by the UTF-8 bytes of their path, ustar headers with mode 0644
// (0755 when any execute bit was set, 0777 for a symlink), uid/gid 0, empty owner names and mtime 0, then two zero blocks.
// content_hash = sha256 of that tar, so the same files always give the same hash whatever tool packed them.

export type SkillFile = { path: string; type: "file" | "symlink"; mode: number; data: Uint8Array; target?: string };
export type Limits = { maxBytes: number; maxFiles: number };
export type FileEntry = { path: string; type: "file" | "symlink"; mode: number; size: number; sha256: string; target?: string };

export class ArchiveError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });
const BLOCK = 512;

/** Junk that archivers add and a skill never means: macOS resource forks and Finder files, and a checked-out .git directory. */
const JUNK = /(^|\/)(__MACOSX|\.git)(\/|$)|(^|\/)\.DS_Store$|(^|\/)\._[^/]*$/;

/** A safe relative path: no absolute path, no drive letter, no `..`, no NUL or control characters, at most 255 bytes. */
export function normalizePath(raw: string): string | null {
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new ArchiveError(`Unsafe path in archive: ${JSON.stringify(raw.slice(0, 80))}.`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new ArchiveError(`Absolute path in archive: ${raw.slice(0, 80)}.`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new ArchiveError(`Path traversal in archive: ${raw.slice(0, 80)}.`);
  if (!parts.length) return null;
  const path = parts.join("/");
  if (enc.encode(path).length > 255) throw new ArchiveError(`Path longer than 255 bytes: ${path.slice(0, 80)}...`);
  return path;
}

const modeOf = (mode: number, type: SkillFile["type"]) => (type === "symlink" ? 0o777 : mode & 0o111 ? 0o755 : 0o644);

class Collector {
  files = new Map<string, SkillFile>();
  bytes = 0;
  constructor(private limits: Limits) {}
  add(rawPath: string, type: SkillFile["type"], mode: number, data: Uint8Array, target?: string) {
    const path = normalizePath(rawPath);
    if (!path || JUNK.test(path)) return;
    this.bytes += data.length;
    if (this.bytes > this.limits.maxBytes) throw new ArchiveError(`The skill is larger than ${this.limits.maxBytes} bytes unpacked.`);
    if (this.files.size >= this.limits.maxFiles && !this.files.has(path)) throw new ArchiveError(`The skill has more than ${this.limits.maxFiles} files.`);
    this.files.set(path, { path, type, mode: modeOf(mode, type), data, ...(type === "symlink" ? { target: target ?? "" } : {}) });
  }
  list() {
    return [...this.files.values()];
  }
}

/** Apply the path rules, junk filter and limits to files that did not come from an archive (a repository tree). */
export function collectFiles(files: SkillFile[], limits: Limits): SkillFile[] {
  const c = new Collector(limits);
  for (const f of files) c.add(f.path, f.type, f.mode, f.data, f.target);
  return c.list();
}

// ---------------------------------------------------------------------------------------------------------------------
// tar

const field = (b: Uint8Array, off: number, len: number) => {
  const s = b.subarray(off, off + len);
  const nul = s.indexOf(0);
  return dec.decode(nul >= 0 ? s.subarray(0, nul) : s);
};
function octal(b: Uint8Array, off: number, len: number): number {
  if (b[off] & 0x80) throw new ArchiveError("Base-256 sizes in tar headers are not supported.");
  const s = field(b, off, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError("Malformed tar header.");
  return parseInt(s, 8);
}
function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const text = dec.decode(data);
  // "<len> <key>=<value>\n", where len counts the whole record in bytes; decoded text is close enough for ASCII keys.
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isInteger(len) || len <= 0) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTar(buf: Uint8Array, limits: Limits): SkillFile[] {
  const c = new Collector(limits);
  let off = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  let entries = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break;
    if (++entries > limits.maxFiles * 4 + 16) throw new ArchiveError("Too many entries in the tar archive.");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new ArchiveError("Tar header checksum mismatch.");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = off + BLOCK;
    if (dataStart + size > buf.length) throw new ArchiveError("Truncated tar archive.");
    if (size > limits.maxBytes) throw new ArchiveError(`A file is larger than ${limits.maxBytes} bytes.`);
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    const magic = field(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(h, 345, 155) : "";
    let name = longName ?? pax.path ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    const link = longLink ?? pax.linkpath ?? field(h, 157, 100);
    if (type === "L") { longName = dec.decode(data).replace(/\0+$/, ""); continue; }
    if (type === "K") { longLink = dec.decode(data).replace(/\0+$/, ""); continue; }
    if (type === "x") { pax = paxRecords(data); continue; }
    if (type === "g") continue; // global header (git archive writes the commit id here)
    longName = longLink = null;
    pax = {};
    const mode = octal(h, 100, 8);
    if (type === "0" || type === "7") c.add(name, "file", mode, new Uint8Array(data));
    else if (type === "2") c.add(name, "symlink", mode, enc.encode(link), link);
    else if (type === "5") continue;
    else if (type === "1") throw new ArchiveError(`Hard links are not allowed in a skill (${name.slice(0, 80)}).`);
    else throw new ArchiveError(`Device, FIFO and other special files are not allowed in a skill (${name.slice(0, 80)}).`);
    name = "";
  }
  return c.list();
}

// ---------------------------------------------------------------------------------------------------------------------
// zip (stored and deflate; no encryption, no zip64)

export function readZip(buf: Uint8Array, limits: Limits): SkillFile[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveError("Not a zip archive (no end of central directory).");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (count > limits.maxFiles * 2 + 16) throw new ArchiveError("Too many entries in the zip archive.");
  const c = new Collector(limits);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) throw new ArchiveError("Malformed zip central directory.");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const madeBy = v.getUint16(p + 4, true) >> 8;
    const attrs = v.getUint32(p + 38, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ArchiveError("Encrypted zip entries are not allowed.");
    if (compSize === 0xffffffff || size === 0xffffffff) throw new ArchiveError("Zip64 archives are not supported.");
    if (size > limits.maxBytes) throw new ArchiveError(`A file is larger than ${limits.maxBytes} bytes.`);
    if (name.endsWith("/")) continue;
    if (local + 30 > buf.length || v.getUint32(local, true) !== 0x04034b50) throw new ArchiveError("Malformed zip local header.");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + compSize > buf.length) throw new ArchiveError("Truncated zip archive.");
    const raw = buf.subarray(start, start + compSize);
    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }));
      } catch {
        throw new ArchiveError(`A zip entry does not inflate to its declared size (${name.slice(0, 80)}).`);
      }
    } else throw new ArchiveError(`Unsupported zip compression method ${method}.`);
    if (data.length !== size) throw new ArchiveError(`A zip entry does not match its declared size (${name.slice(0, 80)}).`);
    const unixMode = madeBy === 3 ? attrs >>> 16 : 0o644;
    const kind = unixMode & 0o170000;
    if (kind === 0o120000) c.add(name, "symlink", unixMode, data, dec.decode(data));
    else if (kind === 0 || kind === 0o100000) c.add(name, "file", unixMode & 0o7777, data);
    else throw new ArchiveError(`Special files are not allowed in a skill (${name.slice(0, 80)}).`);
  }
  return c.list();
}

/** Detect the format from its magic bytes and read it. */
export function readArchive(bytes: Uint8Array, limits: Limits): SkillFile[] {
  if (bytes.length > limits.maxBytes + (limits.maxFiles + 4) * 1024) throw new ArchiveError(`The archive is larger than ${limits.maxBytes} bytes.`);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readZip(bytes, limits);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    let tar: Uint8Array;
    try {
      tar = new Uint8Array(gunzipSync(bytes, { maxOutputLength: limits.maxBytes + (limits.maxFiles + 4) * 1536 }));
    } catch {
      throw new ArchiveError(`The archive is not valid gzip, or unpacks to more than ${limits.maxBytes} bytes.`);
    }
    return readTar(tar, limits);
  }
  if (bytes.length >= 512 && field(bytes, 257, 5) === "ustar") return readTar(bytes, limits);
  if (bytes.length >= 512) return readTar(bytes, limits); // v7 tar has no magic; the checksum check rejects anything else
  throw new ArchiveError("Unrecognised archive: send a .tar, .tar.gz or .zip.");
}

// ---------------------------------------------------------------------------------------------------------------------
// normalisation and the canonical tar

/**
 * The skill's own files: those under `subpath` when given, otherwise the whole archive, with one wrapping directory removed
 * when SKILL.md is not at the top (archives made with `tar czf x.tgz my-skill/` or GitHub's zipball have one).
 */
export function skillRoot(files: SkillFile[], subpath?: string | null): SkillFile[] {
  let out = files;
  const strip = (prefix: string) => out.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
  if (subpath) {
    const p = normalizePath(subpath);
    if (p) out = strip(p + "/");
  }
  for (let i = 0; i < 2 && !out.some((f) => f.path === "SKILL.md"); i++) {
    const tops = new Set(out.map((f) => f.path.split("/")[0]));
    if (tops.size !== 1 || out.some((f) => !f.path.includes("/"))) break;
    out = strip([...tops][0] + "/");
  }
  return out;
}

const cmpBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function writeOctal(h: Uint8Array, off: number, len: number, value: number) {
  const s = value.toString(8).padStart(len - 1, "0") + "\0";
  h.set(enc.encode(s), off);
}
function splitUstar(path: string): [string, string] {
  const bytes = enc.encode(path);
  if (bytes.length <= 100) return ["", path];
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100 && name) return [prefix, name];
  }
  throw new ArchiveError(`Path cannot be stored in a ustar header: ${path.slice(0, 80)}...`);
}

/** The canonical tar of a skill's files (see the top of this file). */
export function canonicalTar(files: SkillFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => cmpBytes(a.path, b.path));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const f of sorted) {
    const h = new Uint8Array(BLOCK);
    const [prefix, name] = splitUstar(f.path);
    h.set(enc.encode(name), 0);
    writeOctal(h, 100, 8, modeOf(f.mode, f.type));
    writeOctal(h, 108, 8, 0);
    writeOctal(h, 116, 8, 0);
    const body = f.type === "file" ? f.data : new Uint8Array(0);
    writeOctal(h, 124, 12, body.length);
    writeOctal(h, 136, 12, 0);
    h[156] = f.type === "symlink" ? 0x32 : 0x30;
    if (f.type === "symlink") {
      const t = enc.encode(f.target ?? "");
      if (t.length > 100) throw new ArchiveError(`Symlink target longer than 100 bytes in ${f.path.slice(0, 80)}.`);
      h.set(t, 157);
    }
    h.set(enc.encode("ustar\0"), 257);
    h.set(enc.encode("00"), 263);
    h.set(enc.encode(prefix), 345);
    h.fill(32, 148, 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    chunks.push(h, body);
    total += BLOCK + body.length;
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) { chunks.push(new Uint8Array(pad)); total += pad; }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.length; }
  return out;
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** content_hash: sha256 of the canonical tar. */
export const contentHash = (files: SkillFile[]) => sha256Hex(canonicalTar(files));

/** The gzipped canonical tar the registry stores and serves (gzip header mtime 0, so it is stable too). */
export const packSkill = (files: SkillFile[]) => new Uint8Array(gzipSync(canonicalTar(files), { level: 9 }));

/** The file list stored with a skill: path, type, mode, size and sha256 of each file, in canonical order. */
export const fileEntries = (files: SkillFile[]): FileEntry[] =>
  [...files]
    .sort((a, b) => cmpBytes(a.path, b.path))
    .map((f) => ({ path: f.path, type: f.type, mode: modeOf(f.mode, f.type), size: f.data.length, sha256: sha256Hex(f.data), ...(f.type === "symlink" ? { target: f.target } : {}) }));
