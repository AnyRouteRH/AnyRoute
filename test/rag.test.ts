import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { generations, keys as keysTable, providers } from "../src/db/schema.ts";
import { balanceOf } from "../src/ledger/ledger.ts";
import { aciStaticModels, keysetDigest } from "../src/providers/aci.ts";
import { picoToUsdString } from "../src/lib/money.ts";
import { encrypt, log, setLogLevel } from "../src/lib/util.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runRegistry } from "../src/services/registry.ts";
import { ADMIN, MODELS, sse, startRouter, type Harness } from "./helpers.ts";
import { CLAIMS_OK, RECEIPT_KEY, gatewayReport, keyset, phalaVerifierAnswer, session, signedReceipt, type Claims, type ReportOptions } from "./aci-fixtures.ts";

// Private RAG (POST /api/v1/rag) end to end against a router that has one public provider (a chat model and an embedding
// model) and one attested aci/1 gateway (a chat model and two embedding models). The gateway embeds text as a bag of words,
// so the ranking can be checked against an independent calculation, answers from the first numbered source in its prompt,
// and signs a receipt for every call. The quote verifier is a local stand-in; nothing here is real evidence.

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const CHAT_CATALOGUE = fixture("aci-models-catalogue.json");
const EMBED_CATALOGUE = fixture("aci-embeddings-catalogue.json");

const GW_CHAT = "qwen/qwen-2.5-7b-instruct";
const EMBED_SMALL = "sentence-transformers/all-minilm-l6-v2"; // attested, 512 tokens of context
const EMBED_LARGE = "qwen/qwen3-embedding-8b"; // attested, 32768
const PUBLIC_CHAT = "lanetest/plain-chat";
const TINY_CHAT = "lanetest/tiny-chat"; // public, 4096 tokens of context
const PUBLIC_EMBED = "acme/embed-small";
const admin = { "x-admin-token": ADMIN };
const claim = { source: "https://gateway.example/terms", as_of: "2025-01-15" };

// ---- the gateway's text model: a bag of hashed words --------------------------------------------------------------
const STOP = new Set("a an the is are of to and with does how they it its when from in at before by uses use most or for as".split(" "));
const DIM = 512;
const hash = (w: string) => {
  let h = 2166136261;
  for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % DIM;
};
const bag = (text: string) => {
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) if (!STOP.has(w)) v[hash(w)]! += 1;
  return v;
};
const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
  const n = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return dot / (n(a) * n(b));
};

const DOCS = [
  { id: "cats", text: "Cats are small carnivorous mammals. A cat sleeps most of the day and hunts mice at night. Cats purr when they are content." },
  { id: "rockets", text: "A rocket burns propellant to produce thrust. Liquid fuel rockets carry oxidizer and fuel. Rockets reach orbit using several stages." },
  { id: "bread", text: "Bread is baked from flour, water and yeast. The dough rises before baking. Sourdough bread uses a fermented starter." },
];
const QUESTION = "How does a rocket reach orbit with its stages?";
const CANARY = "zx7-canary-quartz-8841";

type Verdict = "verified" | "routed";
type State = {
  report: ReportOptions;
  upstream: { embeddings: Verdict; chat: Verdict };
  claims: Claims;
  requests: { path: string; body: Record<string, any>; authorization: string | null }[];
};
const fresh = (): State => ({ report: {}, upstream: { embeddings: "verified", chat: "verified" }, claims: CLAIMS_OK, requests: [] });
let state = fresh();
const receipts = new Map<string, unknown>();
const sessions = new Map<string, unknown>();
let seq = 0;
const enc = new TextEncoder();

/** What the gateway says: it quotes the first six words of source [1], so the test can see which chunk led the prompt. */
const said = (body: Record<string, any>) => {
  const user = String((body.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  const first = /<source n="1"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(user)?.[1] ?? "";
  return `Per [1]: ${first.split(/\s+/).slice(0, 6).join(" ")}`;
};

function chatAnswer(body: Record<string, any>) {
  const text = said(body);
  if (body.stream !== true) return enc.encode(JSON.stringify({ id: "chatcmpl-gw", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } }));
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const base = { id: "chatcmpl-gw", object: "chat.completion.chunk", created: 1, model: body.model };
  const parts = text.match(/\S+\s*/g) ?? [text];
  return enc.encode(
    parts.map((p, i) => chunk({ ...base, choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: p } : { content: p }, finish_reason: null }] })).join("") +
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      chunk({ ...base, choices: [], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } }) +
      "data: [DONE]\n\n",
  );
}

function embeddingAnswer(body: Record<string, any>) {
  const inputs: unknown[] = Array.isArray(body.input) ? body.input : [body.input];
  const tokens = inputs.reduce((n: number, s) => n + Math.ceil(String(s).length / 4), 0);
  return enc.encode(JSON.stringify({ object: "list", data: inputs.map((s, i) => ({ object: "embedding", index: i, embedding: bag(String(s)) })), model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens } }));
}

let gw: ReturnType<typeof Bun.serve>;
let verifier: ReturnType<typeof Bun.serve>;
let h: Harness;
let auth: Record<string, string>;
let keyHash: string;

