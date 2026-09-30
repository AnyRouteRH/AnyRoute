import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  ACCEPT, CHUNK_SIZE, LIMITS, LANES, ParseError, QUESTION_MAX, SUPPORTED, TOP_K,
  buildRagRequest, chunkText, csvToText, decodeEntities, decodeText, docxXmlToText, estimatePromptTokens, extOf, formatBytes, htmlToText, jsonToText, kindOf, laneAdvice,
  modelsFor, overlapFor, parseCsv, parseFile, pickModel, planRequest, problems, readAnswer, readCatalog, readError, readPrivacyLabel, readReceipts, readSources, readZipEntry,
  receiptIdOk, receiptLinks, sameSiteLink, splitCitations, utf8Bytes,
} from "../lib/ask.js";

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

// ---- a small zip writer, so a Word file can be built without a library ---------------------------------------------
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files, { flags = 0, dataDescriptor = false } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
  const u32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
  for (const [name, content, method = 8] of files) {
    const raw = Buffer.from(typeof content === "string" ? content : content);
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const crc = crc32(raw);
    // With a data descriptor the local header carries zeros and the sizes follow the data; the central directory has the truth.
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(flags | (dataDescriptor ? 8 : 0)), u16(method), u16(0), u16(0), u32(dataDescriptor ? 0 : crc), u32(dataDescriptor ? 0 : packed.length), u32(dataDescriptor ? 0 : raw.length), u16(nameBuf.length), u16(0), nameBuf]);
    const tail = dataDescriptor ? Buffer.concat([u32(0x08074b50), u32(crc), u32(packed.length), u32(raw.length)]) : Buffer.alloc(0);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(flags | (dataDescriptor ? 8 : 0)), u16(method), u16(0), u16(0), u32(crc), u32(packed.length), u32(raw.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    chunks.push(local, packed, tail);
    offset += local.length + packed.length + tail.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...chunks, dir, end]));
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const body = (inner) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${inner}</w:body></w:document>`;
const docx = (inner, opts) => zip([["[Content_Types].xml", "<Types/>"], ["word/document.xml", body(inner)]], opts);

// ---- formats -----------------------------------------------------------------------------------------------------
test("the format is read from the extension, whatever its case, and a PDF needs the PDF reader to be given", async () => {
  assert.equal(extOf("Report.FINAL.Md"), "md");
  assert.equal(kindOf("a.txt"), "text");
  assert.equal(kindOf("a.MD"), "markdown");
  assert.equal(kindOf("a.csv"), "csv");
  assert.equal(kindOf("a.json"), "json");
  assert.equal(kindOf("a.html"), "html");
  assert.equal(kindOf("a.htm"), "html");
  assert.equal(kindOf("a.docx"), "docx");
  assert.equal(kindOf("a.pdf"), "pdf");
  assert.equal(kindOf("a.exe"), null);
  assert.equal(kindOf("README"), null);
  assert.deepEqual([...SUPPORTED], [".txt", ".md", ".csv", ".json", ".html", ".docx", ".pdf"]);
  assert.ok(ACCEPT.includes(".pdf") && ACCEPT.includes(".docx"));
  // Without a reader (this file never loads one itself) a PDF is refused, and says why; ask-pdf.test.mjs reads real ones.
  const pdf = await parseFile("scan.pdf", bytes("%PDF-1.7"));
  assert.deepEqual(pdf, { ok: false, error: "The PDF reader could not be loaded in this browser, so this file was not read." });
  assert.equal((await parseFile("scan.pdf", bytes("%PDF-1.7"), { loadPdfjs: async () => { throw new Error("offline"); } })).ok, false);
  const other = await parseFile("sheet.xlsx", bytes("x"));
  assert.equal(other.ok, false);
  assert.match(other.error, /\.xlsx is not a supported format\. Supported: \.txt, \.md, \.csv, \.json, \.html, \.docx, \.pdf\./);
  assert.match((await parseFile("old.doc", bytes("x"))).error, /\.docx/);
});

// ---- text --------------------------------------------------------------------------------------------------------
test("plain text and markdown: a byte order mark and Windows line ends are gone, UTF-16 is read, binary is refused", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("one\r\ntwo\r\n\r\n\r\n\r\nthree  \n")]);
  const a = await parseFile("a.txt", bom);
  assert.deepEqual(a, { ok: true, kind: "text", text: "one\ntwo\n\nthree", bytes: 14 });
  assert.equal((await parseFile("a.md", bytes("# Title\n\n- item"))).text, "# Title\n\n- item");
  const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from("héllo ✓", "utf16le")]);
  assert.equal((await parseFile("w.txt", utf16)).text, "héllo ✓");
  const bad = await parseFile("b.txt", new Uint8Array([0x66, 0xff, 0xfe, 0x00]));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not UTF-8 text/);
  assert.match((await parseFile("nul.txt", bytes("a\u0000b"))).error, /binary/);
  assert.match((await parseFile("empty.txt", bytes("  \n \n"))).error, /No text/);
  assert.throws(() => decodeText(new Uint8Array([0xc3, 0x28])), ParseError);
});

test("a file with more text than one request can carry is refused with the limit", async () => {
  const r = await parseFile("big.txt", bytes("x".repeat(LIMITS.bytes + 1)));
  assert.equal(r.ok, false);
  assert.match(r.error, /2\.00 MiB of text/);
  assert.equal((await parseFile("edge.txt", bytes("x".repeat(LIMITS.bytes)))).ok, true);
});

// ---- csv ---------------------------------------------------------------------------------------------------------
test("csv: quoted fields, commas and line breaks inside them, doubled quotes and blank rows", () => {
  const rows = parseCsv('name,note\n"Smith, Jo","said ""hi""\nand left"\n\n,\nLee,ok', ",");
  assert.deepEqual(rows, [["name", "note"], ["Smith, Jo", 'said "hi"\nand left'], ["Lee", "ok"]]);
  assert.deepEqual(parseCsv('a"b,c', ","), [['a"b', "c"]]); // a quote inside an unquoted field is just a character
  assert.deepEqual(parseCsv('"open,unterminated', ","), [["open,unterminated"]]);
});

test("csv becomes one line per row, named by the header, with empty cells left out", () => {
  const text = csvToText("Name,Team,Notes\nAda,Core,\"first\nline\"\nGrace,,\n,,\n");
  assert.equal(text, "Name: Ada; Team: Core; Notes: first / line\nName: Grace");
  assert.equal(csvToText("a;b\n1;2"), "a: 1; b: 2");
  assert.equal(csvToText("a\tb\n1\t2"), "a: 1; b: 2");
  assert.equal(csvToText("x,x,\n1,2,3"), "x: 1; column 2: 2; column 3: 3");
  assert.equal(csvToText("only,one,row"), "only, one, row");
  assert.equal(csvToText(""), "");
});

test("a .csv file is read end to end, with Windows line ends", async () => {
  const r = await parseFile("t.csv", bytes("item,price\r\ntea,3\r\ncoffee,4\r\n"));
  assert.equal(r.text, "item: tea; price: 3\nitem: coffee; price: 4");
});

// ---- json --------------------------------------------------------------------------------------------------------
test("json is written one value to a line, and text that is not json is refused", async () => {
  assert.equal(jsonToText('{"a":[1,2],"b":{"c":"d"}}'), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": "d"\n  }\n}');
  const bad = await parseFile("x.json", bytes("{nope"));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not valid JSON/);
  assert.equal((await parseFile("s.json", bytes('"just a string"'))).text, '"just a string"');
});

// ---- html --------------------------------------------------------------------------------------------------------
test("html: scripts, styles, comments and the head are dropped, the title is kept, blocks become breaks", () => {
  const html = `<!doctype html><html><head><title>Refund &amp; returns</title><style>p{color:red}</style><script>var secret = "leak";</script></head>
