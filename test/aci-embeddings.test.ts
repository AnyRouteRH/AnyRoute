import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { generations, providers } from "../src/db/schema.ts";
import { aciStaticModels, keysetDigest, type AciGateway } from "../src/providers/aci.ts";
import { toolkit } from "../src/api/chat.ts";
import { parseProviderModels } from "../src/services/registry.ts";
import { runRegistry } from "../src/services/registry.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { encrypt } from "../src/lib/util.ts";
import { ADMIN, sse, startRouter, type Harness } from "./helpers.ts";
import { CLAIMS_OK, OTHER_KEY, RECEIPT_KEY, gatewayReport, keyset, phalaVerifierAnswer, session, signedReceipt, type Claims, type ReportOptions } from "./aci-fixtures.ts";

// Embeddings and image inputs through an attested aci/1 gateway, end to end against the router: a mock gateway that
// serves a report bound to the attestor's nonce, answers /embeddings and /chat/completions and signs a receipt for
// each, and a mock of the quote verifier. The model list is built from captured public catalogues
// (test/fixtures/aci-*-catalogue.json) by the same function the operator uses. Nothing here is real evidence.

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const CHAT_CATALOGUE = fixture("aci-models-catalogue.json");
const EMBED_CATALOGUE = fixture("aci-embeddings-catalogue.json");

const VISION = "qwen/qwen3-vl-30b-a3b-instruct";
const TEXT = "qwen/qwen-2.5-7b-instruct";
const EMBED_SMALL = "sentence-transformers/all-minilm-l6-v2";
const EMBED_LARGE = "qwen/qwen3-embedding-8b";
const admin = { "x-admin-token": ADMIN };
const claim = { source: "https://gateway.example/terms", as_of: "2025-01-15" };

type State = {
  report: ReportOptions;
  upstream: "verified" | "routed";
  claimsIn: "receipt" | "session";
  claims: Claims;
  receipt: "ok" | "missing" | "bad-signature" | "other-response";
  /** Answer every inference call with this status instead (the gateway found no attested upstream). */
  refuse: number | null;
  requests: { path: string; body: Record<string, any>; authorization: string | null }[];
};
const fresh = (): State => ({ report: {}, upstream: "verified", claimsIn: "receipt", claims: CLAIMS_OK, receipt: "ok", refuse: null, requests: [] });
let state = fresh();
const receipts = new Map<string, unknown>();
const sessions = new Map<string, unknown>();
let seq = 0;
const enc = new TextEncoder();

const imagesIn = (body: Record<string, any>) => (body.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p?.type === "image_url").length;

function chatAnswer(body: Record<string, any>) {
  const said = `I see ${imagesIn(body)} image(s)`;
  if (body.stream !== true) return enc.encode(JSON.stringify({ id: "chatcmpl-gw", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: said }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } }));
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const base = { id: "chatcmpl-gw", object: "chat.completion.chunk", created: 1, model: body.model };
  return enc.encode(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: said }, finish_reason: "stop" }] }) + chunk({ ...base, choices: [], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 } }) + "data: [DONE]\n\n");
}

function embeddingAnswer(body: Record<string, any>) {
  const inputs: unknown[] = Array.isArray(body.input) ? body.input : [body.input];
  const dims = Number.isInteger(body.dimensions) ? body.dimensions : 4;
  const vector = (i: number) => Array.from({ length: dims }, (_, j) => (String(inputs[i]).length + i + j) / 100);
  const data = inputs.map((_, i) => ({ object: "embedding", index: i, embedding: body.encoding_format === "base64" ? Buffer.from(new Float32Array(vector(i)).buffer).toString("base64") : vector(i) }));
  const tokens = inputs.reduce((n: number, s) => n + Math.ceil(String(s).length / 4), 0);
  return enc.encode(JSON.stringify({ object: "list", data, model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens } }));
}