beforeAll(async () => {
  gw = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v1/aci/attestation") return Response.json(gatewayReport(u.searchParams.get("nonce") ?? "", state.report));
      if (u.pathname === "/v1/models") return Response.json({ data: [] });
      if (u.pathname.startsWith("/v1/aci/receipts/")) {
        const doc = receipts.get(decodeURIComponent(u.pathname.slice("/v1/aci/receipts/".length)));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      if (u.pathname.startsWith("/v1/aci/sessions/")) {
        const doc = sessions.get(decodeURIComponent(u.pathname.slice("/v1/aci/sessions/".length)));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      const embeddings = u.pathname === "/v1/embeddings";
      if ((embeddings || u.pathname === "/v1/chat/completions") && req.method === "POST") {
        const reqBytes = new Uint8Array(await req.arrayBuffer());
        const body = JSON.parse(new TextDecoder().decode(reqBytes));
        state.requests.push({ path: u.pathname, body, authorization: req.headers.get("authorization") });
        const bytes = embeddings ? embeddingAnswer(body) : chatAnswer(body);
        const id = `rcpt-${++seq}`;
        const servedAt = Math.floor(Date.now() / 1000);
        const s = session(state.claims, servedAt);
        sessions.set(s.id, s.doc);
        const verdict = embeddings ? state.upstream.embeddings : state.upstream.chat;
        const upstream = verdict === "verified" ? { result: "verified", required: true, session_id: s.id, claims: state.claims } : { result: "failed", required: false };
        receipts.set(id, signedReceipt({ keysetDigest: keysetDigest(state.report.keyset ?? keyset()), receiptId: id, requestBody: reqBytes, responseBody: bytes, upstream, servedAt, key: RECEIPT_KEY, model: body.model, endpoint: u.pathname }));
        return new Response(bytes, { headers: { "content-type": body.stream === true ? "text/event-stream" : "application/json", "x-receipt-id": id } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => Response.json(phalaVerifierAnswer(((await req.json()) as { hex: string }).hex, true)) });
  h = await startRouter({
    providers: [{ id: "vendor", name: "Vendor", models: [{ id: "plain", slug: PUBLIC_CHAT, prompt: "0.0000001", completion: "0.0000002" }, { id: "tiny", slug: TINY_CHAT, prompt: "0.0000001", completion: "0.0000002", ctx: 4096 }, MODELS.embed] }],
    env: { ATTESTATION_VERIFIERS: "phala", PHALA_VERIFIER_URL: `http://127.0.0.1:${verifier.port}/verify` },
  });
  const staticModels = [...aciStaticModels(CHAT_CATALOGUE, { only: new Set([GW_CHAT]) }).models, ...aciStaticModels(EMBED_CATALOGUE, { only: new Set([EMBED_SMALL, EMBED_LARGE]) }).models];
  expect(staticModels.map((m) => m.id).sort()).toEqual([EMBED_LARGE, EMBED_SMALL, GW_CHAT].sort());
  await h.ctx.db.insert(providers).values({
    id: "gw",
    name: "Gateway",
    baseUrl: `http://127.0.0.1:${gw.port}/v1`,
    apiKeyEnc: encrypt(h.ctx.cfg.appSecret, "gateway-key"),
    status: "live",
    dataPolicy: { training: false, retains_prompts: false, zdr: true },
    teeKind: "tdx",
    attestationUrl: `http://127.0.0.1:${gw.port}/v1/aci/attestation`,
    staticModels,
  });
  await runRegistry(h.ctx);
  expect((await h.request("/api/v1/disclosure/gw", { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } })).status).toBe(200);
  const k = await h.fundedKey(20n);
  auth = k.auth;
  keyHash = k.hash;
});
afterAll(async () => {
  gw.stop(true);
  verifier.stop(true);
  await h.close();
});
beforeEach(async () => {
  state = fresh();
  const { results } = await runAttestor(h.ctx);
  expect((results as { provider: string; ok: boolean }[]).find((x) => x.provider === "gw")).toMatchObject({ ok: true });
  await h.ctx.catalog.refresh();
});

const rag = (body: Record<string, unknown> = {}, headers: Record<string, string> = auth, path = "/api/v1/rag") =>
  h.request(path, { method: "POST", headers, json: { documents: DOCS, question: QUESTION, model: GW_CHAT, ...body } });
const balance = async () => {
  const [k] = await h.ctx.db.select().from(keysTable).where(eq(keysTable.keyHash, keyHash));
  return (await balanceOf(h.ctx.db, k!.accountId)).balance;
};
const vendorCalls = () => (h.mocks.vendor as unknown as { stats: { requests: number } }).stats.requests;
const sent = (path: string) => state.requests.filter((r) => r.path === path);
const generationCount = async () => ((await h.ctx.db.select({ id: generations.id }).from(generations)) as unknown[]).length;

describe("ranking and the answer", () => {
  test("the chunks are ranked by cosine similarity, best first, and the answer is grounded in the best one", async () => {
    const r = await rag({ top_k: 3 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    // An independent calculation of the same ranking.
    const expected = DOCS.map((d) => ({ id: d.id, score: cosine(bag(QUESTION), bag(d.text)) })).sort((a, b) => b.score - a.score);
    expect(expected[0]!.id).toBe("rockets");
    expect(j.sources.map((s: any) => s.document_id)).toEqual(expected.map((e) => e.id));
    j.sources.forEach((s: any, i: number) => {
      expect(s.score).toBeCloseTo(expected[i]!.score, 5);
      expect(s).toMatchObject({ ref: i + 1, chunk_index: 0, start: 0, end: DOCS.find((d) => d.id === s.document_id)!.text.length });
    });
    expect(j.sources[0].score).toBeGreaterThan(j.sources[1].score);
    expect(j.answer).toBe("Per [1]: A rocket burns propellant to produce");
    expect(j).toMatchObject({ object: "rag.answer", finish_reason: "stop", model: GW_CHAT, embedding_model: EMBED_LARGE, retrieval: { documents: 3, chunks: 3, top_k: 3, chunk: { size: 1000, overlap: 150 }, embedding_calls: 1 } });

    // What the gateway was asked: the question and the chunks embedded together, then a numbered, grounded prompt in rank order.
    const [embedReq] = sent("/v1/embeddings");
    expect(embedReq!.body).toMatchObject({ model: EMBED_LARGE, encoding_format: "float", input: [QUESTION, ...DOCS.map((d) => d.text)] });
    const [chatReq] = sent("/v1/chat/completions");
    const [system, user] = chatReq!.body.messages;
    expect(system.role).toBe("system");
    expect(system.content).toContain("only the numbered sources");
    expect(user.content).toContain(`Question: ${QUESTION}`);
    const order = [...user.content.matchAll(/<source n="(\d)" document="(\w+)" part="1">/g)].map((m: RegExpMatchArray) => [Number(m[1]), m[2]]);
    expect(order).toEqual(expected.map((e, i) => [i + 1, e.id]));
    expect(chatReq!.body.stream).toBeFalsy();
    expect(chatReq!.body.provider).toMatchObject({ aci_verified: true });
  });

  test("top_k limits the sources, and the excerpt is returned only when asked for", async () => {
    const plain = (await (await rag({ top_k: 1 })).json()) as any;
    expect(plain.sources).toHaveLength(1);
    expect(plain.sources[0]).not.toHaveProperty("excerpt");
    expect(JSON.stringify(plain.sources)).not.toContain("propellant"); // the answer may quote it; the sources do not carry it
    const asked = (await (await rag({ top_k: 2, include_excerpts: true })).json()) as any;
    expect(asked.sources).toHaveLength(2);
    expect(asked.sources[0].excerpt).toBe(DOCS[1]!.text);
    // With no top_k the default is four, capped by the chunks there are.
    expect(((await (await rag()).json()) as any).sources).toHaveLength(3);
  });

  test("a long document is cut into overlapping chunks, and a source names where its chunk lies", async () => {
    const text = [DOCS[0]!.text, DOCS[1]!.text, DOCS[2]!.text].map((t) => `${t} ${t}`).join("\n\n");
    const j = (await (await rag({ documents: [{ id: "long", text }, "A short plain-string document about tea and kettles."], chunk: { size: 260, overlap: 40 }, top_k: 3, include_excerpts: true })).json()) as any;
    expect(j.retrieval.chunk).toEqual({ size: 260, overlap: 40 });
    expect(j.retrieval.chunks).toBeGreaterThan(4);
    for (const s of j.sources) {
      expect(s.excerpt.length).toBeLessThanOrEqual(260);
      if (s.document_id === "long") expect(text.slice(s.start, s.end)).toBe(s.excerpt);
      else expect(s.document_id).toBe("doc-2"); // a plain string gets an id from its position
    }
    expect(j.sources[0].excerpt).toContain("rocket");
    // The scores are what the same bag-of-words calculation gives for each returned chunk.
    for (const s of j.sources) expect(s.score).toBeCloseTo(cosine(bag(QUESTION), bag(s.excerpt)), 5);
  });

  test("a small-context embedding model gets smaller calls, each within its context", async () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, text: `${DOCS[i % 3]!.text} ${"filler ".repeat(45)}`.slice(0, 400) }));
    const j = (await (await rag({ documents: docs, embedding_model: EMBED_SMALL, top_k: 2 })).json()) as any;
    expect(j.embedding_model).toBe(EMBED_SMALL);
    const calls = sent("/v1/embeddings");
    expect(calls.length).toBe(j.retrieval.embedding_calls);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.body.input.join("").length).toBeLessThanOrEqual(3 * (512 - 8));
    expect(calls[0]!.body.input[0]).toBe(QUESTION);
    expect(calls.flatMap((c) => c.body.input).length).toBe(6);
    expect(j.receipts.filter((x: any) => x.step === "embeddings")).toHaveLength(calls.length);
  });

  test("many documents go out in batches of 64 texts, the question first", async () => {
    const docs = Array.from({ length: 70 }, (_, i) => ({ id: `n${i}`, text: `Entry ${i}: ${DOCS[i % 3]!.text}` }));
    const j = (await (await rag({ documents: docs, top_k: 2 })).json()) as any;
    const calls = sent("/v1/embeddings");
    expect(calls.map((c) => c.body.input.length)).toEqual([64, 7]);
    expect(calls[0]!.body.input[0]).toBe(QUESTION);
    expect(j.retrieval).toMatchObject({ documents: 70, chunks: 70, embedding_calls: 2 });
    expect(j.receipts.map((x: any) => x.step)).toEqual(["embeddings", "embeddings", "chat"]);
    expect(j.receipts.filter((x: any) => x.step === "embeddings").map((x: any) => x.inputs).sort((a: number, b: number) => a - b)).toEqual([7, 64]);
    // Every rocket entry outranks every other entry, whichever batch it was embedded in.
    expect(j.sources.every((s: any) => Number(s.document_id.slice(1)) % 3 === 1)).toBe(true);
  });
});