<body><!-- hidden note --><h1>Policy</h1><p>Refunds take <b>14</b> days.<br>Contact us.</p><script type="text/javascript">alert("x")</script>
<ul><li>First</li><li>Second</li></ul><noscript>enable js</noscript><table><tr><th>Item</th><th>Days</th></tr><tr><td>Shoes</td><td>14</td></tr></table></body></html>`;
  assert.equal(htmlToText(html), "Refund & returns\n\nPolicy\n\nRefunds take 14 days.\nContact us.\n\nFirst\nSecond\n\nItem | Days\nShoes | 14");
  assert.ok(!/secret|alert|hidden note|enable js|color/.test(htmlToText(html)));
});

test("html: escaped markup stays text, entities are decoded once, an unterminated script is dropped", () => {
  assert.equal(htmlToText("<p>Use &lt;script&gt; carefully &amp;lt; &#65;&#x42; &euro;5 &unknown;</p>"), "Use <script> carefully &lt; AB €5 &unknown;");
  assert.equal(htmlToText("<p>before</p><script>while(1){}"), "before");
  assert.equal(htmlToText('<a href="x>y" title=\'a>b\'>link</a> text'), "link text");
  assert.equal(decodeEntities("&#0; &#xD800; &#1114112;"), "� � �");
  assert.equal(htmlToText("1 < 2 and 3 > 2"), "1 < 2 and 3 > 2");
  assert.equal(htmlToText("<header>Site</header><main>Body</main>"), "Site\n\nBody");
  // Line breaks in the source are spaces, as in a browser, except inside <pre>.
  assert.equal(htmlToText("<p>one\ntwo\n   three</p><pre>a\n  b</pre>"), "one two three\n\na\nb");
});

// ---- docx --------------------------------------------------------------------------------------------------------
test("a Word file: paragraphs, runs, tabs and breaks, tables, entities; deleted text and fallback copies are left out", async () => {
  const inner = [
    "<w:p><w:r><w:t>Refund policy</w:t></w:r></w:p>",
    '<w:p><w:r><w:t xml:space="preserve">Refunds take </w:t></w:r><w:r><w:t>14 days &amp; more.</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r><w:r><w:br/><w:t>next line</w:t></w:r></w:p>',
    '<w:p><w:del><w:r><w:delText>removed words</w:delText></w:r></w:del><w:ins><w:r><w:t>Added.</w:t></w:r></w:ins><w:r><w:instrText> PAGE </w:instrText></w:r></w:p>',
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Days</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Shoes</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>14</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    "<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>Box text</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Box text</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>",
    "<w:p/>",
    "<w:p><w:r><w:t>End</w:t></w:r></w:p>",
  ].join("");
  const r = await parseFile("policy.docx", docx(inner));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "Refund policy\nRefunds take 14 days & more. tabbed\nnext line\nAdded.\nItem | Days\nShoes | 14\n\nBox text\nEnd");
});

test("a Word file with stored parts, and one written with data descriptors, reads the same", async () => {
  const inner = "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>";
  const stored = zip([["word/document.xml", body(inner), 0]]);
  assert.equal((await parseFile("a.docx", stored)).text, "Hello");
  assert.equal((await parseFile("b.docx", docx(inner, { dataDescriptor: true }))).text, "Hello");
});

test("a Word file that is damaged, protected, empty or not a zip is refused with a reason, and nothing is guessed", async () => {
  const good = docx("<w:p><w:r><w:t>Hello</w:t></w:r></w:p>");
  assert.match((await parseFile("a.docx", bytes("not a zip at all"))).error, /not a zip/);
  assert.match((await parseFile("a.docx", good.subarray(0, 40))).error, /not a zip/);
  const cut = good.slice();
  cut.fill(0x55, 40, 90); // the packed bytes of the first part
  assert.equal((await parseFile("a.docx", cut)).ok, false);
  assert.match((await parseFile("a.docx", docx("<w:p/>", { flags: 1 }))).error, /password-protected/);
  assert.match((await parseFile("a.docx", docx("<w:p/>"))).error, /No text/);
  assert.match((await parseFile("a.docx", zip([["x.txt", "hi"]]))).error, /no body text part/);
  assert.equal(await readZipEntry(zip([["x.txt", "hi"]]), "y.txt"), null);
});

test("a Word file cannot unpack to more than the limit, whatever its header says", async () => {
  const big = "<w:p><w:r><w:t>" + "a".repeat(200_000) + "</w:t></w:r></w:p>";
  const file = zip([["word/document.xml", big]]);
  await assert.rejects(readZipEntry(file, "word/document.xml", 100_000), /far more text/);
  // A header that claims a small size for a large stream: the real size is caught while unpacking.
  const lying = file.slice();
  const v = new DataView(lying.buffer);
  for (let i = lying.length - 22 - 200; i < lying.length - 22; i++) if (v.getUint32(i, true) === 0x02014b50) v.setUint32(i + 24, 1000, true);
  await assert.rejects(readZipEntry(lying, "word/document.xml", 100_000), /far more text|damaged/);
});

test("docxXmlToText copes with attributes that contain angle brackets and with comments", () => {
  assert.equal(docxXmlToText('<w:p><w:r w:rsidR="a>b"><w:t>One</w:t></w:r><!-- <w:t>no</w:t> --></w:p>').trim(), "One");
});

// ---- chunking ----------------------------------------------------------------------------------------------------
test("the chunker cuts the way the router does: sizes, offsets, overlap and the default overlap", () => {
  assert.equal(overlapFor(1000), 150);
  assert.equal(overlapFor(333), 50);
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const pieces = chunkText(text, 200, overlapFor(200));
  assert.ok(pieces.length > 5);
  for (const p of pieces) {
    assert.ok(p.text.length <= 200 && p.text.length > 0);
    assert.equal(text.slice(p.start, p.end), p.text);
  }
  for (let i = 1; i < pieces.length; i++) assert.ok(pieces[i].start < pieces[i - 1].end, "windows overlap");
  assert.deepEqual(chunkText("   ", 100, 10), []);
  assert.throws(() => chunkText("abc", 10, 10), RangeError);
});

// ---- the caps ----------------------------------------------------------------------------------------------------
test("the caps shown before sending: documents, text, chunks and embeddings calls, at and over each limit", () => {
  const doc = (n) => ({ text: "x".repeat(n) });
  const ok = planRequest([doc(500), doc(500)]);
  assert.deepEqual(ok.rows.map((r) => [r.key, r.used, r.limit, r.over]), [["documents", 2, 200, false], ["bytes", 1000, LIMITS.bytes, false], ["chunks", 2, 2000, false], ["embeddingCalls", 1, 64, false]]);
  assert.equal(ok.blocked, false);
  // Exactly at the limits is allowed; one more is not.
  assert.equal(planRequest(Array.from({ length: 200 }, () => doc(5))).blocked, false);
  assert.deepEqual(planRequest(Array.from({ length: 201 }, () => doc(5))).over, ["documents"]);
  assert.equal(planRequest([doc(LIMITS.bytes)], { chunkSize: 8000 }).over.includes("bytes"), false);
  assert.deepEqual(planRequest([doc(LIMITS.bytes + 1)], { chunkSize: 8000 }).over, ["bytes"]);
  // Bytes are UTF-8 bytes, as the router counts them.
  assert.equal(planRequest([{ text: "é✓😀" }]).bytes, 2 + 3 + 4);
  assert.equal(utf8Bytes("é✓😀"), 9);
  // Chunks: 2,001 one-chunk documents are over the chunk cap (and the document cap).
  const many = planRequest(Array.from({ length: 2001 }, () => doc(5)));
  assert.deepEqual(many.over, ["documents", "chunks"]);
  // Embeddings calls: the question rides in the first call, 64 texts to a call.
  assert.equal(planRequest(Array.from({ length: 63 }, () => doc(5))).embeddingCalls, 1);
  assert.equal(planRequest(Array.from({ length: 64 }, () => doc(5))).embeddingCalls, 2);
  assert.equal(planRequest([]).embeddingCalls, 0);
  assert.deepEqual(planRequest(Array.from({ length: 64 }, () => doc(5)), { limits: { ...LIMITS, embeddingCalls: 1 } }).over, ["embeddingCalls"]); // a router set to fewer calls
  // A larger chunk size gives fewer chunks for the same text.
  const long = [{ text: ("word ".repeat(400)).trim() }];
  assert.ok(planRequest(long, { chunkSize: 100 }).chunks > planRequest(long, { chunkSize: 1000 }).chunks);
  // A router that has changed a limit is not the default: the limits can be passed in.
  assert.equal(planRequest([doc(5), doc(5)], { limits: { ...LIMITS, documents: 1 } }).blocked, true);
});

test("what stops a request from being sent, in the order it would be fixed", () => {
  const plan = planRequest([{ text: "hello world" }]);
  const base = { key: "sk", docs: [{}], plan, question: "why?", model: "m/x", topK: 4, chunkSize: 1000, contextLength: 32000 };
  assert.deepEqual(problems(base), []);
  assert.deepEqual(problems({ ...base, key: "", docs: [], question: " ", model: "" }), ["Connect your API key.", "Add at least one file.", "Write a question.", "Choose a model."]);
  assert.match(problems({ ...base, plan: planRequest([{ text: "x" }], { limits: { ...LIMITS, chunks: 0 } }) })[0], /over a limit/);
  assert.match(problems({ ...base, question: "q".repeat(QUESTION_MAX + 1) })[0], /longer than 8000/);
  assert.match(problems({ ...base, topK: 21 })[0], /1 to 20/);
  assert.match(problems({ ...base, chunkSize: 99 })[0], /100 to 8000/);
  const wide = planRequest([{ text: "word ".repeat(2000) }], { chunkSize: 8000 });
  assert.match(problems({ ...base, plan: wide, topK: 20, chunkSize: 8000, contextLength: 4096 })[0], /longer than this model's context/);
  assert.deepEqual(problems({ ...base, plan: wide, topK: 1, chunkSize: 8000, contextLength: 32000 }), []);
  // The estimate is the router's: chars / 3 over the longest chunks, the question, 1200 of instructions and 120 a source.
  assert.equal(estimatePromptTokens([300, 900, 600], "abcdef", 2), Math.ceil((900 + 600 + 6 + 1200 + 240) / 3) + 8);
});

// ---- the request -------------------------------------------------------------------------------------------------
const ROUTER_KEYS = new Set(["documents", "question", "model", "embedding_model", "top_k", "chunk", "max_tokens", "temperature", "stream", "include_excerpts", "provider"]);
test("the request has only fields the router accepts, sends documents as doc-N, and never a file name", () => {
  const docs = [{ name: "payroll-2026.csv", text: "a" }, { name: "notes.md", text: "b" }];
  const body = buildRagRequest({ docs, question: "  What is due?  ", model: "acme/chat", lane: "attested", topK: 3, chunkSize: 400 });
  assert.deepEqual(body, {
    documents: [{ id: "doc-1", text: "a" }, { id: "doc-2", text: "b" }],
    question: "What is due?",
    model: "acme/chat",
    top_k: 3,
    chunk: { size: 400, overlap: 60 },
    provider: { lane: "attested" },
  });
  for (const k of Object.keys(body)) assert.ok(ROUTER_KEYS.has(k), k);
  assert.ok(!JSON.stringify(body).includes("payroll") && !JSON.stringify(body).includes("notes.md"));
  assert.ok(!("include_excerpts" in body) && !("stream" in body) && !("embedding_model" in body));
  assert.deepEqual(Object.keys(body.documents[0]).sort(), ["id", "text"]);
});

test("the lane is stated on every request except when the router is left to choose", () => {
  const args = { docs: [{ text: "a" }], question: "q", model: "m/x" };
  assert.deepEqual(buildRagRequest(args).provider, { lane: "attested" }); // the default
  assert.deepEqual(buildRagRequest({ ...args, lane: "public" }).provider, { lane: "public" });
  assert.equal("provider" in buildRagRequest({ ...args, lane: "auto" }), false);
  assert.deepEqual([...LANES], ["attested", "public", "auto"]);
  assert.throws(() => buildRagRequest({ ...args, lane: "unlinkable" }), /Unknown lane/);
  assert.equal(buildRagRequest(args).top_k, TOP_K.default);
  assert.deepEqual(buildRagRequest(args).chunk, { size: CHUNK_SIZE.default, overlap: 150 });
});

test("a request that would be refused is not built", () => {
  const ok = { docs: [{ text: "a" }], question: "q", model: "m/x" };
  assert.throws(() => buildRagRequest({ ...ok, docs: [] }), /at least one document/);
  assert.throws(() => buildRagRequest({ ...ok, model: "" }), /Choose a model/);
  assert.throws(() => buildRagRequest({ ...ok, question: "   " }), /question/);
  assert.throws(() => buildRagRequest({ ...ok, question: "q".repeat(QUESTION_MAX + 1) }), /question/);
  assert.throws(() => buildRagRequest({ ...ok, topK: 0 }), /top_k/);
  assert.throws(() => buildRagRequest({ ...ok, topK: 2.5 }), /top_k/);
  assert.throws(() => buildRagRequest({ ...ok, chunkSize: 8001 }), /chunk size/);
});

// ---- the catalog and the model choice ----------------------------------------------------------------------------
const raw = (id, o = {}) => ({ id, name: o.name ?? id, context_length: o.ctx ?? 8000, top_provider: o.top ? { context_length: o.top } : undefined, architecture: { output_modalities: o.out ?? ["text"] }, pricing: { prompt: o.p ?? "0.000001", completion: o.c ?? "0.000002" }, disclosure: { endpoints: { attested: o.att ?? 0, policy: 0, "vendor-forwarded": 1 } }, lanes: o.lanes });
const catalog = readCatalog([
  raw("a/small", { ctx: 4096, att: 1, p: "0.00000002", c: "0.00000004" }),
  raw("b/roomy", { ctx: 128000, att: 2, p: "0.000003", c: "0.000015" }),
  raw("c/cheap", { ctx: 64000, att: 1, p: "0.0000005", c: "0.000001" }),
  raw("d/public", { ctx: 200000, att: 0, p: "0.0000001", c: "0.0000001" }),
  raw("e/embed", { out: ["embeddings"], att: 1 }),
  raw("f/image", { out: ["image"] }),
  { id: "", architecture: {} },
  null,
]);
test("the catalog is split into chat and embedding models, with attested endpoints and context read from it", () => {
  assert.deepEqual(catalog.chat.map((m) => m.id), ["a/small", "b/roomy", "c/cheap", "d/public"]);
  assert.deepEqual(catalog.embedding.map((m) => [m.id, m.attested]), [["e/embed", true]]);
  assert.deepEqual(catalog.chat.map((m) => m.attested), [true, true, true, false]);
  assert.equal(readCatalog([raw("x/y", { ctx: 1000, top: 9000 })]).chat[0].context, 9000); // the largest endpoint's context, as the router checks
  assert.equal(readCatalog([{ id: "x/y", lanes: ["public", "attested"], architecture: {} }]).chat[0].attested, true);
  assert.deepEqual(readCatalog(undefined), { chat: [], embedding: [] });
});

test("the attested lane offers only attested models; the default is the cheapest roomy one, and a choice is kept while allowed", () => {
  assert.deepEqual(modelsFor(catalog, "attested").map((m) => m.id), ["a/small", "b/roomy", "c/cheap"]);
  assert.equal(modelsFor(catalog, "public").length, 4);
  assert.equal(pickModel(catalog, "attested", ""), "c/cheap");
  assert.equal(pickModel(catalog, "public", ""), "d/public");
  assert.equal(pickModel(catalog, "attested", "b/roomy"), "b/roomy");
  assert.equal(pickModel(catalog, "attested", "d/public"), "c/cheap"); // not allowed on this lane
  assert.equal(pickModel({ chat: [], embedding: [] }, "attested", ""), "");
  assert.equal(pickModel(readCatalog([raw("t/tiny", { ctx: 2000, att: 1 }), raw("u/tiny2", { ctx: 3000, att: 1 })]), "attested", ""), "u/tiny2");
});

test("a lane that cannot be served right now is said before anything is sent", () => {
  assert.equal(laneAdvice(catalog, "attested", "c/cheap"), null);
  assert.match(laneAdvice({ ...catalog, embedding: [] }, "attested", "c/cheap"), /No embedding model has an attested endpoint/);
  assert.match(laneAdvice({ chat: catalog.chat.filter((m) => !m.attested), embedding: catalog.embedding }, "attested", "d/public"), /No chat model has an attested endpoint/);
  assert.match(laneAdvice(catalog, "auto", "d/public"), /public lane/);
  assert.equal(laneAdvice(catalog, "auto", "c/cheap"), null);
  assert.equal(laneAdvice(catalog, "public", "d/public"), null);
});

// ---- the answer --------------------------------------------------------------------------------------------------
test("citations in an answer become links only when they name a source", () => {
  assert.deepEqual(splitCitations("Yes [1]. Also [2][3] and [1, 3]; see [4] and [0] and [a].", 3), [
    { type: "text", text: "Yes " },
    { type: "cite", refs: [1], raw: "[1]" },
    { type: "text", text: ". Also " },
    { type: "cite", refs: [2], raw: "[2]" },
    { type: "cite", refs: [3], raw: "[3]" },
    { type: "text", text: " and " },
    { type: "cite", refs: [1, 3], raw: "[1, 3]" },
    { type: "text", text: "; see [4] and [0] and [a]." },
  ]);
  assert.deepEqual(splitCitations("no citations", 3), [{ type: "text", text: "no citations" }]);
  assert.deepEqual(splitCitations("[1]", 0), [{ type: "text", text: "[1]" }]);
  assert.deepEqual(splitCitations("", 2), []);
});

test("a source is found in the text that was sent, by the offsets the router returned, and never by trusting them blindly", () => {
  const text = "A".repeat(300) + "The refund window is 14 days." + "B".repeat(300);
  const docs = [{ name: "other.txt", text: "zzz" }, { name: "handbook.md", text }];
  const start = 300;
  const end = 300 + "The refund window is 14 days.".length;
  const [s] = readSources([{ ref: 1, document_id: "doc-2", chunk_index: 0, score: 0.71, start, end }], docs);
  assert.equal(s.name, "handbook.md");
  assert.equal(s.part, 1);
  assert.equal(s.excerpt.hit, "The refund window is 14 days.");
  assert.equal(s.excerpt.before, "A".repeat(200));
  assert.equal(s.excerpt.after, "B".repeat(200));
  assert.equal(s.excerpt.moreBefore && s.excerpt.moreAfter, true);
  const bad = readSources(
    [
      { ref: 1, document_id: "doc-2", start: 5, end: 99999 },
      { ref: 2, document_id: "doc-9", start: 0, end: 2 },
      { ref: 3, document_id: "../../x", start: 0, end: 2 },
      { ref: 4, document_id: "doc-1", start: 2, end: 2 },
      { ref: 5, document_id: "doc-1", start: 0, end: 3 },
      { ref: 0, document_id: "doc-1", start: 0, end: 1 },
    ],
    docs,
  );
  assert.deepEqual(bad.map((b) => [b.ref, b.excerpt === null]), [[1, true], [2, true], [3, true], [4, true], [5, false]]);
  assert.equal(bad[1].name, "doc-9"); // a document the page does not know keeps the id the router gave
  // Context never starts or ends inside a surrogate pair.
  const emoji = "😀".repeat(150);
  const [e] = readSources([{ ref: 1, document_id: "doc-1", start: 201, end: 205 }], [{ name: "e", text: emoji }]);
  assert.ok(!/[\udc00-\udfff]/.test(e.excerpt.before[0]) && !/[\ud800-\udbff]/.test(e.excerpt.after.at(-1)));
});

test("a response is read into the answer, its sources, the lane it used, the note and every receipt", () => {
  const docs = [{ name: "handbook.md", text: "Refunds are issued within 14 days of the return arriving." }];
  const json = {
    id: "r-chat",
    object: "rag.answer",
    model: "acme/chat",
    answer: "Refunds take 14 days [1]. Not [7].",
    finish_reason: "stop",
    sources: [{ ref: 1, document_id: "doc-1", chunk_index: 0, score: 0.71, start: 0, end: 57 }],
    receipts: [
      { step: "embeddings", receipt_id: "r-emb", model: "qwen/qwen3-embedding-8b", provider: "gw", lane: "attested", disclosure: "attested", cost: 0.0000011, tokens: { prompt: 105, completion: 0 }, inputs: 2, upstream_attestation: { attested: true, gpu_attested: true, receipt_verified: true, kind: "aci/1", receipt_id: "g-1" } },
      { step: "chat", receipt_id: "r-chat", model: "acme/chat", provider: "gw", lane: "attested", disclosure: "attested", cost: 0.00001, tokens: { prompt: 240, completion: 18 } },
      { step: "chat", receipt_id: "../evil", model: "x" },
    ],
    embedding_model: "qwen/qwen3-embedding-8b",
    lane: "public",
    lane_source: "default",
    lane_note: 'Not defaulted to the attested lane: no attested endpoint is known for acme/chat. Set provider.lane to "attested" to be refused instead of served.',
    disclosure: "policy",
    retrieval: { documents: 1, chunks: 1, top_k: 1, chunk: { size: 1000, overlap: 150 }, embedding_calls: 1 },
    usage: { embedding_tokens: 105, prompt_tokens: 240, completion_tokens: 18, cost: 0.0000101, cost_usd: "0.0000101" },
  };
  const a = readAnswer(json, docs);
  assert.equal(a.lane, "public");
  assert.equal(a.laneSource, "default");
  assert.match(a.laneNote, /^Not defaulted to the attested lane/);
  assert.equal(a.disclosure, "policy");
  assert.deepEqual([...a.cited], [1]);
  assert.equal(a.segments.filter((s) => s.type === "cite").length, 1); // [7] names no source
  assert.equal(a.sources[0].excerpt.hit, docs[0].text);
  assert.deepEqual(a.receipts.map((r) => [r.step, r.id]), [["embeddings", "r-emb"], ["chat", "r-chat"], ["chat", null]]);
  assert.deepEqual(a.receipts[0].attestation, { attested: true, gpu: true, verified: true, kind: "aci/1", reason: null });
  assert.equal(a.receipts[1].attestation, null);
  assert.deepEqual(a.usage, { embeddingTokens: 105, promptTokens: 240, completionTokens: 18, costUsd: "0.0000101" });
  assert.equal(a.retrieval.embeddingCalls, 1);
  assert.equal(a.developmentAttestation, false);
  assert.equal(readAnswer({ ...json, attestation_simulated: true }, docs).developmentAttestation, true);
  // Nothing in a hostile or empty response can break the reading.
  assert.equal(readAnswer(null, []).answer, "");
  assert.deepEqual(readAnswer({ usage: { cost_usd: "<b>x</b>" } }, []).usage.costUsd, null);
});

test("a refusal shows its message, the step, the limit and the calls already billed", () => {
  const e = readError({ status: 413, type: "payload_too_large", message: "A request may carry at most 200 documents.", metadata: { limit: 200, documents: 300 } });
  assert.deepEqual([e.status, e.type, e.limit, e.step, e.receipts.length], [413, "payload_too_large", 200, null, 0]);
  assert.match(e.hint, /Remove some files/);
  const b = readError({ status: 503, type: "no_attested_endpoint", message: "RAG stopped at the chat step: …", metadata: { step: "chat", receipts: [{ step: "embeddings", receipt_id: "r-1", lane: "attested", cost: 0.000001 }] }, retryAfter: "30" });
  assert.equal(b.step, "chat");
  assert.deepEqual(b.receipts.map((r) => r.id), ["r-1"]);
  assert.equal(b.retryAfter, "30");
  assert.match(b.hint, /Nothing was sent to a provider on a weaker lane/);
  assert.equal(readError(undefined).message, "The request failed.");
  assert.deepEqual(readReceipts("nope"), []);
});

// ---- receipts and the privacy label ------------------------------------------------------------------------------
test("a receipt id is used in a link only if it is a plain token, and the links stay on the router", () => {
  assert.equal(receiptIdOk("0198f2a4-7b1c-7000-8000-abcdef012345"), true);
  for (const bad of ["", "../x", "a/b", "a b", "a?b", "a#b", "-x", "x".repeat(200), null, 7]) assert.equal(receiptIdOk(bad), false, String(bad));
  assert.deepEqual(receiptLinks("r-1"), { verify: "/verify/#v-receipt", receipt: "/api/v1/receipts/r-1", privacy: "/api/v1/receipts/r-1/privacy" });
  assert.equal(receiptLinks("r-1", "https://router.example").receipt, "https://router.example/api/v1/receipts/r-1");
  assert.equal(receiptLinks("../etc"), null);
});

test("the privacy label is read when the router has it, and quietly absent when it does not or is not what was expected", () => {
  const doc = {
    receipt_id: "r-1",
    lane: "attested",
    label: { prompt_readers: "The router, in memory, to route the request; the model provider.", network: "Direct", payment: "Prepaid key", stored: "Hashes, token counts and cost. Not the text.", hardware: "Attested hardware", extra: "ignored" },
    summary: ["Line one.", "Line two.", 7, { text: "Line three." }],
    verify_url: "/verify/?receipt=r-1",
  };
  const l = readPrivacyLabel(doc, "https://router.example");
  assert.deepEqual(l.rows.map((r) => r.key), ["prompt_readers", "network", "payment", "stored", "hardware"]);
  assert.equal(l.rows[3].value, "Hashes, token counts and cost. Not the text.");
  assert.deepEqual(l.summary, ["Line one.", "Line two.", "7", "Line three."]);
  assert.equal(l.verifyUrl, "/verify/?receipt=r-1");
  assert.equal(l.lane, "attested");
  assert.deepEqual(readPrivacyLabel({ data: doc }).rows.length, 5); // wrapped in data, as the other receipt routes are
  for (const absent of [null, undefined, {}, { error: { message: "Not found" } }, { label: {} }, { label: "x" }, [], "html", { label: { prompt_readers: {} } }]) assert.equal(readPrivacyLabel(absent), null, JSON.stringify(absent));
  assert.equal(readPrivacyLabel({ label: { network: { value: "Over Tor" } } }).rows[0].value, "Over Tor");
});

test("a link from the router is followed only if it stays on this site (over Tor, another origin would leave the onion address)", () => {
  const origin = "http://abcdefgh.onion";
  assert.equal(sameSiteLink("/verify/#v-receipt", origin), "/verify/#v-receipt");
  assert.equal(sameSiteLink("http://abcdefgh.onion/verify/?x=1#y", origin), "/verify/?x=1#y");
  for (const bad of ["https://example.com/verify/", "//example.com/x", "/\\example.com", "javascript:alert(1)", "data:text/html,x", "http://abcdefgh.onion.evil.com/", "", null, 5, "/a\nb"]) assert.equal(sameSiteLink(bad, origin), null, String(bad));
  assert.equal(sameSiteLink("http://abcdefgh.onion/x", ""), null);
});

test("byte sizes are shown in binary units, as the router states its limit", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(LIMITS.bytes), "2.00 MiB");
  assert.equal(formatBytes(15 * 1024 * 1024), "15.0 MiB");
});
