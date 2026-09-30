// Small PDF files written by hand for the tests, so nothing binary is committed. Each page is a list of text lines set in
// Helvetica, which is not embedded (the reader must take the letter shapes and widths from its own tables). A page with
// no lines is blank, which is what a scanned page looks like to a text reader: it has no text to read.
//
// `password` writes the file with the standard security handler (RC4, 40-bit key, revision 2): the same construction
// real PDF writers use, done here in a few lines of node:crypto so the file is a real encrypted PDF and not a stand-in.
import { createHash } from "node:crypto";

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (b) => createHash("md5").update(b).digest();
const padded = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

function rc4(key, data) {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const esc = (line) => line.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * @param {string[][]} pages lines of text for each page (a line below the foot of the page is not read, so long texts take many pages)
 * @param {{ password?: string, size?: number, leading?: number }} opts type size and line spacing, in points
 */
export function buildPdf(pages, { password, size = 12, leading = 14 } = {}) {
  const id = md5(Buffer.from("fixture")); // the file identifier the key is derived from
  let key = null;
  let encrypt = "";
  if (password !== undefined) {
    const o = rc4(md5(padded("owner-fixture")).subarray(0, 5), padded(password));
    const p = Buffer.alloc(4);
    p.writeInt32LE(-4);
    key = md5(Buffer.concat([padded(password), o, p, id])).subarray(0, 5);
    const u = rc4(key, PAD);
    encrypt = `/Encrypt << /Filter /Standard /V 1 /R 2 /O <${o.toString("hex")}> /U <${u.toString("hex")}> /P -4 >>`;
  }
  const objects = []; // objects[n] is the body of object n + 1
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const tree = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const lines of pages) {
    const stream = lines.length ? `BT /F1 ${size} Tf ${leading} TL 72 720 Td ${lines.map((l) => `(${esc(l)}) '`).join(" ")} ET` : "";
    const content = objects.length + 2; // the page is added first, then its content
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
    add({ stream: Buffer.from(stream, "latin1") });
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    const num = i + 1;
    let bytes;
    if (typeof body === "string") bytes = Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, "latin1");
    else {
      const data = key ? rc4(md5(Buffer.concat([key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])])).subarray(0, 10), body.stream) : body.stream;
      bytes = Buffer.concat([Buffer.from(`${num} 0 obj\n<< /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n")]);
    }
    offsets.push(length);
    length += bytes.length;
    parts.push(bytes);
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  const idHex = id.toString("hex");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /ID [<${idHex}> <${idHex}>] ${encrypt} >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref + trailer, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}