describe("receipts and attestation", () => {
  test("every call has its own signed receipt, listed with its lane, disclosure and the gateway's attestation check", async () => {
    const before = await generationCount();
    const r = await rag({ top_k: 2 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.receipts.map((x: any) => x.step)).toEqual(["embeddings", "chat"]);
    expect((await generationCount()) - before).toBe(2);
    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, j.receipts.map((x: any) => x.receipt_id)));
    expect(rows).toHaveLength(2);
    for (const call of j.receipts) {
      expect(call).toMatchObject({ lane: "attested", disclosure: "attested", upstream_attestation: { attested: true, gpu_attested: true, receipt_verified: true, kind: "aci/1" } });
      expect(call.upstream_attestation.receipt_id).toMatch(/^rcpt-/);
      const row = rows.find((x) => x.id === call.receipt_id)!;
      expect(call.model).toBe(row.modelId);
      expect(call.provider).toBe("gw");
      expect((row.receipt as any).upstream_attestation.attested).toBe(true);
      // The receipt is the router's own, verifiable through the usual route.
      const doc = (await (await h.request(`/api/v1/receipts/${call.receipt_id}`)).json()) as any;
      expect(doc.data.payload.model).toBe(call.model);
    }
    expect(j.receipts[0]).toMatchObject({ model: EMBED_LARGE, inputs: 4 });
    expect(j.receipts[1]).toMatchObject({ model: GW_CHAT, tokens: { prompt: 40, completion: 6 } });
    // The cost is the exact sum of the two calls' charges, and the tokens are summed by kind.
    const pico = rows.reduce((n, x) => n + x.cost, 0n);
    expect(j.usage.cost_usd).toBe(picoToUsdString(pico));
    expect(j.usage.cost).toBeGreaterThan(0);
    expect(j.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 6, embedding_tokens: j.receipts[0].tokens.prompt });
    expect(j.disclosure).toBe("attested");
    expect(j).not.toHaveProperty("attestation_simulated");
  });

  test("the response headers are the chat call's receipt, the lane and the weakest disclosure of all the calls", async () => {
    const r = await rag();
    const j = (await r.json()) as any;
    expect(r.headers.get("x-receipt-id")).toBe(j.id);
    expect(r.headers.get("x-generation-id")).toBe(j.id);
    expect(r.headers.get("inference-id")).toBe(j.id);
    expect(j.id).toBe(j.receipts.at(-1).receipt_id);
    expect(r.headers.get("x-anyroute-lane")).toBe("attested");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect(r.headers.get("cache-control")).toBe("no-store");
    // The gateway's calls carry no policy hash, so none is claimed for the whole.
    expect(r.headers.get("x-anyroute-policy-hash")).toBeNull();
  });

  test("the key is billed for exactly the calls listed, from its own balance", async () => {
    const before = await balance();
    const j = (await (await rag({ documents: Array.from({ length: 70 }, (_, i) => ({ id: `n${i}`, text: DOCS[i % 3]!.text })) })).json()) as any;
    expect(j.receipts).toHaveLength(3);
    expect(before - (await balance())).toBeGreaterThan(0n);
    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, j.receipts.map((x: any) => x.receipt_id)));
    expect(before - (await balance())).toBe(rows.reduce((n, x) => n + x.cost, 0n));
    expect(rows.every((x) => x.keyHash === keyHash)).toBe(true);
  });

  test("a call the gateway's receipt does not show as attested is withheld, billed and listed; the error says where it stopped", async () => {
    state.upstream.embeddings = "routed";
    const before = await generationCount();
    const r = await rag();
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j.error).toMatchObject({ code: 502, type: "upstream_not_attested", metadata: { step: "embeddings" } });
    expect(j.error.message).toContain("RAG stopped at the embeddings step");
    expect(j.error.message).toContain("the upstream was not verified");
    expect(j.error.metadata.receipts).toHaveLength(1);
    expect(j.error.metadata.receipts[0]).toMatchObject({ step: "embeddings", withheld: true, lane: "attested", upstream_attestation: { attested: false } });
    expect(j.answer).toBeUndefined();
    expect((await generationCount()) - before).toBe(1); // billed, with a receipt
    expect(sent("/v1/chat/completions")).toHaveLength(0); // no chunk reached a chat model
  });

  test("an answer the receipt does not show as attested is withheld: the embeddings are listed and the withheld chat call too", async () => {
    state.upstream.chat = "routed";
    const r = await rag();
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j.error).toMatchObject({ type: "upstream_not_attested", metadata: { step: "chat" } });
    expect(j.error.message).toContain("RAG stopped at the chat step");
    expect(j.error.metadata.receipts.map((x: any) => [x.step, x.withheld ?? false])).toEqual([["embeddings", false], ["chat", true]]);
    expect(JSON.stringify(j)).not.toContain("Per [1]");
  });
});

