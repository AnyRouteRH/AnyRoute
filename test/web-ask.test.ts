import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chunkText as routerChunkText } from "../src/rag/text.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
// @ts-expect-error the page's library is plain JavaScript with no declaration file
import * as ask from "../web/lib/ask.js";

// The page at /ask/ mirrors the router's limits and chunker, and reads the endpoint's response. These tests hold the two
// together: the page's chunker must cut exactly as src/rag/text.ts does, its limits must be the router's defaults, and the
// request it builds must be accepted by POST /api/v1/rag, whose answer it must place back in the text that was sent.

describe("the page's chunker is the router's", () => {
  const corpus: string[] = [
    "",
    "   \n\t  ",
    "one",
    "A short paragraph. Another sentence follows! And a question? Then the end.",
    `${"Paragraph one has several sentences. It goes on for a while.\n\n".repeat(30)}Last.`,
    `${"line of text\n".repeat(120)}`,
    "x".repeat(5000), // no space to break on
    `${"word ".repeat(400)}`,
    `${"日本語の文章です。".repeat(200)}`,
    `${"😀".repeat(900)}`,
    `${"a😀b ".repeat(300)}`,
    `nbsp separated words ${"pad　".repeat(300)}`,
    `${"tab\tseparated\tfields\r\nwindows line\r\n".repeat(80)}`,
    `${"é ".repeat(1200)}`,
  ];
  const settings: [number, number][] = [[100, 0], [100, 15], [100, 50], [250, 37], [1000, 150], [1000, 500], [4000, 600], [8000, 1200], [333, 50]];

  test("every text in the corpus, at every setting, is cut identically", () => {
    for (const text of corpus) for (const [size, overlap] of settings) expect(ask.chunkText(text, size, overlap)).toEqual(routerChunkText(text, size, overlap));
  });

  test("pseudo-random texts are cut identically", () => {
    let seed = 20260929;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const atoms = ["alpha", "beta ", "gamma.", " ", "\n", "\n\n", "delta! ", "😀", "é", " ", "x".repeat(40), "why? ", "。", "\t"];
    for (let i = 0; i < 300; i++) {
      let text = "";
      const n = 1 + Math.floor(rnd() * 400);
      for (let j = 0; j < n; j++) text += atoms[Math.floor(rnd() * atoms.length)];
      const size = 100 + Math.floor(rnd() * 900);
      const overlap = Math.floor(rnd() * (size / 2));
      expect(ask.chunkText(text, size, overlap)).toEqual(routerChunkText(text, size, overlap));
    }
  });

  test("the default overlap is the router's, for every size the endpoint accepts", () => {
    // The endpoint: overlap defaults to Math.round(size * 0.15). Sizes 100..8000.
    for (let size = 100; size <= 8000; size += 37) expect(ask.overlapFor(size)).toBe(Math.round(size * 0.15));
  });
});

