// The one place the PDF reader (pdf.js) is named. It is imported here, dynamically, and this file is called only when a PDF is
// added on the Ask page, so the reader is a chunk that no other page (and not the Ask page itself, until then) ever loads.
//
// The reader's background worker is a file of this site: the bundler copies it into the export next to the other scripts
// (under /_next/static/media/, its name carrying a hash of its contents) and the address below points at that copy. The page's
// content security policy allows scripts and workers from this origin only, and nothing here names another one.
//
// The "legacy" build is used because it runs on browsers a few years old as well as current ones; a PDF reader that needed the
// newest browser would fail exactly for the people who use a hardened or older one.
export async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href;
  return pdfjs;
}