describe("lane defaulting, and no downgrade", () => {
  test("with no lane given and every model attested, the attested lane is used for every call", async () => {
    const before = vendorCalls();
    const j = (await (await rag()).json()) as any;
    expect(j).toMatchObject({ lane: "attested", lane_source: "default", embedding_model: EMBED_LARGE });
    expect(j).not.toHaveProperty("lane_note");
    expect(sent("/v1/embeddings")[0]!.body.provider).toMatchObject({ aci_verified: true });
    expect(vendorCalls()).toBe(before);
    expect(j.receipts.every((x: any) => x.lane === "attested" && x.provider === "gw")).toBe(true);
  });

  test("a public chat model keeps the public lane, and the response says why and which lane each call used", async () => {
    const before = vendorCalls();
    const r = await rag({ model: PUBLIC_CHAT });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ lane: "public", lane_source: "default", embedding_model: EMBED_LARGE });
    expect(j.lane_note).toContain(`no attested endpoint is known for ${PUBLIC_CHAT}`);
    expect(vendorCalls()).toBe(before + 1); // the chat call, and only that
    expect(j.receipts.map((x: any) => [x.step, x.provider, x.lane])).toEqual([["embeddings", "gw", "public"], ["chat", "vendor", "public"]]);
    expect(j.disclosure).not.toBe("attested"); // the weakest of the calls
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
  });

  test("a lane the caller states is kept, even public: the router does not upgrade it", async () => {
    for (const [body, headers] of [[{ provider: { lane: "public" } }, auth], [{ provider: { disclosure: "any" } }, auth], [{}, { ...auth, "x-anyroute-lane": "public" }]] as const) {
      const j = (await (await rag(body, headers as Record<string, string>)).json()) as any;
      expect(j).toMatchObject({ lane: "public", lane_source: "request" });
      expect(j).not.toHaveProperty("lane_note");
      expect(j.receipts.map((x: any) => x.lane)).toEqual(["public", "public"]);
    }
  });

  test("a public embedding model chosen by the caller keeps the public lane", async () => {
    const j = (await (await rag({ embedding_model: PUBLIC_EMBED })).json()) as any;
    expect(j).toMatchObject({ lane: "public", lane_source: "default", embedding_model: PUBLIC_EMBED });
    expect(j.lane_note).toContain(`no attested endpoint is known for ${PUBLIC_EMBED}`);
    expect(sent("/v1/embeddings")).toHaveLength(0);
  });

  test("an attested request is never downgraded: a public chat model is refused, after the attested embeddings, with their receipts", async () => {
    const before = vendorCalls();
    const r = await rag({ model: PUBLIC_CHAT, provider: { lane: "attested" } });
    expect(r.status).toBe(503);
    const j = (await r.json()) as any;
    expect(j.error).toMatchObject({ code: 503, type: "no_attested_endpoint", metadata: { step: "chat", lane: "attested", reason: "none_attested" } });
    expect(j.error.message).toContain("RAG stopped at the chat step");
    expect(j.error.message).toContain('lane "attested"');
    expect(j.error.message).toContain("Nothing was sent to any provider and nothing was charged");
    expect(j.error.metadata.receipts.map((x: any) => x.step)).toEqual(["embeddings"]);
    expect(j.error.metadata.receipts[0]).toMatchObject({ lane: "attested", provider: "gw" });
    expect(vendorCalls()).toBe(before);
  });

  test("an attested request with a public embedding model is refused before anything is sent or charged", async () => {
    const spent = await balance();
    const before = vendorCalls();
    const rows = await generationCount();
    for (const req of [
      { headers: auth, body: { embedding_model: PUBLIC_EMBED, provider: { lane: "attested" } }, status: 503, type: "no_attested_endpoint" },
      { headers: auth, body: { embedding_model: PUBLIC_EMBED, provider: { disclosure: "none" } }, status: 409, type: "disclosure_unavailable" },
      { headers: { ...auth, "x-anyroute-lane": "attested" }, body: { embedding_model: PUBLIC_EMBED }, status: 503, type: "no_attested_endpoint" },
      { headers: { ...auth, "x-anyroute-disclosure-max": "none" }, body: { embedding_model: PUBLIC_EMBED }, status: 409, type: "disclosure_unavailable" },
    ]) {
      const r = await rag(req.body, req.headers);
      expect(r.status).toBe(req.status);
      const j = (await r.json()) as any;
      expect(j.error.type).toBe(req.type);
      expect(j.error.metadata).toMatchObject({ step: "embeddings", receipts: [] });
      expect(j.error.message).toContain("Nothing was sent to any provider and nothing was charged");
    }
    expect(vendorCalls()).toBe(before);
    expect(state.requests).toHaveLength(0);
    expect(await balance()).toBe(spent);
    expect(await generationCount()).toBe(rows);
  });

  test("a stated disclosure ceiling is passed on as it is, not turned into a lane", async () => {
    const j = (await (await rag({ provider: { disclosure: "policy" } })).json()) as any;
    expect(j).toMatchObject({ lane: "public", lane_source: "request" });
    expect(j.receipts.every((x: any) => x.disclosure === "attested" || x.disclosure === "policy")).toBe(true);
  });

  test("when the attested lane has lapsed, an attested request is refused instead of served, and an unstated one falls back plainly", async () => {
    const stale = async () => {
      await h.ctx.db.update(providers).set({ attestedAt: new Date(Date.now() - h.ctx.cfg.attestation.intervalMs * 5) }).where(eq(providers.id, "gw"));
      await h.ctx.catalog.refresh();
    };
    await stale();
    const refused = await rag({ provider: { lane: "attested" } });
    expect(refused.status).toBe(503);
    const j = (await refused.json()) as any;
    expect(j.error).toMatchObject({ type: "no_attested_endpoint", metadata: { step: "embeddings", reason: "none_attested", lane: "attested" } });
    expect(j.error.message).toContain('No embedding model has an endpoint with a fresh, verified attestation, so lane "attested" cannot be served');
    expect(state.requests).toHaveLength(0);
    const named = await rag({ provider: { lane: "attested" }, embedding_model: EMBED_LARGE });
    expect(named.status).toBe(503);
    expect(((await named.json()) as any).error).toMatchObject({ type: "no_attested_endpoint", metadata: { step: "embeddings" } });
    expect(state.requests).toHaveLength(0);
    // With no lane stated, nothing is claimed: the public lane, and the note says no attested endpoint is known.
    const open = (await (await rag()).json()) as any;
    expect(open.lane).toBe("public");
    expect(open.lane_note).toContain("no attested endpoint is known");
  });

  test("a lane pinned on the key applies to every step, not only to the chat call", async () => {
    const pinnedKey = await h.fundedKey(5n);
    await h.ctx.db.update(keysTable).set({ routing: { provider: { lane: "attested" } } }).where(eq(keysTable.keyHash, pinnedKey.hash));
    const ok = (await (await rag({}, pinnedKey.auth)).json()) as any;
    expect(ok).toMatchObject({ lane: "attested", lane_source: "request" });
    expect(sent("/v1/embeddings")[0]!.body.provider).toMatchObject({ aci_verified: true });
    expect(ok.receipts.map((x: any) => x.lane)).toEqual(["attested", "attested"]);
    // An embedding model that is not attested is refused, not run on the public lane for lack of a stated lane.
    const before = vendorCalls();
    const refused = await rag({ embedding_model: PUBLIC_EMBED }, pinnedKey.auth);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as any).error).toMatchObject({ type: "no_attested_endpoint", metadata: { step: "embeddings" } });
    expect(vendorCalls()).toBe(before);
    // The key's pin is a default the request may state over, as with chat.
    expect(((await (await rag({ provider: { lane: "public" }, embedding_model: PUBLIC_EMBED }, pinnedKey.auth)).json()) as any).lane).toBe("public");
    await h.ctx.db.update(keysTable).set({ routing: { provider: { lane: "unlinkable" } } }).where(eq(keysTable.keyHash, pinnedKey.hash));
    const bad = await rag({}, pinnedKey.auth);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.message).toContain("this key's routing preset");
  });

  test("a model the router resolves itself needs a stated lane, because it may pin one of its own", async () => {
    const before = state.requests.length;
    for (const model of ["@route/mine", "anyroute/council"]) {
      const r = await rag({ model });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toMatchObject({ type: "lane_required" });
    }
    expect(state.requests.length).toBe(before);
    // A key's alias is such a model too; stating the lane lets it through to the router.
    const aliased = await h.fundedKey(5n);
    await h.ctx.db.update(keysTable).set({ routing: { aliases: { fast: { model: GW_CHAT } } } }).where(eq(keysTable.keyHash, aliased.hash));
    expect((await rag({ model: "fast" }, aliased.auth)).status).toBe(400);
    const served = await rag({ model: "fast", provider: { lane: "attested" } }, aliased.auth);
    expect(served.status).toBe(200);
    expect(((await served.json()) as any)).toMatchObject({ lane: "attested", lane_source: "request", model: GW_CHAT });
  });

  test("the unlinkable lane and unknown lane values are refused before anything is sent", async () => {
    for (const provider of [{ lane: "unlinkable" }, { lane: "fast" }, { disclosure: "most" }]) {
      const r = await rag({ provider });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.type).toBe("invalid_request");
    }
    const viaHeader = await rag({}, { ...auth, "x-anyroute-lane": "unlinkable" });
    expect(viaHeader.status).toBe(400);
    expect(((await viaHeader.json()) as any).error.message).toContain("relay and a blind token");
    expect((await rag({ provider: { order: ["gw"] } })).status).toBe(400); // only lane and disclosure are accepted
    expect(state.requests).toHaveLength(0);
  });
});