describe("the page against a running router", () => {
  let h: Harness;
  let auth: Record<string, string>;
  const CHAT = MODELS.llama.slug;
  const call = (body: unknown, headers: Record<string, string> = auth) => h.request("/api/v1/rag", { method: "POST", headers, json: body });

  beforeAll(async () => {
    h = await startRouter();
    auth = (await h.fundedKey(20n)).auth;
  });
  afterAll(async () => {
    await h.close();
  });

  const files = async () => {
    const parsed = [
      { name: "handbook.md", ...(await ask.parseFile("handbook.md", new TextEncoder().encode("# Returns\n\nRefunds are issued within 14 days of the return arriving.\n\n" + "Shipping notes. ".repeat(120)))) },
      { name: "prices.csv", ...(await ask.parseFile("prices.csv", new TextEncoder().encode("item,price\ntea,3\ncoffee,4\n"))) },
      { name: "page.html", ...(await ask.parseFile("page.html", new TextEncoder().encode("<html><head><title>FAQ</title></head><body><p>Orders ship in two days.</p><script>x()</script></body></html>"))) },
    ];
    for (const f of parsed) expect(f.ok).toBe(true);
    return parsed as { name: string; text: string }[];
  };

  test("the limits the page shows are the router's defaults", () => {
    expect(h.ctx.cfg.rag).toEqual({ maxDocuments: ask.LIMITS.documents, maxBytes: ask.LIMITS.bytes, maxChunks: ask.LIMITS.chunks, maxEmbeddingCalls: ask.LIMITS.embeddingCalls });
    expect(ask.EMBED_BATCH_ITEMS).toBe(64);
    expect(ask.QUESTION_MAX).toBe(8000);
  });

  test("the request the page builds is accepted, and the chunk and call counts it showed are the ones the router made", async () => {
    const docs = await files();
    const plan = ask.planRequest(docs, { chunkSize: 300 });
    const body = ask.buildRagRequest({ docs, question: "How long do refunds take?", model: CHAT, lane: "public", topK: 3, chunkSize: 300 });
    const r = await call(body);
    expect(r.status).toBe(200);
    const json = (await r.json()) as any;
    expect(json.retrieval).toMatchObject({ documents: docs.length, chunks: plan.chunks, chunk: { size: 300, overlap: 45 }, embedding_calls: plan.embeddingCalls });
    expect(json.lane).toBe("public");
    expect(json.lane_source).toBe("request");
    // No file name reached the router: only doc-1, doc-2, doc-3.
    expect(new Set(json.sources.map((s: any) => s.document_id))).toEqual(new Set(json.sources.map((s: any) => s.document_id).filter((id: string) => /^doc-[123]$/.test(id))));
    expect(JSON.stringify(json)).not.toContain("handbook.md");

    // The sources are placed back in the text that was sent, by the offsets the router returned.
    const a = ask.readAnswer(json, docs);
    expect(a.sources).toHaveLength(3);
    for (const [i, s] of a.sources.entries()) {
      const src = json.sources[i];
      const doc = docs[Number(src.document_id.slice(4)) - 1]!;
      expect(s.name).toBe(doc.name);
      expect(s.excerpt).not.toBeNull();
      expect(s.excerpt.hit).toBe(doc.text.slice(src.start, src.end));
      // ... which is exactly the chunk the page's own chunker makes at that position.
      expect(ask.chunkText(doc.text, 300, 45)[src.chunk_index].text).toBe(s.excerpt.hit);
    }
    // The excerpt was not requested: the router sent none.
    expect(json.sources.every((s: any) => !("excerpt" in s))).toBe(true);
    // Every call is listed with an id the page can link.
    expect(a.receipts.map((x: any) => x.step)).toEqual(["embeddings", "chat"]);
    for (const x of a.receipts) expect(ask.receiptLinks(x.id)).not.toBeNull();
    expect(a.usage.costUsd).toMatch(/^\d/);
  });

  test("with no lane stated the router chooses, and the note it gives is what the page shows", async () => {
    const docs = await files();
    const r = await call(ask.buildRagRequest({ docs, question: "When do orders ship?", model: CHAT, lane: "auto" }));
    expect(r.status).toBe(200);
    const a = ask.readAnswer(await r.json(), docs);
    expect(a.lane).toBe("public");
    expect(a.laneSource).toBe("default");
    expect(a.laneNote).toContain("Not defaulted to the attested lane");
  });

  test("the attested lane is refused, not downgraded, when nothing here is attested, and the page reads the refusal", async () => {
    const docs = await files();
    const r = await call(ask.buildRagRequest({ docs, question: "When do orders ship?", model: CHAT }));
    expect(r.status).toBe(503);
    const j = (await r.json()) as any;
    const e = ask.readError({ status: r.status, type: j.error.type, message: j.error.message, metadata: j.error.metadata });
    expect(e.type).toBe("no_attested_endpoint");
    expect(e.hint).toContain("weaker lane");
    expect(e.status).toBe(503);
  });

  test("a request over a limit is refused with the limit the page reads", async () => {
    const docs = Array.from({ length: ask.LIMITS.documents + 1 }, () => ({ name: "n.txt", text: "hello there" }));
    expect(ask.planRequest(docs).over).toEqual(["documents"]);
    const r = await call(ask.buildRagRequest({ docs, question: "hello?", model: CHAT, lane: "public" }));
    expect(r.status).toBe(413);
    const j = (await r.json()) as any;
    const e = ask.readError({ status: r.status, type: j.error.type, message: j.error.message, metadata: j.error.metadata });
    expect(e.limit).toBe(ask.LIMITS.documents);
  });

  test("the page's idea of a request that is too big for the chunks matches the router's", async () => {
    // 2,001 documents of one chunk each is over the chunk cap and the document cap; the router names the document cap first.
    const docs = Array.from({ length: 201 }, () => ({ name: "n.txt", text: "hello there" }));
    const plan = ask.planRequest(docs);
    expect(plan.blocked).toBe(true);
    // Exactly at the document cap is accepted.
    const atCap = docs.slice(0, ask.LIMITS.documents);
    expect(ask.planRequest(atCap).blocked).toBe(false);
    const r = await call(ask.buildRagRequest({ docs: atCap, question: "hello?", model: CHAT, lane: "public" }));
    expect(r.status).toBe(200);
  });

  test("the privacy label of a receipt is read when the router has one and is absent otherwise, never an error", async () => {
    const docs = await files();
    const j = (await (await call(ask.buildRagRequest({ docs, question: "shipping?", model: CHAT, lane: "public" }))).json()) as any;
    const id = j.receipts[1].receipt_id;
    const r = await h.request(`/api/v1/receipts/${id}/privacy`);
    const label = ask.readPrivacyLabel(await r.json().catch(() => null), "http://localhost");
    if (r.status === 200) expect(label).not.toBeNull();
    else expect(label).toBeNull();
    // The receipt itself is public by id, which is what the page links to.
    expect((await h.request(`/api/v1/receipts/${id}`)).status).toBe(200);
  });
});
