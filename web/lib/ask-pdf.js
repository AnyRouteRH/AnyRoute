// Reading a PDF for /ask/: text only. Nothing here imports the PDF reader (pdf.js); the caller passes the module in, so this file is
// small, runs under Node as well as in the browser, and the reader itself stays out of every bundle but the one import that names it
// (lib/ask-pdfjs.js, loaded only when a PDF is added on the Ask page).
//
// What is read is each page's text layer, in page order, as the reader reports it. Nothing is drawn: no canvas, no rendered page,
// no picture is decoded, no font is loaded, and the reader is given no address to fetch a font, a character map or a code module
// from. Scanned pages, whose text is a picture, have no text layer and are not read (there is no character recognition).

/** A file that cannot be read as a PDF, with a reason worth showing. `kind` says which of the reasons it is. */
export class PdfError extends Error {
  constructor(kind, message = "") {
    super(message);
    this.kind = kind;
  }
}

export const PDF_MESSAGES = Object.freeze({
  empty: "This file is empty.",
  notPdf: "This is not a PDF file: it does not start with %PDF-.",
  encrypted: "This PDF is password-protected, and this page does not take passwords. Save a copy without the password and add that.",
  corrupt: "This PDF is damaged, or not a valid PDF, so it could not be read.",
  noText: "This PDF has no text layer; scanned pages aren't read.",
  unavailable: "The PDF reader could not be loaded in this browser, so this file was not read.",
  unreadable: "This PDF could not be read.",
});

/** The line that opens a page's text, which is also what lets a passage be placed on its page. */
export const pageMarker = (n) => `[page ${n}]`;

/** True when the bytes begin like a PDF: the header may follow up to 1,024 bytes of anything, as the PDF reader also allows. */
export function looksLikePdf(bytes) {
  const end = Math.min(bytes.length, 1024) - 4;
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * What the reader is told when it opens a file. It is given the bytes and nothing to fetch: no font, character-map, colour-profile or
 * code-module address, no system fonts, no WebAssembly, no scripting, no range or stream loading. (Version 6 of the reader has no
 * eval-based path at all, so isEvalSupported is a no-op; it is set anyway so a reader that does have one never uses it.)
 */
export function documentParams(bytes) {
  return {
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    verbosity: 0, // errors only
  };
}

/** One page's text from the reader's text items: a line ends where the reader says one does. */
export function pageText(content) {
  let out = "";
  for (const item of content?.items ?? []) {
    if (typeof item?.str !== "string") continue; // a marked-content marker, not text
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out;
}

/** The pages that have text, each opened by its "[page N]" line, and a blank line between pages. */
export function joinPages(pages) {
  return pages.map((p) => `${pageMarker(p.number)}\n${p.text}`).join("\n\n");
}

/** The reader's failure as one of ours. */
function explain(e) {
  if (e instanceof PdfError) return e;
  switch (e?.name) {
    case "PasswordException":
      return new PdfError("encrypted", PDF_MESSAGES.encrypted);
    case "InvalidPDFException":
    case "FormatError":
    case "XRefParseException":
    case "MissingPDFException":
      return new PdfError("corrupt", PDF_MESSAGES.corrupt);
    default:
      return new PdfError("unreadable", PDF_MESSAGES.unreadable);
  }
}

const utf8 = new TextEncoder();

/**
 * The text of every page that has some.
 * @param pdfjs the PDF reader module (getDocument)
 * @param {Uint8Array} bytes the file
 * @param {{ maxTextBytes: number }} limits reading stops, with a "text-limit" error, once the text is past this many UTF-8 bytes
 * @returns {Promise<{ pages: {number: number, text: string}[], pageCount: number, blank: number, unreadable: number }>}
 * @throws {PdfError} kind: empty | notPdf | encrypted | corrupt | noText | unreadable | text-limit
 */
export async function readPdfPages(pdfjs, bytes, { maxTextBytes }) {
  if (!bytes.length) throw new PdfError("empty", PDF_MESSAGES.empty);
  if (!looksLikePdf(bytes)) throw new PdfError("notPdf", PDF_MESSAGES.notPdf);
  // The reader hands the buffer to its worker, which empties it here; a copy leaves the caller's bytes whole.
  const task = pdfjs.getDocument(documentParams(bytes.slice()));
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      throw explain(e);
    }
    const pages = [];
    let blank = 0;
    let unreadable = 0;
    let held = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      let text;
      try {
        const page = await doc.getPage(number);
        try {
          text = pageText(await page.getTextContent());
        } finally {
          page.cleanup();
        }
      } catch (e) {
        // One damaged page does not cost the rest of the file; a reader that has been shut down (or a password wall) does.
        if (e?.name === "PasswordException" || e?.name === "AbortException") throw explain(e);
        unreadable++;
        continue;
      }
      if (!/\S/.test(text)) {
        blank++;
        continue;
      }
      held += utf8.encode(text).length;
      if (held > maxTextBytes) throw new PdfError("text-limit");
      pages.push({ number, text });
    }
    if (!pages.length) {
      const damaged = unreadable === doc.numPages; // no page could be opened at all, which is a broken file, not a scan
      throw new PdfError(damaged ? "corrupt" : "noText", damaged ? PDF_MESSAGES.corrupt : PDF_MESSAGES.noText);
    }
    return { pages, pageCount: doc.numPages, blank, unreadable };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Placing a passage on its page

/**
 * The page a position in a PDF's text falls on: the last "[page N]" line at or before it, or null before the first.
 * The text is the one joinPages made (and the page tidied), so a marker is a line of its own after a blank line.
 */
export function pageAt(text, offset) {
  const re = /(^|\n)\[page (\d{1,6})\]\n/g;
  let page = null;
  let m;
  while ((m = re.exec(text))) {
    if (m.index + m[1].length > offset) break;
    page = Number(m[2]);
  }
  return page;
}

/** The pages a passage [start, end) spans, { first, last }, or null when the text has no page markers before it. */
export function pageSpan(text, start, end) {
  const first = pageAt(text, start);
  if (first === null) return null;
  return { first, last: Math.max(first, pageAt(text, Math.max(start, end - 1)) ?? first) };
}