describe("streaming", () => {
  test("the sources come first, the chat stream is passed through, and the receipts of every call come last", async () => {
    const r = await rag({ stream: true, top_k: 2 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-anyroute-lane")).toBe("attested");
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    const id = r.headers.get("x-receipt-id")!;
    expect(id).toMatch(/^gen-/);
    const { events, done, raw } = await sse(r);
    expect(done).toBe(true);
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // First: what was retrieved, with the embeddings receipts.
    expect(events[0]).toMatchObject({ id, object: "chat.completion.chunk", choices: [], rag: { object: "rag.sources", lane: "attested", embedding_model: EMBED_LARGE } });
    expect(events[0].rag.sources.map((s: any) => s.document_id)).toEqual(["rockets", expect.any(String)]);
    expect(events[0].rag.receipts.map((x: any) => x.step)).toEqual(["embeddings"]);
    // Then the chat stream, as the router sends it.
    const text = events.flatMap((e) => (e.choices ?? []).map((c: any) => c?.delta?.content ?? "")).join("");
    expect(text).toBe("Per [1]: A rocket burns propellant to produce");
    const routerFinal = events.find((e) => e.receipt);
    expect(routerFinal.receipt.id).toBe(id);
    expect(routerFinal.usage.cost).toBeGreaterThan(0);
    // Last: every call's receipt, and the totals.
    const summary = events.at(-1);
    expect(summary.rag).toMatchObject({ object: "rag.summary", lane: "attested", disclosure: "attested" });
    expect(summary.rag.receipts.map((x: any) => [x.step, x.lane, x.upstream_attestation.attested])).toEqual([["embeddings", "attested", true], ["chat", "attested", true]]);
    expect(summary.rag.receipts[1].receipt_id).toBe(id);
    const rows = await h.ctx.db.select().from(generations).where(inArray(generations.id, summary.rag.receipts.map((x: any) => x.receipt_id)));
    expect(summary.rag.usage.cost_usd).toBe(picoToUsdString(rows.reduce((n, x) => n + x.cost, 0n)));
    expect(sent("/v1/chat/completions")[0]!.body.stream).toBe(true);
  });

  test("an answer the receipt does not show as attested is never streamed; the stream says so and lists the billed call", async () => {
    state.upstream.chat = "routed";
    const r = await rag({ stream: true });
    expect(r.status).toBe(200);
    const { events, done } = await sse(r);
    expect(done).toBe(true);
    expect(events.flatMap((e) => (e.choices ?? []).map((c: any) => c?.delta?.content ?? "")).join("")).toBe("");
    expect(events.find((e) => e.error)?.error.type).toBe("upstream_not_attested");
    const summary = events.at(-1).rag;
    expect(summary.error).toMatchObject({ type: "upstream_not_attested" });
    expect(summary.receipts.map((x: any) => [x.step, x.withheld ?? false])).toEqual([["embeddings", false], ["chat", true]]);
  });

  test("a refusal before the answer starts is an ordinary error, not a stream", async () => {
    const r = await rag({ stream: true, model: PUBLIC_CHAT, provider: { lane: "attested" } });
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(((await r.json()) as any).error).toMatchObject({ type: "no_attested_endpoint", metadata: { step: "chat" } });
    const early = await rag({ stream: true, embedding_model: PUBLIC_EMBED, provider: { lane: "attested" } });
    expect(early.status).toBe(503);
    expect(((await early.json()) as any).error.metadata.step).toBe("embeddings");
  });

  test("a caller who goes away cancels the chat stream", async () => {
    const r = await rag({ stream: true });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    // The router settles what was generated and the request ends without an error.
    await new Promise((res) => setTimeout(res, 50));
    expect((await rag()).status).toBe(200);
  });
});

describe("requests the endpoint refuses", () => {
  test("it needs an API key, and looks at the key before the documents", async () => {
    const none = await rag({}, {});
    expect(none.status).toBe(401);
    expect(((await none.json()) as any).error.type).toBe("missing_key");
    const bad = await rag({}, { authorization: "Bearer sk-ar-v1-" + "0".repeat(64) });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).error.type).toBe("invalid_key");
    expect((await rag({ documents: "not a list" }, {})).status).toBe(401);
    expect(state.requests).toHaveLength(0);
  });

  test("malformed requests are 400s that name the field", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ documents: [] }, /documents/],
      [{ documents: "text" }, /documents/],
      [{ documents: [{ id: "a" }] }, /documents\.0/],
      [{ documents: [5] }, /documents\.0/],
      [{ documents: [{ id: "a", text: "x", extra: 1 }] }, /documents\.0/],
      [{ documents: ["   \n "] }, /documents\[0\] has no text/],
      [{ documents: [{ id: "a", text: "one" }, { id: "a", text: "two" }] }, /repeats the id "a"/],
      [{ question: "  " }, /question/],
      [{ question: undefined }, /question/],
      [{ model: undefined }, /model/],
      [{ top_k: 0 }, /top_k/],
      [{ top_k: 21 }, /top_k/],
      [{ chunk: { size: 50 } }, /chunk\.size/],
      [{ chunk: { size: 9000 } }, /chunk\.size/],
      [{ chunk: { size: 200, overlap: 101 } }, /at most half/],
      [{ chunk: { window: 200 } }, /Unrecognized key/],
      [{ stream: "yes" }, /stream/],
      [{ max_tokens: 0 }, /max_tokens/],
      [{ cache: { mode: "exact" } }, /Unrecognized key/],
      [{ embedding_model: GW_CHAT }, /is not an embedding model/],
      [{ model: EMBED_LARGE }, /is an embedding model/],
    ];
    for (const [body, pattern] of cases) {
      const r = await rag(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(((await r.json()) as any).error.message).toMatch(pattern);
    }
    const bare = await h.request("/api/v1/rag", { method: "POST", headers: auth, body: "{nope" });
    expect(bare.status).toBe(400);
    expect(state.requests).toHaveLength(0);
  });

  test("an unknown model is a 404 before anything is embedded or charged", async () => {
    const spent = await balance();
    const chat = await rag({ model: "nobody/nothing" });
    expect(chat.status).toBe(404);
    expect(((await chat.json()) as any).error.type).toBe("model_not_found");
    const emb = await rag({ embedding_model: "nobody/embeds" });
    expect(emb.status).toBe(404);
    expect(state.requests).toHaveLength(0);
    expect(await balance()).toBe(spent);
  });

  test("a prompt that could not fit the chat model is refused before the documents are embedded", async () => {
    const spent = await balance();
    const docs = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, text: `Paragraph ${i}. ${"filler ".repeat(500)}` }));
    const r = await rag({ documents: docs, model: TINY_CHAT, top_k: 4, chunk: { size: 3000, overlap: 0 } });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.error).toMatchObject({ type: "context_too_small", metadata: { context_length: 4096 } });
    expect(j.error.metadata.estimated_tokens).toBeGreaterThan(4096);
    expect(j.error.message).toContain("Lower top_k or chunk.size");
    expect(state.requests).toHaveLength(0);
    expect(await balance()).toBe(spent);
    // With chunks that fit, the same model answers.
    const fits = await rag({ documents: docs, model: TINY_CHAT, top_k: 2, chunk: { size: 1000, overlap: 0 } });
    expect(fits.status).toBe(200);
  });
});