let gw: ReturnType<typeof Bun.serve>;
let verifier: ReturnType<typeof Bun.serve>;
let h: Harness;
let auth: Record<string, string>;

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
        if (state.refuse) return Response.json({ error: { message: `upstream verification failed: no attested upstream available for model ${body.model}`, type: "service_unavailable" } }, { status: state.refuse });
        const bytes = embeddings ? embeddingAnswer(body) : chatAnswer(body);
        const id = `rcpt-${++seq}`;
        const servedAt = Math.floor(Date.now() / 1000);
        const s = session(state.claims, servedAt);
        sessions.set(s.id, s.doc);
        const upstream = state.upstream === "verified" ? { result: "verified", required: true, session_id: s.id, ...(state.claimsIn === "receipt" ? { claims: state.claims } : {}) } : { result: "failed", required: false };
        const doc = signedReceipt({
          keysetDigest: keysetDigest(state.report.keyset ?? keyset()),
          receiptId: id,
          requestBody: reqBytes,
          responseBody: state.receipt === "other-response" ? "something else" : bytes,
          upstream,
          servedAt,
          key: state.receipt === "bad-signature" ? OTHER_KEY : RECEIPT_KEY,
          model: body.model,
          endpoint: u.pathname,
        });
        if (state.receipt !== "missing") receipts.set(id, doc);
        return new Response(bytes, { headers: { "content-type": body.stream === true ? "text/event-stream" : "application/json", "x-receipt-id": id } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => Response.json(phalaVerifierAnswer(((await req.json()) as { hex: string }).hex, true)) });
  h = await startRouter({ providers: [{ id: "vendor", name: "Vendor", models: [{ id: "plain", slug: "lanetest/plain-chat", prompt: "0.0000001", completion: "0.0000002" }] }], env: { ATTESTATION_VERIFIERS: "phala", PHALA_VERIFIER_URL: `http://127.0.0.1:${verifier.port}/verify` } });
  // The model list the operator loads: chat, vision and embedding models from the gateway's public catalogues.
  const staticModels = [...aciStaticModels(CHAT_CATALOGUE, { only: new Set([VISION, TEXT]) }).models, ...aciStaticModels(EMBED_CATALOGUE, { only: new Set([EMBED_SMALL, EMBED_LARGE]) }).models];
  expect(staticModels.map((m) => m.id).sort()).toEqual([EMBED_LARGE, EMBED_SMALL, TEXT, VISION].sort());
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
  const r = await h.request("/api/v1/disclosure/gw", { method: "PUT", headers: admin, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } });
  expect(r.status).toBe(200);
  auth = (await h.fundedKey(20n)).auth;
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

const embed = (body: Record<string, unknown> = {}) => h.request("/api/v1/embeddings", { method: "POST", headers: auth, json: { model: EMBED_SMALL, input: "a private note", ...body } });
const chat = (body: Record<string, unknown> = {}) => h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: { model: VISION, messages: [{ role: "user", content: "hello" }], max_tokens: 16, ...body } });
const attestedLane = { provider: { lane: "attested" } };
const listed = async (q = "") => ((await (await h.request(`/api/v1/models${q}`)).json()) as { data: any[] }).data;

