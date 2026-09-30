// Ask your files: the pure parts of the page at /ask/. Nothing here touches the DOM, the network or browser storage,
// so all of it runs (and is tested) under Node. Files are turned into plain text here, in the browser; the page sends
// that text to POST /api/v1/rag and shows the answer, the sources and the receipts that come back.
//
// The router's own limits and chunker are mirrored so the page can say, before anything is sent, what a request will
// hold. test/web-ask.test.ts (in the repository's test suite) checks the chunker against src/rag/text.ts and the request
// against the running endpoint, so the copy here cannot drift from the router without a failing test.

// ---------------------------------------------------------------------------------------------------------------
// Limits (the router's defaults: RAG_MAX_DOCUMENTS, RAG_MAX_BYTES, RAG_MAX_CHUNKS, RAG_MAX_EMBEDDING_CALLS)

/** What one request may carry on a router that has not changed the defaults. A router that has says so when it refuses. */
export const LIMITS = Object.freeze({ documents: 200, bytes: 2 * 1024 * 1024, chunks: 2000, embeddingCalls: 64 });
/** Inputs the router puts in one embeddings call, before the embedding model's context narrows it. The question goes in with the first. */
export const EMBED_BATCH_ITEMS = 64;
export const QUESTION_MAX = 8000;
export const TOP_K = Object.freeze({ min: 1, max: 20, default: 4 });
export const CHUNK_SIZE = Object.freeze({ min: 100, max: 8000, default: 1000 });
/** The router's default overlap for a chunk size. */
export const overlapFor = (size) => Math.round(size * 0.15);

/** A file larger than this is not opened at all (it would only freeze the tab; no request can carry that much text). */
export const READ_LIMIT_BYTES = 20 * 1024 * 1024;
/** A Word document's text part may not unpack to more than this (a guard against a zip bomb). */
export const INFLATE_LIMIT_BYTES = 40 * 1024 * 1024;
/** How many files the page lists at once, and how much text it holds at once. Both far above what a request can carry. */
export const MAX_LISTED_FILES = 300;
export const MAX_HELD_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Formats

const KINDS = Object.freeze({ txt: "text", text: "text", md: "markdown", markdown: "markdown", csv: "csv", tsv: "csv", json: "json", html: "html", htm: "html", docx: "docx", pdf: "pdf" });
export const ACCEPT = ".txt,.text,.md,.markdown,.csv,.tsv,.json,.html,.htm,.docx,.pdf";
export const SUPPORTED = Object.freeze([".txt", ".md", ".csv", ".json", ".html", ".docx"]);

export const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name).trim());
  return m ? m[1].toLowerCase() : "";
};
/** "text" | "markdown" | "csv" | "json" | "html" | "docx" | "pdf", or null for anything else. */
export const kindOf = (name) => KINDS[extOf(name)] ?? null;

/** A file that cannot be read as text, with a reason worth showing. */
export class ParseError extends Error {}

const utf8 = new TextEncoder();
/** The bytes a text takes in UTF-8, which is how the router counts document text against its size limit. */
export const utf8Bytes = (text) => utf8.encode(text).length;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** UTF-8 (or UTF-16 with a byte order mark) to a string; anything else is refused rather than guessed at. */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let label = "utf-8";
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) label = "utf-16le";
  else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) label = "utf-16be";
  let s;
  try {
    s = new TextDecoder(label, { fatal: true }).decode(u8);
  } catch {
    throw new ParseError("This is not UTF-8 text. Save it as UTF-8 and add it again.");
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.includes("\u0000")) throw new ParseError("This looks like a binary file, not text.");
  return s;
}