describe("the aliases and the cache", () => {
  test("/v1/rag is the same endpoint", async () => {
    const j = (await (await rag({}, auth, "/v1/rag")).json()) as any;
    expect(j.object).toBe("rag.answer");
    expect(j.sources[0].document_id).toBe("rockets");
  });

  test("the response cache is never used, even when the caller asks for it", async () => {
    const asked = { ...auth, "x-anyroute-cache": "exact" };
    const before = vendorCalls();
    const a = await rag({ model: PUBLIC_CHAT, embedding_model: PUBLIC_EMBED }, asked);
    const b = await rag({ model: PUBLIC_CHAT, embedding_model: PUBLIC_EMBED }, asked);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get("x-anyroute-cache")).toBeNull();
    expect(vendorCalls()).toBe(before + 4); // an embeddings and a chat call each time
  });
});

describe("nothing of the documents is kept", () => {
  const everythingStored = async () => {
    const t = await h.ctx.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const names = (((t as any).rows ?? t) as { table_name: string }[]).map((r) => r.table_name);
    let out = "";
    for (const n of names) {
      const r = await h.ctx.db.execute(sql.raw(`SELECT t::text AS row FROM "${n}" t`));
      out += (((r as any).rows ?? r) as { row: string }[]).map((x) => x.row).join("\n");
    }
    return out;
  };

  test("the text of the documents, the question and the answer appear in no table, after an answer or a refusal", async () => {
    const docs = [{ id: "secret", text: `The launch code phrase is ${CANARY} and nobody may hear it.` }, ...DOCS];
    const question = `Which rocket code phrase is used, ${CANARY}-question?`;
    const ok = await rag({ documents: docs, question, include_excerpts: true });
    expect(ok.status).toBe(200);
    const answered = (await ok.json()) as any;
    expect(JSON.stringify(answered)).toContain(CANARY); // the caller gets its own text back
    state.upstream.chat = "routed";
    expect((await rag({ documents: docs, question })).status).toBe(502);
    state.upstream.chat = "verified";
    expect((await rag({ documents: docs, question, model: PUBLIC_CHAT, provider: { lane: "attested" } })).status).toBe(503);
    const rows = await everythingStored();
    expect(rows.length).toBeGreaterThan(1000); // the scan did read the tables
    expect(rows).not.toContain(CANARY);
    expect(rows).not.toContain("launch code phrase");
    expect(rows).not.toContain("Which rocket code phrase");
    expect(rows).not.toContain(answered.answer.slice(0, 20));
  });

  test("the text is never logged, at the most verbose log level, on success or failure", async () => {
    const seen: string[] = [];
    const patched: [any, string, any][] = [];
    for (const [o, name] of [[console, "log"], [console, "info"], [console, "warn"], [console, "error"], [console, "debug"], [process.stdout, "write"], [process.stderr, "write"]] as [any, string][]) {
      const orig = o[name];
      patched.push([o, name, orig]);
      o[name] = (...args: unknown[]) => {
        seen.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        return true;
      };
    }
    setLogLevel("debug");
    try {
      log.error("capture check"); // the capture below does see what the router logs
      const docs = [{ id: "secret", text: `Phrase ${CANARY} rocket orbit stages.` }, ...DOCS];
      await rag({ documents: docs, question: `${CANARY} rocket?` });
      await rag({ documents: docs, question: `${CANARY} rocket?`, stream: true }).then((r) => r.text());
      state.upstream.embeddings = "routed";
      await rag({ documents: docs, question: `${CANARY} rocket?` });
      await rag({ documents: docs, question: `${CANARY}`, embedding_model: PUBLIC_EMBED, provider: { lane: "attested" } });
      await rag({ documents: docs, question: 5 as never });
    } finally {
      setLogLevel("error");
      for (const [o, name, orig] of patched) o[name] = orig;
    }
    expect(seen.join("\n")).toContain("capture check");
    expect(seen.join("\n")).not.toContain(CANARY);
  });
});