describe("the model list built from the gateway's catalogues", () => {
  test("embedding and vision models are advertised as what they accept and produce, at the catalogue's prices", async () => {
    const byId = new Map((await listed()).map((m) => [m.id, m]));
    expect(byId.get(EMBED_SMALL)).toMatchObject({ architecture: { modality: "text->embeddings", input_modalities: ["text"], output_modalities: ["embeddings"] }, context_length: 512, pricing: { prompt: "0.000000005", completion: "0" } });
    expect(byId.get(EMBED_LARGE)).toMatchObject({ architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] }, context_length: 32768, pricing: { prompt: "0.00000001", completion: "0" } });
    expect(byId.get(VISION)).toMatchObject({ architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0.0000002", completion: "0.0000007" } });
    expect(byId.get(TEXT)).toMatchObject({ architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] } });
  });
  test("the fixture catalogues produce a valid provider list without any restricted variant, at upstream prices", () => {
    const chatList = aciStaticModels(CHAT_CATALOGUE);
    const embedList = aciStaticModels(EMBED_CATALOGUE);
    const all = [...chatList.models, ...embedList.models];
    expect(parseProviderModels({ data: all }).errors).toEqual([]);
    expect(all.length).toBe(23);
    expect(chatList.skipped.map((s) => s.id).sort()).toEqual(["phala/gemma-4-26b-a4b-uncensored", "phala/qwen3.8-27b-uncensored"]);
    expect(all.some((m) => /uncensor|abliterat/i.test(String(m.id)))).toBe(false);
    const upstream = new Map([...CHAT_CATALOGUE.data, ...EMBED_CATALOGUE.data].map((m: any) => [m.id, m.pricing]));
    for (const m of all) expect(m.pricing).toMatchObject({ prompt: upstream.get(m.id as string).prompt, completion: upstream.get(m.id as string).completion });
    // Every model that takes images is listed as doing so; embedding models take text and produce embeddings.
    const vision = all.filter((m) => (m.input_modalities as string[]).includes("image")).map((m) => m.id);
    expect(vision).toContain(VISION);
    for (const m of embedList.models) expect(m).toMatchObject({ input_modalities: ["text"], output_modalities: ["embeddings"] });
    for (const m of embedList.models) expect(m).not.toHaveProperty("max_completion_tokens");
  });
});

