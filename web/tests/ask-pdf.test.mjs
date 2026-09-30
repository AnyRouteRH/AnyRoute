import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, READ_LIMIT_BYTES, parseFile, readSources } from "../lib/ask.js";
import { PDF_MESSAGES, PdfError, documentParams, joinPages, looksLikePdf, pageAt, pageSpan, pageText, readPdfPages } from "../lib/ask-pdf.js";
import { buildPdf } from "./pdf-fixtures.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(web, ...p), "utf8");

// The reader is loaded here exactly as the page loads it (the same "legacy" build, the minified file), so these tests run the code
// that ships. In Node it prints two lines about a canvas package it does not need (nothing is drawn); the import is quiet.
const READER = "pdfjs-dist/legacy/build/pdf.min.mjs";
let reader;
const loadReader = async () => {
  if (reader) return reader;
  const log = console.log;
  console.log = () => {};
  try {
    reader = await import(READER);
  } finally {
    console.log = log;
  }
  return reader;
};
const parse = async (name, bytes) => parseFile(name, bytes, { loadPdfjs: loadReader });

// ---- text ----------------------------------------------------------------------------------------------------------
test("the text of a real PDF is read page by page, each page opened by its marker, and a blank page is skipped but still counted", async () => {
  const pdf = buildPdf([["Refunds are issued within 14 days.", "Ask (politely) for a \\ slip."], [], ["Third page text."]]);
  assert.equal(looksLikePdf(pdf), true);
  const r = await parse("policy.pdf", pdf);
  assert.deepEqual(r, {
    ok: true,
    kind: "pdf",
    text: "[page 1]\nRefunds are issued within 14 days.\nAsk (politely) for a \\ slip.\n\n[page 3]\nThird page text.",
    bytes: 99,
    pages: 3,
    note: "1 of 3 pages have no text and were skipped; scanned pages aren't read.",
  });
  // A file where every page has text carries no note.
  const all = await parse("two.pdf", buildPdf([["One."], ["Two."]]));
  assert.equal(all.text, "[page 1]\nOne.\n\n[page 2]\nTwo.");
  assert.equal("note" in all, false);
  assert.equal(all.pages, 2);
});

test("the caller's bytes are left whole, and the reader is given a copy", async () => {
  const pdf = buildPdf([["Keep me."]]);
  const before = pdf.length;
  const r = await parse("keep.pdf", pdf);
  assert.equal(r.ok, true);
  assert.equal(pdf.length, before);
  assert.equal(pdf.buffer.detached ?? false, false);
  assert.equal((await parse("keep.pdf", pdf)).text, r.text); // and it can be read again
});

test("a passage is placed on its page by the markers, and a passage across a break names both pages", async () => {
  const text = joinPages([{ number: 1, text: "alpha beta" }, { number: 4, text: "gamma delta" }, { number: 5, text: "epsilon" }]);
  assert.equal(text, "[page 1]\nalpha beta\n\n[page 4]\ngamma delta\n\n[page 5]\nepsilon");
  const at = (needle) => text.indexOf(needle);
  assert.equal(pageAt(text, 0), 1);
  assert.equal(pageAt(text, at("beta")), 1);
  assert.equal(pageAt(text, at("[page 4]")), 4);
  assert.equal(pageAt(text, at("gamma")), 4);
  assert.equal(pageAt(text, at("epsilon")), 5);
  assert.equal(pageAt("no markers here", 5), null);
  assert.deepEqual(pageSpan(text, at("beta"), at("gamma") + 5), { first: 1, last: 4 });
  assert.deepEqual(pageSpan(text, at("gamma"), at("gamma") + 5), { first: 4, last: 4 });
  assert.equal(pageSpan("plain text", 0, 5), null);
  // In a response, only a PDF's sources get pages.
  const [s] = readSources([{ ref: 1, document_id: "doc-1", chunk_index: 0, start: at("gamma"), end: at("gamma") + 11 }], [{ name: "a.pdf", text, kind: "pdf" }]);
  assert.deepEqual(s.pages, { first: 4, last: 4 });
  const [t] = readSources([{ ref: 1, document_id: "doc-1", chunk_index: 0, start: at("gamma"), end: at("gamma") + 11 }], [{ name: "a.txt", text, kind: "text" }]);
  assert.equal(t.pages, null);
});

test("line ends follow the reader's, and anything that is not text is left out", () => {
  assert.equal(pageText({ items: [{ str: "one", hasEOL: true }, { type: "beginMarkedContent" }, { str: "two", hasEOL: false }, { str: " three", hasEOL: true }] }), "one\ntwo three\n");
  assert.equal(pageText(null), "");
});