describe("caps", () => {
  test("the defaults are 200 documents and 2 MiB of text", async () => {
    expect(h.ctx.cfg.rag).toEqual({ maxDocuments: 200, maxBytes: 2_097_152, maxChunks: 2000, maxEmbeddingCalls: 64 });
    const many = await rag({ documents: Array.from({ length: 201 }, (_, i) => `document ${i}`) });
    expect(many.status).toBe(413);
    expect(((await many.json()) as any).error).toMatchObject({ type: "payload_too_large", message: expect.stringContaining("at most 200 documents"), metadata: { limit: 200, documents: 201 } });
    const exactly = await rag({ documents: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, text: `${DOCS[i % 3]!.text}` })), top_k: 1 });
    expect(exactly.status).toBe(200);
    const big = await rag({ documents: ["a".repeat(700_000), "b".repeat(700_000), "c".repeat(700_000)] });
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).error.message).toContain("2097152 bytes");
    // Bytes, not characters: 3-byte characters count as three.
    const wide = await rag({ documents: ["€".repeat(400_000), "€".repeat(400_000)] });
    expect(wide.status).toBe(413);
  });

  test("the caps are settings, and a request over any of them sends nothing", async () => {
    const small = await startRouter({ env: { RAG_MAX_DOCUMENTS: "3", RAG_MAX_BYTES: "500", RAG_MAX_CHUNKS: "3", RAG_MAX_EMBEDDING_CALLS: "1" } });
    try {
      expect(small.ctx.cfg.rag).toEqual({ maxDocuments: 3, maxBytes: 500, maxChunks: 3, maxEmbeddingCalls: 1 });
      const k = await small.fundedKey(5n);
      const call = (body: Record<string, unknown>) => small.request("/api/v1/rag", { method: "POST", headers: k.auth, json: { question: "What?", model: MODELS.llama.slug, embedding_model: MODELS.embed.slug, ...body } });
      const reason = async (r: Response) => ((await r.json()) as any).error.message as string;
      const four = await call({ documents: ["a", "b", "c", "d"] });
      expect(four.status).toBe(413);
      expect(await reason(four)).toContain("at most 3 documents");
      const long = await call({ documents: ["x ".repeat(300)] });
      expect(long.status).toBe(413);
      expect(await reason(long)).toContain("at most 500 bytes");
      const chunks = await call({ documents: ["word ".repeat(90)], chunk: { size: 100, overlap: 0 } });
      expect(chunks.status).toBe(413);
      expect(await reason(chunks)).toMatch(/make \d+ chunks, and a request may embed at most 3/);
      // Calls: a 2-batch plan (64 + 1 texts) is over a cap of one call.
      const roomy = await startRouter({ env: { RAG_MAX_DOCUMENTS: "200", RAG_MAX_CHUNKS: "2000", RAG_MAX_EMBEDDING_CALLS: "1" } });
      try {
        const k2 = await roomy.fundedKey(5n);
        const calls = await roomy.request("/api/v1/rag", { method: "POST", headers: k2.auth, json: { question: "What?", model: MODELS.llama.slug, embedding_model: MODELS.embed.slug, documents: Array.from({ length: 70 }, (_, i) => `document number ${i}`) } });
        expect(calls.status).toBe(413);
        expect(await reason(calls)).toContain("may make at most 1");
      } finally {
        await roomy.close();
      }
      // Within the caps it works, on the public provider alone.
      const fine = await call({ documents: ["Rockets reach orbit.", "Bread rises."], top_k: 1 });
      expect(fine.status).toBe(200);
      const j = (await fine.json()) as any;
      expect(j).toMatchObject({ lane: "public", embedding_model: MODELS.embed.slug, receipts: [{ step: "embeddings", provider: "alpha" }, { step: "chat" }] });
      expect(j.answer).toContain("Hello from");
    } finally {
      await small.close();
    }
  });
});