describe("embeddings", () => {
  test("verified: the vectors are returned and the router's signed receipt carries the gateway's record", async () => {
    const r = await embed({ provider: { sort: "price", zdr: false, aci_verified: false }, dimensions: 3, encoding_format: "float" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.data).toHaveLength(1);
    expect(j.data[0].embedding).toHaveLength(3);
    expect(j.model).toBe(EMBED_SMALL);
    expect(j.usage.cost).toBeGreaterThan(0);
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    expect(j.receipt.payload.disclosure).toBe("attested");
    expect(j.receipt.payload.upstream_attestation).toEqual({
      kind: "aci/1",
      receipt_id: `rcpt-${seq}`,
      workload_id: null,
      keyset_digest: keysetDigest(keyset()),
      receipt_verified: true,
      upstream: expect.objectContaining({ result: "verified", required: true, model_id: EMBED_SMALL }),
      claims: { tee_attested: { status: "asserted", source: "hardware_proven" }, tcb_up_to_date: { status: "asserted", source: "hardware_proven" }, gpu_attested: { status: "asserted", source: "verifier_derived" }, model_weights_provenance: { status: "unknown" }, zdr: null },
      gpu_attested: true,
      attested: true,
      constraints: { aci_verified: true, zdr: true },
    });
    // What the gateway was asked: attested, zero-retention serving, whatever the caller's own routing block said.
    const sent = state.requests.at(-1)!;
    expect(sent.path).toBe("/v1/embeddings");
    expect(sent.body).toMatchObject({ model: EMBED_SMALL, input: "a private note", dimensions: 3, encoding_format: "float", provider: { aci_verified: true, zdr: true } });
    expect(sent.authorization).toBe("Bearer gateway-key");
    const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, j.id));
    expect((row.receipt as any).upstream_attestation.attested).toBe(true);
  });
  test("a list of inputs and base64 vectors pass through, and the receipt covers those exact bytes", async () => {
    const r = await embed({ model: EMBED_LARGE, input: ["one", "two", "three"], encoding_format: "base64", ...attestedLane });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.data.map((d: any) => typeof d.embedding)).toEqual(["string", "string", "string"]);
    expect(j.receipt.payload.upstream_attestation).toMatchObject({ receipt_verified: true, attested: true, upstream: { model_id: EMBED_LARGE } });
  });
  test("claims the receipt leaves to its session are read from the session", async () => {
    state.claimsIn = "session";
    const j = (await (await embed(attestedLane)).json()) as any;
    expect(j.receipt.payload.upstream_attestation).toMatchObject({ attested: true, gpu_attested: true, claims: { tee_attested: { status: "asserted" } } });
  });
  test("public lane: vectors from a routed upstream are returned, recorded as not attested, and not served as attested", async () => {
    state.upstream = "routed";
    const r = await embed();
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.data).toHaveLength(1);
    expect(r.headers.get("x-anyroute-disclosure")).toBe("policy");
    expect(j.receipt.payload).toMatchObject({ disclosure: "policy", upstream_attestation: { receipt_verified: true, attested: false, upstream: { result: "failed", required: false } } });
    expect(j.receipt.payload.upstream_attestation.reason).toContain("the upstream was not verified");
  });
  test("attested lane: vectors the receipt does not show as attested are withheld, billed and receipted", async () => {
    const cases: [Partial<State>, string][] = [
      [{ upstream: "routed" }, "the upstream was not verified"],
      [{ claims: { ...CLAIMS_OK, tee_attested: { status: "unknown" } } }, "tee_attested is not asserted"],
      [{ receipt: "bad-signature" }, "the receipt signature does not verify"],
      [{ receipt: "missing" }, "the receipt could not be fetched (HTTP 404)"],
      [{ receipt: "other-response" }, "the receipt does not commit to the response the router received"],
    ];
    for (const [over, reason] of cases) {
      state = { ...fresh(), ...over };
      const r = await embed(attestedLane);
      expect(r.status).toBe(502);
      const j = (await r.json()) as any;
      expect(j.error.type).toBe("upstream_not_attested");
      expect(j.error.message).toContain(reason);
      expect(j.data).toBeUndefined();
      expect(j.usage.cost).toBeGreaterThan(0);
      expect(j.receipt.payload).toMatchObject({ lane: "attested", disclosure: "policy", upstream_attestation: { attested: false } });
      expect(j.receipt.payload.upstream_attestation.reason).toContain(reason);
      const [row] = await h.ctx.db.select().from(generations).where(eq(generations.id, j.id));
      expect(row.cost).toBeGreaterThan(0n);
      expect((row.receipt as any).upstream_attestation.attested).toBe(false);
    }
  });
  test("the other ways to ask for attested hardware are held to the same rule", async () => {
    state.upstream = "routed";
    expect((await embed({ model: `${EMBED_SMALL}:private` })).status).toBe(502);
    expect((await embed({ provider: { private: true } })).status).toBe(502);
    expect((await embed({ provider: { disclosure: "none" } })).status).toBe(502);
    const viaHeader = await h.request("/api/v1/embeddings", { method: "POST", headers: { ...auth, "x-anyroute-lane": "attested" }, json: { model: EMBED_SMALL, input: "x" } });
    expect(viaHeader.status).toBe(502);
    expect(((await viaHeader.json()) as any).error.type).toBe("upstream_not_attested");
  });
  test("a gateway that finds no attested upstream sends the input nowhere and charges nothing", async () => {
    state.refuse = 503;
    const before = state.requests.length;
    const r = await embed(attestedLane);
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j.error.type).toBe("providers_unavailable");
    expect(j.data).toBeUndefined();
    expect(state.requests.length).toBe(before + 1); // the gateway was asked once, and refused before sending the input anywhere
  });
  test("an input over the model's context is refused before it leaves the router", async () => {
    const before = state.requests.length;
    const r = await embed({ input: "word ".repeat(600) });
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error.metadata.excluded[0].reason).toBe("context length exceeded");
    expect(state.requests.length).toBe(before);
  });
  test("the attested listing says whether the latest verified receipt asserted GPU attestation", async () => {
    await embed();
    await h.ctx.catalog.refresh();
    expect((await listed("?lane=attested")).find((m) => m.id === EMBED_SMALL)).toMatchObject({ gpu_attested: true });
    state.claims = { ...CLAIMS_OK, gpu_attested: { status: "unknown" } };
    await embed();
    await h.ctx.catalog.refresh();
    expect((await listed("?lane=attested")).find((m) => m.id === EMBED_SMALL)).toMatchObject({ gpu_attested: false });
  });
  test("a gateway call the router kept no record of counts as not attested", async () => {
    const gateway = (await h.ctx.catalog.provider("gw"))!.aci as AciGateway;
    const cand = h.ctx.catalog.offers(EMBED_SMALL).find((o) => o.providerId === "gw")!;
    const ua = await toolkit.upstreamAttestationOf(h.ctx, { candidate: cand, exchange: undefined }, new Map());
    expect(ua).toMatchObject({ receipt_verified: false, attested: false, gpu_attested: false, keyset_digest: gateway.keysetDigest });
    expect(ua!.reason).toContain("no record");
  });
});