// ---- refusals ------------------------------------------------------------------------------------------------------
test("a PDF that is only pictures says it has no text layer", async () => {
  const scan = buildPdf([[], [], []]);
  const r = await parse("scan.pdf", scan);
  assert.deepEqual(r, { ok: false, error: "This PDF has no text layer; scanned pages aren't read." });
  assert.equal(PDF_MESSAGES.noText, r.error);
  // Spaces alone are not text.
  assert.equal((await parse("spaces.pdf", buildPdf([["   "], [" "]]))).error, PDF_MESSAGES.noText);
});

test("an encrypted PDF says it is password-protected, and this page takes no password", async () => {
  const locked = buildPdf([["Secret text."]], { password: "fixture-pw" });
  const r = await parse("locked.pdf", locked);
  assert.equal(r.ok, false);
  assert.match(r.error, /password-protected/);
  assert.match(r.error, /does not take passwords/);
  // The fixture is a real encrypted file: the reader opens it with the password, and only then.
  const pdfjs = await loadReader();
  const opened = pdfjs.getDocument({ ...documentParams(locked.slice()), password: "fixture-pw" });
  const doc = await opened.promise;
  const text = pageText(await (await doc.getPage(1)).getTextContent());
  await opened.destroy();
  assert.equal(text, "Secret text.");
  const wrong = pdfjs.getDocument({ ...documentParams(locked.slice()), password: "not-it" });
  await assert.rejects(wrong.promise, (e) => e.name === "PasswordException" && e.code === 2);
  await wrong.destroy();
});

test("files that are not a PDF, or are a damaged one, get a clear message and never a crash", async () => {
  assert.equal((await parse("empty.pdf", new Uint8Array(0))).error, PDF_MESSAGES.empty);
  assert.equal((await parse("notes.pdf", new TextEncoder().encode("just some text, renamed"))).error, PDF_MESSAGES.notPdf);
  assert.equal((await parse("pic.pdf", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))).error, PDF_MESSAGES.notPdf);
  const good = buildPdf([["A whole file."], ["Two pages."]]);
  // A header and then rubbish.
  assert.equal((await parse("junk.pdf", new TextEncoder().encode("%PDF-1.4\n" + "rubbish ".repeat(100)))).error, PDF_MESSAGES.corrupt);
  // A file cut off in the middle of its objects, so the end (cross-reference table and trailer) is gone too.
  assert.deepEqual(await parse("cut.pdf", good.subarray(0, Math.floor(good.length * 0.45))), { ok: false, error: PDF_MESSAGES.corrupt });
  // One cut only in the trailer is rebuilt by the reader from the objects, and read whole.
  assert.equal((await parse("trailer-cut.pdf", good.subarray(0, Math.floor(good.length * 0.95)))).text, "[page 1]\nA whole file.\n\n[page 2]\nTwo pages.");
  // The reader repairs a file whose cross-reference table is wrong, which is how real, slightly broken files still open.
  const text = new TextDecoder("latin1").decode(good);
  const broken = new TextEncoder().encode(text.replace(/startxref\n\d+/, "startxref\n7"));
  const fixed = await parse("fixed.pdf", broken);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.text, "[page 1]\nA whole file.\n\n[page 2]\nTwo pages.");
});

test("a reader that cannot be loaded says so, and the file is not parsed", async () => {
  const pdf = buildPdf([["x"]]);
  for (const options of [{}, { loadPdfjs: async () => { throw new Error("chunk failed to load"); } }, { loadPdfjs: 42 }]) {
    assert.deepEqual(await parseFile("a.pdf", pdf, options), { ok: false, error: PDF_MESSAGES.unavailable });
  }
});

test("the size is checked before the reader is even loaded, and text past the request limit stops the reading", async () => {
  let loaded = 0;
  const loadPdfjs = async () => {
    loaded++;
    return loadReader();
  };
  const huge = new Uint8Array(READ_LIMIT_BYTES + 1);
  huge.set(new TextEncoder().encode("%PDF-1.7\n"));
  const r = await parseFile("huge.pdf", huge, { loadPdfjs });
  assert.equal(r.ok, false);
  assert.match(r.error, /^This file is 20\.0 MiB\. A request can carry at most 2\.00 MiB of text in all\.$/);
  assert.equal(loaded, 0);
  // The limit on text is the router's own; the reader stops as soon as it is passed rather than reading the rest.
  const pdfjs = await loadReader();
  await assert.rejects(readPdfPages(pdfjs, buildPdf([["a line of text that is fairly long"], ["more"]]), { maxTextBytes: 20 }), (e) => e instanceof PdfError && e.kind === "text-limit");
  const line = "x".repeat(160);
  const lines = Math.ceil(LIMITS.bytes / 161) + 10;
  const big = buildPdf(Array.from({ length: Math.ceil(lines / 200) }, () => Array.from({ length: 200 }, () => line)), { size: 2, leading: 3 });
  const over = await parseFile("big.pdf", big, { loadPdfjs });
  assert.equal(over.ok, false);
  assert.match(over.error, /^This file has more than 2\.00 MiB of text, and one request may carry at most 2\.00 MiB in all\.$/);
});