/** Line ends as \n, control characters as spaces, runs of blank lines as one, and no blank space at either end. */
export function tidy(s) {
  return String(s)
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, (c) => (c === "\t" || c === "\n" ? c : " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- CSV ------------------------------------------------------------------------------------------------------

/** RFC 4180 records from text whose line ends are already \n. A quote opens a quoted field only at the start of a field. */
export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function guessDelimiter(text) {
  const line = text.split("\n", 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let n = 0;
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (!quoted && c === d) n++;
    }
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * A table as text a search can use: the first row names the columns, and each following row becomes one line,
 * "column: value; column: value", with empty cells left out. A table of one row is written as it is.
 */
export function csvToText(text) {
  const rows = parseCsv(text, guessDelimiter(text));
  if (!rows.length) return "";
  const flat = (s) => s.trim().replace(/\s*\n\s*/g, " / ");
  if (rows.length === 1) return rows[0].map(flat).filter(Boolean).join(", ");
  const seen = new Set();
  const names = rows[0].map((h, i) => {
    const name = flat(h);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return `column ${i + 1}`;
    seen.add(key);
    return name;
  });
  return rows
    .slice(1)
    .map((r) =>
      r
        .map((cell, i) => [names[i] ?? `column ${i + 1}`, flat(cell)])
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; "),
    )
    .filter(Boolean)
    .join("\n");
}

// ---- JSON -----------------------------------------------------------------------------------------------------

/** JSON, written with one value to a line so a chunk ends on a line. Anything that is not JSON is refused. */
export function jsonToText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ParseError("This is not valid JSON. If it is plain text, rename it to .txt.");
  }
  return JSON.stringify(value, null, 2) ?? "";
}

// ---- HTML and XML entities ------------------------------------------------------------------------------------

const NAMED = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
  laquo: "«", raquo: "»", sect: "§", para: "¶", plusmn: "±", frac12: "½", larr: "←", rarr: "→",
});

/** Character references decoded once, in a single pass: "&amp;lt;" becomes "&lt;", not "<". Unknown names are left as written. */
export function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,10}));/g, (m, dec, hex, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name] : m;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
    return String.fromCodePoint(cp);
  });
}

const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const tagRe = (names, flags = "gi") => new RegExp(`</?(?:${names})\\b${ATTRS}>`, flags);
const CELL = "\u0001"; // the end of a table cell
const SOFT = "\u0002"; // a line break
const HARD = "\u0003"; // a paragraph break

/** Rows whose cells were marked with CELL become "a | b | c". */
function joinCells(text) {
  return text
    .split("\n")
    .map((line) =>
      line.includes(CELL)
        ? line
            .split(CELL)
            .map((c) => c.trim())
            .filter(Boolean)
            .join(" | ")
        : line,
    )
    .join("\n");
}

/**
 * The readable text of a page. Nothing in it is run or fetched: scripts, styles, comments, the head (but for the
 * title), embedded objects and every tag are dropped, block elements become line or paragraph breaks and table
 * cells are joined with " | ". Line breaks in the source are spaces, as in a browser, except inside <pre>. Layout is not kept.
 */