describe("images", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const withImages = [{ role: "user", content: [{ type: "text", text: "What is in these pictures?" }, { type: "image_url", image_url: { url: png } }, { type: "image_url", image_url: { url: "https://images.example/cat.jpg", detail: "low" } }] }];

  test("image parts reach the gateway exactly as sent, and the answer is verified against them", async () => {
    const r = await chat({ messages: withImages, ...attestedLane });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.choices[0].message.content).toBe("I see 2 image(s)");
    expect(j.receipt.payload.upstream_attestation).toMatchObject({ receipt_verified: true, attested: true, gpu_attested: true, upstream: { model_id: VISION } });
    expect(r.headers.get("x-anyroute-disclosure")).toBe("attested");
    const sent = state.requests.at(-1)!;
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sent.body.messages).toEqual(withImages);
    expect(sent.body.provider).toEqual({ aci_verified: true, zdr: true });
  });
  test("attested lane: an answer about an image that the receipt does not show as attested is withheld and billed", async () => {
    state.upstream = "routed";
    const r = await chat({ messages: withImages, ...attestedLane });
    expect(r.status).toBe(502);
    const j = (await r.json()) as any;
    expect(j.error.type).toBe("upstream_not_attested");
    expect(j.choices).toBeUndefined();
    expect(j.usage.cost).toBeGreaterThan(0);
    expect(j.receipt.payload.upstream_attestation.attested).toBe(false);
  });
  test("a tampered response to an image request fails the receipt's response hash", async () => {
    state.receipt = "other-response";
    const r = await chat({ messages: withImages, ...attestedLane });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.message).toContain("does not commit to the response");
  });
  test("streams: an image request on the attested lane is held until the receipt verifies", async () => {
    const { events, done } = await sse(await chat({ messages: withImages, stream: true, ...attestedLane }));
    expect(done).toBe(true);
    const text = events.flatMap((e) => (e.choices ?? []).map((c: any) => c?.delta?.content ?? "")).join("");
    expect(text).toBe("I see 2 image(s)");
    expect(events.at(-1).receipt.payload.upstream_attestation).toMatchObject({ receipt_verified: true, attested: true });
    state.upstream = "routed";
    const refused = await sse(await chat({ messages: withImages, stream: true, ...attestedLane }));
    expect(refused.events.flatMap((e) => (e.choices ?? []).map((c: any) => c?.delta?.content ?? "")).join("")).toBe("");
    expect(refused.events.find((e) => e.error).error.type).toBe("upstream_not_attested");
  });
  test("each image is priced into the hold: a key that cannot cover the request is refused before anything is sent", async () => {
    const poor = await h.newKey();
    const before = state.requests.length;
    const r = await h.request("/api/v1/chat/completions", { method: "POST", headers: poor.auth, json: { model: VISION, messages: withImages, max_tokens: 16 } });
    expect(r.status).toBe(402);
    expect(state.requests.length).toBe(before);
  });
});