// ---- what the reader is allowed to do -------------------------------------------------------------------------------
test("the reader is told to fetch nothing, draw nothing and run nothing, and a document that needs a font it does not have fetches nothing", async () => {
  const p = documentParams(new Uint8Array(1));
  assert.equal(p.isEvalSupported, false);
  assert.equal(p.disableFontFace, true);
  assert.equal(p.useSystemFonts, false);
  assert.equal(p.useWasm, false);
  assert.equal(p.useWorkerFetch, false);
  assert.equal(p.enableXfa, false);
  for (const key of ["standardFontDataUrl", "cMapUrl", "wasmUrl", "iccUrl", "url", "httpHeaders", "range", "worker", "CanvasFactory", "ownerDocument"]) assert.equal(key in p, false, key);
  // The fixture sets its text in a standard font that it does not embed, the case that makes a reader look for font data.
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetched.push(String(args[0]));
    throw new Error("the reader tried to fetch");
  };
  try {
    const r = await parse("fonts.pdf", buildPdf([["Set in Helvetica, which is not in the file."]]));
    assert.equal(r.ok, true);
    assert.match(r.text, /Set in Helvetica/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(fetched, []);
});

test("the shipped reader has no way to evaluate a string as code", () => {
  for (const file of ["legacy/build/pdf.min.mjs", "legacy/build/pdf.worker.min.mjs"]) {
    const code = fs.readFileSync(path.join(web, "node_modules", "pdfjs-dist", file), "utf8");
    assert.equal(/\bnew\s+Function\s*\(/.test(code), false, `${file}: new Function(`);
    assert.equal(/(?<![\w$.])eval\s*\(/.test(code), false, `${file}: eval(`);
  }
});

// ---- where the reader lives ----------------------------------------------------------------------------------------
function sources(dir) {
  return fs.readdirSync(path.join(web, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return sources(rel);
    return /\.(jsx?|mjs|css)$/.test(e.name) && !/\.generated\./.test(e.name) ? [rel] : [];
  });
}

test("the PDF reader is named in one file, by a dynamic import, and only the Ask page loads that file", () => {
  const files = [...sources("app"), ...sources("components"), ...sources("lib")];
  const naming = files.filter((f) => read(f).includes("pdfjs-dist"));
  assert.deepEqual(naming, [path.join("lib", "ask-pdfjs.js")]);
  const loader = read("lib", "ask-pdfjs.js");
  assert.equal(/^\s*import\b[^(]*from\s*["']pdfjs-dist/m.test(loader), false, "no static import of the reader");
  assert.equal(/^\s*export\b[^;]*from\s*["']pdfjs-dist/m.test(loader), false, "no re-export of the reader");
  assert.match(loader, /await import\("pdfjs-dist\/legacy\/build\/pdf\.min\.mjs"\)/);
  assert.equal(loader.includes(READER), true, "the tests read with the build the page loads");
  // The worker is this site's own file, never an address on another origin.
  assert.match(loader, /new URL\("pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs", import\.meta\.url\)/);
  assert.equal(/https?:\/\//.test(loader.replace(/\/\/.*$/gm, "")), false);
  const importers = files.filter((f) => /from\s+["'][^"']*ask-pdfjs(\.js)?["']/.test(read(f)));
  assert.deepEqual(importers, [path.join("components", "Ask.jsx")]);
  // The pure modules take the reader as an argument.
  for (const f of ["lib/ask.js", "lib/ask-pdf.js"]) assert.equal(/\bimport\s*\(|pdfjs-dist/.test(read(f)), false, f);
});

test("the dependency is one exact version, and the optional canvas package is neither wanted nor locked", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies["pdfjs-dist"], "6.3.289");
  assert.equal(pkg.optionalDependencies, undefined);
  assert.match(read("pnpm-workspace.yaml"), /ignoredOptionalDependencies:\s*\n\s*-\s*"?@napi-rs\/canvas"?/);
  const lock = read("pnpm-lock.yaml");
  assert.match(lock, /\n {2}pdfjs-dist@6\.3\.289:\n {4}resolution: \{integrity: sha512-/);
  assert.equal(lock.includes("@napi-rs/canvas@"), false);
  assert.equal(JSON.parse(read("node_modules", "pdfjs-dist", "package.json")).version, "6.3.289");
});