export function htmlToText(html) {
  let s = tidy(html);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s)?.[1];
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  s = s.replace(/<[!?][^>]*>/g, " ");
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
  s = s.replace(/<(script|style|noscript|template|svg|iframe|object|canvas|select|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  s = s.replace(/(<pre\b[^>]*>)([\s\S]*?)(<\/pre\s*>)/gi, (_, open, inner, close) => open + inner.replace(/\n/g, SOFT) + close);
  s = s.replace(new RegExp(`<br\\b${ATTRS}>`, "gi"), SOFT);
  s = s.replace(tagRe("p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|table|thead|tbody|tfoot|blockquote|pre|figure|figcaption|form|fieldset|details|summary|address|hr|dl"), HARD);
  s = s.replace(tagRe("li|tr|dt|dd|caption|option"), SOFT);
  s = s.replace(/<\/(?:td|th)\s*>/gi, CELL);
  s = s.replace(new RegExp(`</?[a-zA-Z]${ATTRS}>`, "g"), "");
  s = decodeEntities(s).replace(/[\u00a0\u3000]/g, " ");
  s = s.replace(/[ \t\r\n\f\v]+/g, " ");
  s = s.replace(/ ?([\u0002\u0003]+) ?/g, (_, marks) => (marks.includes(HARD) ? "\n\n" : "\n"));
  s = joinCells(s)
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
  const head = title ? tidy(decodeEntities(title.replace(new RegExp(`</?[a-zA-Z]${ATTRS}>`, "g"), "")).replace(/\s+/g, " ")) : "";
  return tidy(head ? `${head}\n\n${s}` : s);
}

// ---- Word documents (.docx) -----------------------------------------------------------------------------------
// A .docx is a zip of XML parts. The text is in word/document.xml. The zip is read with a few dozen lines and the
// browser's own DecompressionStream, so no library is needed. Only the body text is read (text boxes included): not
// headers, footers, footnotes, comments or tracked deletions.

const le16 = (v, o) => v.getUint16(o, true);
const le32 = (v, o) => v.getUint32(o, true);
const damaged = () => new ParseError("This Word file is damaged, so its text could not be read.");

async function inflateRaw(data, max) {
  if (typeof DecompressionStream === "undefined") throw new ParseError("This browser cannot unpack .docx files. Save the document as .txt or .html and add that.");
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer
    .write(data)
    .then(() => writer.close())
    .catch(() => undefined); // a damaged stream shows up when it is read
  const reader = ds.readable.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new ParseError("This Word file unpacks to far more text than a request can carry.");
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw damaged();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One file out of a zip, unpacked, or null if the zip has no file of that name. Reads the central directory; no ZIP64, no encryption. */
export async function readZipEntry(bytes, wanted, limit = INFLATE_LIMIT_BYTES) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (le32(v, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ParseError("This is not a Word (.docx) file: it is not a zip archive.");
  const entries = le16(v, eocd + 10);
  const dirSize = le32(v, eocd + 12);
  const dirAt = le32(v, eocd + 16);
  if (entries === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) throw new ParseError("This zip archive uses a format (ZIP64) that this page does not read.");
  if (dirAt + dirSize > buf.length) throw damaged();
  const names = new TextDecoder();
  let p = dirAt;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || le32(v, p) !== 0x02014b50) throw damaged();
    const flags = le16(v, p + 8);
    const method = le16(v, p + 10);
    const packed = le32(v, p + 20);
    const size = le32(v, p + 24);
    const nameLen = le16(v, p + 28);
    const extraLen = le16(v, p + 30);
    const commentLen = le16(v, p + 32);
    const local = le32(v, p + 42);
    if (p + 46 + nameLen > buf.length) throw damaged();
    const name = names.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (flags & 1) throw new ParseError("This Word file is password-protected, so it cannot be read.");
    if (size > limit) throw new ParseError("This Word file unpacks to far more text than a request can carry.");
    if (local + 30 > buf.length || le32(v, local) !== 0x04034b50) throw damaged();
    const start = local + 30 + le16(v, local + 26) + le16(v, local + 28);
    if (start + packed > buf.length) throw damaged();
    const data = buf.subarray(start, start + packed);
    if (method === 0) {
      if (data.length !== size) throw damaged();
      return data;
    }
    if (method !== 8) throw new ParseError("This Word file uses a compression method this page does not read.");
    const out = await inflateRaw(data, Math.min(limit, size));
    if (out.length !== size) throw damaged();
    return out;
  }
  return null;
}

/** The text of a WordprocessingML body: runs, tabs, breaks, paragraphs and tables. Deleted text and fallback copies are left out. */
export function docxXmlToText(xml) {
  let out = "";
  let inText = false;
  let run = "";
  let skip = 0; // inside <mc:Fallback>, the second copy of a text box
  let tables = 0;
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (inText && skip === 0 && lt > i) run += xml.slice(i, lt);
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    let j = lt + 1;
    let q = "";
    for (; j < n; j++) {
      const c = xml[j];
      if (q) {
        if (c === q) q = "";
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    const tag = xml.slice(lt + 1, j);
    i = j + 1;
    const closing = tag.startsWith("/");
    const selfClosed = tag.endsWith("/");
    const name = /^\/?([A-Za-z][\w.:-]*)/.exec(tag)?.[1];
    if (!name) continue;
    if (name === "mc:Fallback") {
      if (closing) skip = Math.max(0, skip - 1);
      else if (!selfClosed) skip++;
      continue;
    }
    if (skip) continue;
    switch (name) {
      case "w:t":
        if (closing) {
          out += decodeEntities(run);
          run = "";
          inText = false;
        } else if (!selfClosed) {
          inText = true;
          run = "";
        }
        break;
      case "w:tab":
        if (!closing) out += "\t";
        break;
      case "w:br":
      case "w:cr":
        if (!closing) out += "\n";
        break;
      case "w:noBreakHyphen":
        if (!closing) out += "-";
        break;
      case "w:p":
        if (closing) out += tables ? " " : "\n";
        break;
      case "w:tbl":
        if (closing) {
          tables = Math.max(0, tables - 1);
          out += "\n";
        } else if (!selfClosed) tables++;
        break;
      case "w:tc":
        if (closing) out += CELL;
        break;
      case "w:tr":
        if (closing) out += "\n";
        break;
      default:
    }
  }
  return joinCells(out.replace(/\t/g, " ").replace(/[ ]+\n/g, "\n"));
}

/** The body text of a .docx file. */
export async function docxToText(bytes) {
  const part = await readZipEntry(bytes, "word/document.xml");
  if (!part) throw new ParseError("This is not a Word (.docx) document: it has no body text part.");
  return docxXmlToText(new TextDecoder().decode(part));
}

// ---- one file ---------------------------------------------------------------------------------------------------

/**
 * A file's bytes as text, or the reason it cannot be used. PDF is recognised and declined ("coming soon"); nothing
 * is guessed for a format that is not listed.
 * @returns {Promise<{ok: true, kind: string, text: string, bytes: number} | {ok: false, error: string, soon?: true}>}
 */
export async function parseFile(name, bytes) {
  const kind = kindOf(name);
  if (kind === "pdf") return { ok: false, soon: true, error: "PDF coming soon." };
  if (!kind) {
    const ext = extOf(name);
    if (ext === "doc") return { ok: false, error: "Old .doc files are not supported. Save it as .docx and add that." };
    return { ok: false, error: `${ext ? "." + ext : "This"} is not a supported format. Supported: ${SUPPORTED.join(", ")}.` };
  }
  try {
    let text;
    if (kind === "docx") text = await docxToText(bytes);
    else {
      const raw = decodeText(bytes);
      text = kind === "csv" ? csvToText(raw.replace(/\r\n?/g, "\n")) : kind === "json" ? jsonToText(raw) : kind === "html" ? htmlToText(raw) : raw;
    }
    text = tidy(text);
    if (!text) throw new ParseError("No text was found in this file.");
    const size = utf8Bytes(text);
    if (size > LIMITS.bytes) throw new ParseError(`This file has ${formatBytes(size)} of text, and one request may carry at most ${formatBytes(LIMITS.bytes)} in all.`);
    return { ok: true, kind, text, bytes: size };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message };
    return { ok: false, error: "This file could not be read." };
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MiB`;
}

// ---------------------------------------------------------------------------------------------------------------
// Chunking (a copy of src/rag/text.ts chunkText: the router cuts documents this way, so the page can count the
// chunks a request will hold and place a source in the text it came from)

const isSpace = (ch) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v" || ch === " " || ch === "　";
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

function boundary(text, floor, end) {
  const window = text.slice(floor, end);
  const para = window.lastIndexOf("\n\n");
  if (para >= 0) return floor + para + 2;
  const line = window.lastIndexOf("\n");
  if (line >= 0) return floor + line + 1;
  let sentence = -1;
  for (let i = window.length - 2; i >= 0; i--) {
    const ch = window[i];
    if ((ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "！" || ch === "？") && isSpace(window[i + 1])) {
      sentence = i + 1;
      break;
    }
  }
  if (sentence >= 0) return floor + sentence;
  for (let i = window.length - 1; i >= 0; i--) if (isSpace(window[i])) return floor + i + 1;
  return -1;
}

/** Overlapping windows of at most `size` characters, each { start, end, text } with text === doc.slice(start, end). */
export function chunkText(text, size, overlap) {
  if (!(Number.isInteger(size) && size >= 1) || !(Number.isInteger(overlap) && overlap >= 0 && overlap < size)) throw new RangeError("chunk size must be >= 1 and overlap in [0, size)");
  const out = [];
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    while (pos < n && isSpace(text[pos])) pos++;
    if (pos >= n) break;
    let end = Math.min(pos + size, n);
    if (end < n) {
      const cut = boundary(text, pos + Math.floor(size * 0.6), end);
      if (cut > pos) end = cut;
      if (end < n && isHigh(text.charCodeAt(end - 1)) && end - 1 > pos) end--;
    }
    let last = end;
    while (last > pos && isSpace(text[last - 1])) last--;
    if (last > pos) out.push({ start: pos, end: last, text: text.slice(pos, last) });
    if (end >= n) break;
    let next = end - overlap;
    if (next <= pos) next = end;
    else if (next < end) {
      if (!isSpace(text[next - 1])) {
        let j = next;
        while (j < end && !isSpace(text[j])) j++;
        if (j < end) {
          while (j < end && isSpace(text[j])) j++;
          next = j;
        }
      }
      if (next < end && isLow(text.charCodeAt(next))) next++;
    }
    pos = next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What a request will hold, before it is sent

/**
 * Where a set of documents stands against the limits. `docs` are { text }; chunk counts are computed with the router's
 * chunker at the given size. `over` lists what would be refused (413) and `blocked` is true if there is any.
 * The embeddings calls shown are a floor: a model with a small context needs more calls than 64 texts each.
 */
export function planRequest(docs, { chunkSize = CHUNK_SIZE.default, limits = LIMITS, chunks } = {}) {
  const overlap = overlapFor(chunkSize);
  let bytes = 0;
  let count = 0;
  const lengths = [];
  docs.forEach((d, i) => {
    bytes += utf8Bytes(d.text);
    const cs = chunks ? chunks[i] : chunkText(d.text, chunkSize, overlap);
    count += cs.length;
    for (const c of cs) lengths.push(c.text ? c.text.length : c.end - c.start);
  });
  const embeddingCalls = count ? Math.ceil((count + 1) / EMBED_BATCH_ITEMS) : 0;
  const rows = [
    { key: "documents", label: "Documents", used: docs.length, limit: limits.documents },
    { key: "bytes", label: "Text", used: bytes, limit: limits.bytes, bytes: true },
    { key: "chunks", label: "Chunks", used: count, limit: limits.chunks },
    { key: "embeddingCalls", label: "Embeddings calls", used: embeddingCalls, limit: limits.embeddingCalls, floor: true },
  ].map((r) => ({ ...r, over: r.used > r.limit, share: r.limit ? Math.min(1, r.used / r.limit) : 0 }));
  const over = rows.filter((r) => r.over).map((r) => r.key);
  return { rows, over, blocked: over.length > 0, documents: docs.length, bytes, chunks: count, embeddingCalls, chunkLengths: lengths, overlap };
}

/** The router's estimate of the largest prompt the answer step can make, in tokens (chars/3), for the top_k longest chunks. */
export function estimatePromptTokens(chunkLengths, question, topK) {
  const longest = [...chunkLengths].sort((a, b) => b - a).slice(0, topK);
  const chars = longest.reduce((n, x) => n + x, 0) + String(question).length + 1200 + 120 * longest.length;
  return Math.ceil(chars / 3) + 8;
}

/** Why a request cannot be sent yet, in the order a person would fix them; empty when it can. */
export function problems({ key, docs, plan, question, model, topK, chunkSize, contextLength }) {
  const out = [];
  if (!key) out.push("Connect your API key.");
  if (!docs.length) out.push("Add at least one file.");
  if (plan?.blocked) out.push("The files are over a limit below. Remove some.");
  if (!String(question ?? "").trim()) out.push("Write a question.");
  else if (String(question).trim().length > QUESTION_MAX) out.push(`The question is longer than ${QUESTION_MAX} characters.`);
  if (!model) out.push("Choose a model.");
  if (!Number.isInteger(topK) || topK < TOP_K.min || topK > TOP_K.max) out.push(`Passages to use must be from ${TOP_K.min} to ${TOP_K.max}.`);
  if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_SIZE.min || chunkSize > CHUNK_SIZE.max) out.push(`Passage size must be from ${CHUNK_SIZE.min} to ${CHUNK_SIZE.max} characters.`);
  if (plan && contextLength && Number.isInteger(topK) && estimatePromptTokens(plan.chunkLengths, question ?? "", topK) > contextLength)
    out.push("The passages could be longer than this model's context. Use fewer passages, smaller passages or a model with a longer context.");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The request

/** The lanes the page offers: attested and public state the lane on every call; auto states none and lets the router choose. */
export const LANES = Object.freeze(["attested", "public", "auto"]);

/**
 * The body for POST /api/v1/rag. Documents are sent as doc-1, doc-2 and so on: file names never leave the browser.
 * The chunk size and overlap are always sent, so the count the page showed is the count the router makes. Excerpts are
 * not requested: the page already holds the text and finds a source by its offsets.
 */
export function buildRagRequest({ docs, question, model, lane = "attested", topK = TOP_K.default, chunkSize = CHUNK_SIZE.default }) {
  if (!Array.isArray(docs) || !docs.length) throw new RangeError("Add at least one document.");
  if (typeof model !== "string" || !model) throw new RangeError("Choose a model.");
  const q = String(question ?? "").trim();
  if (!q || q.length > QUESTION_MAX) throw new RangeError(`The question must be from 1 to ${QUESTION_MAX} characters.`);
  if (!LANES.includes(lane)) throw new RangeError("Unknown lane.");
  if (!Number.isInteger(topK) || topK < TOP_K.min || topK > TOP_K.max) throw new RangeError("top_k is out of range.");
  if (!Number.isInteger(chunkSize) || chunkSize < CHUNK_SIZE.min || chunkSize > CHUNK_SIZE.max) throw new RangeError("The chunk size is out of range.");
  return {
    documents: docs.map((d, i) => ({ id: `doc-${i + 1}`, text: d.text })),
    question: q,
    model,
    top_k: topK,
    chunk: { size: chunkSize, overlap: overlapFor(chunkSize) },
    ...(lane === "auto" ? {} : { provider: { lane } }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Models

const has = (list, x) => Array.isArray(list) && list.includes(x);
const attestedEndpoints = (m) => Number(m?.disclosure?.endpoints?.attested ?? 0) || (has(m?.lanes, "attested") ? 1 : 0);

/** The catalog reduced to what the page needs: chat models and embedding models, with their attested endpoints and prices. */
export function readCatalog(list) {
  const chat = [];
  const embedding = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const out = m.architecture?.output_modalities;
    const modalities = Array.isArray(out) ? out : ["text"];
    const row = {
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      context: Number(m.top_provider?.context_length) || Number(m.context_length) || 0,
      attested: attestedEndpoints(m) > 0,
      prompt: Number(m.pricing?.prompt) || 0,
      completion: Number(m.pricing?.completion) || 0,
    };
    if (modalities.includes("embeddings")) embedding.push(row);
    else if (modalities.includes("text")) chat.push(row);
  }
  const byName = (a, b) => a.id.localeCompare(b.id);
  return { chat: chat.sort(byName), embedding: embedding.sort(byName) };
}

/** The chat models a lane can use: with the attested lane, only those with an attested endpoint. */
export const modelsFor = (catalog, lane) => (lane === "attested" ? catalog.chat.filter((m) => m.attested) : catalog.chat);

/**
 * The model to preselect: the one already chosen if the lane still allows it, else the cheapest with a context of at
 * least 32,000 tokens, else the one with the longest context.
 */
export function pickModel(catalog, lane, current) {
  const pool = modelsFor(catalog, lane);
  if (current && pool.some((m) => m.id === current)) return current;
  const roomy = pool.filter((m) => m.context >= 32000);
  const price = (m) => m.prompt + m.completion;
  const cheapest = [...roomy].sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id))[0];
  const longest = [...pool].sort((a, b) => b.context - a.context || a.id.localeCompare(b.id))[0];
  return (cheapest ?? longest)?.id ?? "";
}

/** A plain warning when the lane the person chose cannot be served right now, from the catalog as read; null when nothing is known to be wrong. */
export function laneAdvice(catalog, lane, modelId) {
  const model = catalog.chat.find((m) => m.id === modelId);
  const embedAttested = catalog.embedding.some((m) => m.attested);
  if (lane === "attested") {
    if (!modelsFor(catalog, "attested").length) return "No chat model has an attested endpoint right now, so the attested lane would refuse this request. Nothing would be sent.";
    if (!embedAttested) return "No embedding model has an attested endpoint right now, so the attested lane would refuse this request. Nothing would be sent.";
    return null;
  }
  if (lane === "auto") {
    if (model && !model.attested) return "This model has no attested endpoint, so the router will use its public lane and say why.";
    if (!embedAttested) return "No embedding model has an attested endpoint right now, so the router will use its public lane and say why.";
  }
  return null;
}

/** A context length as the harness page writes it (131072 is 128K). */
export const formatContext = (n) => (!n ? "n/a" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1024)}K` : String(n));
export const perMillion = (price) => {
  const v = price * 1e6;
  return v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toPrecision(2)}` : "$0";
};

// ---------------------------------------------------------------------------------------------------------------
// The answer

/** A receipt id is safe to put in a URL path only if it is a plain token. */
export const receiptIdOk = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);

/** Where a receipt can be checked and read. `apiBase` is empty when the site and the router share an origin (as on the onion address). */
export function receiptLinks(id, apiBase = "") {
  if (!receiptIdOk(id)) return null;
  const path = `/api/v1/receipts/${encodeURIComponent(id)}`;
  return { verify: "/verify/#v-receipt", receipt: apiBase + path, privacy: apiBase + path + "/privacy" };
}

const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The calls a response lists, each reduced to fields the page shows. Entries without a usable id keep their place and lose their links. */
export function readReceipts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const ua = r.upstream_attestation && typeof r.upstream_attestation === "object" ? r.upstream_attestation : null;
      return {
        step: r.step === "embeddings" || r.step === "chat" ? r.step : null,
        id: receiptIdOk(r.receipt_id) ? r.receipt_id : null,
        model: str(r.model),
        provider: str(r.provider),
        lane: str(r.lane, 40),
        disclosure: str(r.disclosure, 40),
        cost: num(r.cost),
        promptTokens: num(r.tokens?.prompt),
        completionTokens: num(r.tokens?.completion),
        inputs: num(r.inputs),
        withheld: r.withheld === true,
        developmentAttestation: r.attestation_simulated === true,
        attestation: ua ? { attested: ua.attested === true, gpu: ua.gpu_attested === true, verified: ua.receipt_verified === true, kind: str(ua.kind, 40), reason: str(ua.reason, 300) } : null,
      };
    });
}

/**
 * Splits an answer into text and citations. "[1]", "[2][3]" and "[1, 2]" become citation segments when every number is
 * one of the `count` sources; anything else in brackets stays text.
 */
export function splitCitations(answer, count) {
  const out = [];
  const re = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(answer))) {
    const refs = [...new Set([...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])))];
    if (!refs.length || refs.some((r) => r < 1 || r > count)) continue;
    if (m.index > last) out.push({ type: "text", text: answer.slice(last, m.index) });
    out.push({ type: "cite", refs, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < answer.length) out.push({ type: "text", text: answer.slice(last) });
  return out;
}

const CONTEXT = 200;
/** A slice that never begins or ends inside a surrogate pair. */
function safeSlice(text, from, to) {
  let a = Math.max(0, from);
  let b = Math.min(text.length, to);
  if (a > 0 && isLow(text.charCodeAt(a))) a++;
  if (b < text.length && b > a && isHigh(text.charCodeAt(b - 1))) b--;
  return text.slice(a, b);
}

/**
 * The sources of a response placed in the documents that were sent. `docs` are { name, text } in the order sent; a
 * source names its document as doc-N. The passage is cut from the text held here by the offsets the router returned.
 */
export function readSources(sources, docs) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s) => s && typeof s === "object" && Number.isInteger(s.ref) && s.ref >= 1)
    .map((s) => {
      const m = /^doc-(\d{1,4})$/.exec(String(s.document_id));
      const doc = m ? docs[Number(m[1]) - 1] : undefined;
      const ok = doc && Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.start < s.end && s.end <= doc.text.length;
      return {
        ref: s.ref,
        name: doc ? doc.name : str(s.document_id) ?? "unknown document",
        part: Number.isInteger(s.chunk_index) ? s.chunk_index + 1 : null,
        score: num(s.score),
        excerpt: ok
          ? {
              before: safeSlice(doc.text, s.start - CONTEXT, s.start),
              hit: doc.text.slice(s.start, s.end),
              after: safeSlice(doc.text, s.end, s.end + CONTEXT),
              moreBefore: s.start > CONTEXT,
              moreAfter: s.end + CONTEXT < doc.text.length,
            }
          : null,
      };
    });
}

/** Everything the page shows for a successful response. */
export function readAnswer(json, docs) {
  const sources = readSources(json?.sources, docs);
  const answer = typeof json?.answer === "string" ? json.answer : "";
  const segments = splitCitations(answer, sources.length ? Math.max(...sources.map((s) => s.ref)) : 0);
  const cited = new Set(segments.filter((s) => s.type === "cite").flatMap((s) => s.refs));
  const usage = json?.usage && typeof json.usage === "object" ? json.usage : {};
  return {
    answer,
    segments,
    cited,
    sources,
    receipts: readReceipts(json?.receipts),
    model: str(json?.model),
    embeddingModel: str(json?.embedding_model),
    lane: str(json?.lane, 40),
    laneSource: json?.lane_source === "request" || json?.lane_source === "default" ? json.lane_source : null,
    laneNote: str(json?.lane_note, 600),
    disclosure: str(json?.disclosure, 40),
    developmentAttestation: json?.attestation_simulated === true,
    finishReason: str(json?.finish_reason, 40),
    retrieval: json?.retrieval && typeof json.retrieval === "object" ? { documents: num(json.retrieval.documents), chunks: num(json.retrieval.chunks), topK: num(json.retrieval.top_k), embeddingCalls: num(json.retrieval.embedding_calls) } : null,
    usage: { embeddingTokens: num(usage.embedding_tokens), promptTokens: num(usage.prompt_tokens), completionTokens: num(usage.completion_tokens), costUsd: typeof usage.cost_usd === "string" && /^\d+(\.\d+)?$/.test(usage.cost_usd) ? usage.cost_usd : null },
  };
}

const HINTS = {
  no_attested_endpoint: "Nothing was sent to a provider on a weaker lane. Try again later, or choose the public lane.",
  upstream_not_attested: "The provider's answer was withheld because its attestation could not be confirmed. The call was billed, and its receipt is listed.",
  disclosure_unavailable: "No provider meets the lane you chose right now.",
  context_too_small: "Use fewer or smaller passages, or a model with a longer context.",
  payload_too_large: "Remove some files, or use larger passages so there are fewer chunks.",
};

/** A refusal or failure as the page shows it, with the receipts of any call already made (and billed). */
export function readError(err) {
  const md = err?.metadata && typeof err.metadata === "object" ? err.metadata : {};
  const type = typeof err?.type === "string" ? err.type : "error";
  return {
    status: Number.isInteger(err?.status) ? err.status : 0,
    type,
    message: typeof err?.message === "string" && err.message ? err.message : "The request failed.",
    step: md.step === "embeddings" || md.step === "chat" ? md.step : null,
    limit: Number.isInteger(md.limit) ? md.limit : null,
    receipts: readReceipts(md.receipts),
    hint: HINTS[type] ?? null,
    retryAfter: typeof err?.retryAfter === "string" ? err.retryAfter : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The privacy label of a receipt (GET /api/v1/receipts/{id}/privacy). A router may not have it, and its shape is
// read defensively: what is not a plain string is not shown.

const LABEL_ROWS = Object.freeze([
  ["prompt_readers", "Who can read the prompt"],
  ["network", "Network"],
  ["payment", "Payment"],
  ["stored", "Stored"],
  ["hardware", "Hardware"],
]);

const plain = (v, max) => {
  if (typeof v === "string") return v.trim().slice(0, max) || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") for (const k of ["summary", "text", "value", "label"]) if (typeof v[k] === "string" && v[k].trim()) return v[k].trim().slice(0, max);
  return null;
};

/** A link the router gave that stays on this site: a path, or an absolute URL of this very origin. Never another origin (over Tor that would leave the onion address). */
export function sameSiteLink(u, origin) {
  if (typeof u !== "string" || !u || u.length > 500 || /[\u0000-\u001f\\]/.test(u)) return null;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  if (!origin) return null;
  try {
    const url = new URL(u, origin);
    return url.origin === origin && (url.protocol === "https:" || url.protocol === "http:") ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}

/** The label as the page shows it, or null when the document is not one. */
export function readPrivacyLabel(json, origin = "") {
  const doc = json?.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
  if (!doc || typeof doc !== "object" || !doc.label || typeof doc.label !== "object") return null;
  const rows = LABEL_ROWS.map(([key, title]) => ({ key, title, value: plain(doc.label[key], 400) })).filter((r) => r.value);
  const summary = (Array.isArray(doc.summary) ? doc.summary : []).map((s) => plain(s, 400)).filter(Boolean).slice(0, 6);
  if (!rows.length && !summary.length) return null;
  return { lane: plain(doc.lane, 40), rows, summary, verifyUrl: sameSiteLink(doc.verify_url, origin) };
}
