import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providers } from "../src/db/schema.ts";
import type { AgentPolicy } from "../src/agents/policy.ts";
import { aciStaticModels, keysetDigest } from "../src/providers/aci.ts";
import { encrypt } from "../src/lib/util.ts";
import { runAttestor } from "../src/services/attestor.ts";
import { runRegistry } from "../src/services/registry.ts";
import { ADMIN, MODELS, startRouter, type Harness } from "./helpers.ts";
import { CLAIMS_OK, RECEIPT_KEY, gatewayReport, keyset, phalaVerifierAnswer, session, signedReceipt } from "./aci-fixtures.ts";

// U101: the key's default route (rulebook `route_default`) on embeddings, rerank and POST /api/v1/rag. One public
// provider ("vendor": a chat model, an embedding model and two rerank models), one development enclave ("enclave": a
// rerank model the vendor also serves) and one attested aci/1 gateway ("gw": a chat model and an embedding model, every
// answer signed), as in rag.test.ts. The quote verifier is a stand-in run by this file.

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const GW_CHAT = "qwen/qwen-2.5-7b-instruct";
const GW_EMBED = "qwen/qwen3-embedding-8b";
const PUBLIC_CHAT = "lanetest/plain-chat";
const PUBLIC_EMBED = MODELS.embed.slug;
const RERANK_PUBLIC = { id: "rerank-small-v1", slug: "acme/rerank-small", prompt: "0.00000002", completion: "0", output: ["rerank"] };
const RERANK_SHARED = { id: "rerank-shared-v1", slug: "acme/rerank-shared", prompt: "0.00000002", completion: "0", output: ["rerank"] };
const base: AgentPolicy = { version: 1, models: {}, caps: {}, on_breach: "deny" };
const claim = { source: "https://gateway.example/terms", as_of: "2025-01-15" };
const DOCS = [
  { id: "rockets", text: "A rocket burns propellant to produce thrust. Rockets reach orbit using several stages." },
  { id: "bread", text: "Bread is baked from flour, water and yeast. The dough rises before baking." },
];
const QUESTION = "How does a rocket reach orbit?";

// ---- the gateway: signed answers for /v1/embeddings and /v1/chat/completions ----------------------------------------
const enc = new TextEncoder();
const receipts = new Map<string, unknown>();
const sessions = new Map<string, unknown>();
let seq = 0;
let gwRequests: string[] = [];
const embeddingAnswer = (body: Record<string, any>) => {
  const inputs: unknown[] = Array.isArray(body.input) ? body.input : [body.input];
  return enc.encode(JSON.stringify({ object: "list", data: inputs.map((s, i) => ({ object: "embedding", index: i, embedding: [String(s).length / 100, String(s).includes("rocket") ? 1 : 0, 0.5] })), model: body.model, usage: { prompt_tokens: 8, total_tokens: 8 } }));
};
const chatAnswer = (body: Record<string, any>) =>
  enc.encode(JSON.stringify({ id: "chatcmpl-gw", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Per [1]: stages." }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 } }));

let gw: ReturnType<typeof Bun.serve>;
let verifier: ReturnType<typeof Bun.serve>;
let h: Harness;
type Key = Awaited<ReturnType<Harness["fundedKey"]>>;

beforeAll(async () => {
  gw = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v1/aci/attestation") return Response.json(gatewayReport(u.searchParams.get("nonce") ?? "", {}));
      if (u.pathname === "/v1/models") return Response.json({ data: [] });
      const stored = u.pathname.startsWith("/v1/aci/receipts/") ? receipts : u.pathname.startsWith("/v1/aci/sessions/") ? sessions : null;
      if (stored) {
        const doc = stored.get(decodeURIComponent(u.pathname.split("/").pop()!));
        return doc ? Response.json(doc) : new Response("not found", { status: 404 });
      }
      const embeddings = u.pathname === "/v1/embeddings";
      if ((embeddings || u.pathname === "/v1/chat/completions") && req.method === "POST") {
        const reqBytes = new Uint8Array(await req.arrayBuffer());
        const body = JSON.parse(new TextDecoder().decode(reqBytes));
        gwRequests.push(u.pathname);
        const bytes = embeddings ? embeddingAnswer(body) : chatAnswer(body);
        const id = `rcpt-${++seq}`;
        const servedAt = Math.floor(Date.now() / 1000);
        const s = session(CLAIMS_OK, servedAt);
        sessions.set(s.id, s.doc);
        receipts.set(id, signedReceipt({ keysetDigest: keysetDigest(keyset()), receiptId: id, requestBody: reqBytes, responseBody: bytes, upstream: { result: "verified", required: true, session_id: s.id, claims: CLAIMS_OK }, servedAt, key: RECEIPT_KEY, model: body.model, endpoint: u.pathname }));
        return new Response(bytes, { headers: { "content-type": "application/json", "x-receipt-id": id } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  verifier = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => Response.json(phalaVerifierAnswer(((await req.json()) as { hex: string }).hex, true)) });
  h = await startRouter({
    providers: [
      { id: "vendor", name: "Vendor", models: [{ id: "plain", slug: PUBLIC_CHAT, prompt: "0.0000001", completion: "0.0000002" }, MODELS.embed, RERANK_PUBLIC, RERANK_SHARED] },
      { id: "enclave", name: "Enclave", models: [{ ...RERANK_SHARED, prompt: "0.0000001" }], tee: "dev" },
    ],
    env: { AGENT_POLICY_ENABLED: "true", ATTESTATION_VERIFIERS: "phala", PHALA_VERIFIER_URL: `http://127.0.0.1:${verifier.port}/verify` },
  });
  const staticModels = [...aciStaticModels(fixture("aci-models-catalogue.json"), { only: new Set([GW_CHAT]) }).models, ...aciStaticModels(fixture("aci-embeddings-catalogue.json"), { only: new Set([GW_EMBED]) }).models];
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
  for (const id of ["gw", "enclave"])
    expect((await h.request(`/api/v1/disclosure/${id}`, { method: "PUT", headers: { "x-admin-token": ADMIN }, json: { retention: { value: "attested", ...claim }, legal_hold: { active: false, ...claim } } })).status).toBe(200);
});
afterAll(async () => {
  gw?.stop(true);
  verifier?.stop(true);
  await h?.close();
});
beforeEach(async () => {
  gwRequests = [];
  await runAttestor(h.ctx);
  await h.ctx.catalog.refresh();
});

const keyWith = async (policy?: Partial<AgentPolicy>): Promise<Key> => {
  const k = await h.fundedKey(20n);
  if (policy) expect((await h.request(`/api/v1/agents/${k.hash}/policy`, { method: "PUT", headers: k.auth, json: { ...base, ...policy } })).status).toBe(200);
  return k;
};
const post = (path: string, k: Key, json: Record<string, unknown>, headers: Record<string, string> = {}) => h.request(path, { method: "POST", headers: { ...k.auth, ...headers }, json });
const embed = (k: Key, json: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post("/api/v1/embeddings", k, { model: PUBLIC_EMBED, input: ["a rocket"], ...json }, headers);
const rerank = (k: Key, json: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post("/api/v1/rerank", k, { model: RERANK_PUBLIC.slug, query: "rocket", documents: ["a rocket", "bread"], ...json }, headers);
const rag = (k: Key, json: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post("/api/v1/rag", k, { documents: DOCS, question: QUESTION, model: GW_CHAT, ...json }, headers);
const vendorCalls = () => h.mocks.vendor.stats.requests;
const label = async (id: string) => (await (await h.request(`/api/v1/receipts/${encodeURIComponent(id)}/privacy`)).json()).data;
/** The label says nothing about an enclave: the standard route. */
const expectStandardLabel = async (id: string) => {
  const l = await label(id);
  expect(l.lane).toBe("public");
  expect(l.label.hardware.attested).toBe(false);
  expect(JSON.stringify([l.summary, l.short, l.label.hardware.text])).not.toMatch(/proven enclave|provider's attested enclave|Attested hardware|Hardware: attested/);
};

describe("embeddings", () => {
  test("proven_only: a model with no attested endpoint is refused with the attested lane's refusal, and nothing reaches the vendor", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const before = vendorCalls();
    const r = await embed(k);
    expect(r.status).toBe(503);
    const e = (await r.json()).error;
    expect(e.type).toBe("no_attested_endpoint");
    expect(e.metadata).toMatchObject({ lane: "attested", reason: "none_attested" });
    expect(vendorCalls()).toBe(before);
  });

  test("proven_first: no attested endpoint, so a standard provider serves it, receipted and labelled as the standard route", async () => {
    const k = await keyWith({ route_default: "proven_first" });
    const before = vendorCalls();
    const r = await embed(k);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=public");
    expect(r.headers.get("x-anyroute-lane")).toBe("public");
    const j = await r.json();
    expect(j.receipt.payload).toMatchObject({ lane: "public", provider: "vendor" });
    expect(vendorCalls()).toBe(before + 1);
    await expectStandardLabel(j.receipt.payload.id);
  });

  test("proven_only on a model the gateway serves: lane attested, verified vectors, nothing to the vendor", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const before = vendorCalls();
    const r = await embed(k, { model: GW_EMBED });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_only; lane=attested");
    expect((await r.json()).receipt.payload).toMatchObject({ lane: "attested", provider: "gw" });
    expect(gwRequests).toEqual(["/v1/embeddings"]);
    expect(vendorCalls()).toBe(before);
  });

  test("an explicit lane always wins, and no rulebook means today's behaviour", async () => {
    const only = await keyWith({ route_default: "proven_only" });
    for (const [json, headers] of [[{ provider: { lane: "public" } }, {}], [{}, { "x-anyroute-lane": "public" }], [{ provider: { disclosure: "any" } }, {}]] as const) {
      const r = await embed(only, json, headers);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-anyroute-default-route")).toBeNull();
      expect((await r.json()).receipt.payload.lane).toBe("public");
    }
    const plain = await embed(await keyWith());
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-anyroute-default-route")).toBeNull();
    expect(plain.headers.get("x-anyroute-lane")).toBe("public");
  });
});

describe("rerank", () => {
  test("proven_only: the enclave serves a model it has; a model without one is refused, never sent to the vendor", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const r = await rerank(k, { model: RERANK_SHARED.slug });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_only; lane=attested");
    expect((await r.json()).receipt.payload).toMatchObject({ lane: "attested", provider: "enclave" });
    const before = vendorCalls();
    const refused = await rerank(k);
    expect(refused.status).toBe(503);
    expect((await refused.json()).error.type).toBe("no_attested_endpoint");
    expect(vendorCalls()).toBe(before);
  });

  test("proven_first: attested where the model has it, otherwise the standard route with a standard label", async () => {
    const k = await keyWith({ route_default: "proven_first" });
    const proven = await rerank(k, { model: RERANK_SHARED.slug });
    expect(proven.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=attested");
    expect((await proven.json()).receipt.payload).toMatchObject({ lane: "attested", provider: "enclave" });
    const fallback = await rerank(k);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=public");
    const payload = (await fallback.json()).receipt.payload;
    expect(payload).toMatchObject({ lane: "public", provider: "vendor" });
    await expectStandardLabel(payload.id);
  });

  test("an explicit lane wins, and the rulebook's allowlist is stricter than the default", async () => {
    const only = await keyWith({ route_default: "proven_only" });
    const named = await rerank(only, { model: RERANK_SHARED.slug, provider: { lane: "public", only: ["vendor"] } });
    expect(named.status).toBe(200);
    expect(named.headers.get("x-anyroute-default-route")).toBeNull();
    expect((await named.json()).receipt.payload).toMatchObject({ lane: "public", provider: "vendor" });
    const refused = await rerank(await keyWith({ route_default: "proven_only", lanes: ["public"] }), { model: RERANK_SHARED.slug });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.metadata.reasons.map((x: { code: string }) => x.code)).toContain("lane_not_allowed");
    const first = await rerank(await keyWith({ route_default: "proven_first", lanes: ["public"] }), { model: RERANK_SHARED.slug });
    expect(first.headers.get("x-anyroute-default-route")).toBe("proven_first; lane=public");
    expect((await first.json()).receipt.payload.lane).toBe("public");
  });
});

describe("POST /api/v1/rag", () => {
  test("without a default, a public embedding model embeds the chunks at the vendor (today's behaviour)", async () => {
    const before = vendorCalls();
    const r = await rag(await keyWith(), { embedding_model: PUBLIC_EMBED });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.receipts.find((x: { step: string }) => x.step === "embeddings")).toMatchObject({ provider: "vendor", lane: "public" });
    expect(vendorCalls()).toBe(before + 1);
  });

  test("proven_only keeps every chunk off a standard embedding provider: refused before anything is sent", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const before = vendorCalls();
    const r = await rag(k, { embedding_model: PUBLIC_EMBED });
    expect(r.status).toBe(503);
    const e = (await r.json()).error;
    expect(e).toMatchObject({ type: "no_attested_endpoint", metadata: { step: "embeddings", lane: "attested" } });
    expect(vendorCalls()).toBe(before);
    expect(gwRequests).toEqual([]);
    // A public chat model: the chunks are embedded on the gateway only, and the answer step is refused, never sent.
    const chat = await rag(k, { model: PUBLIC_CHAT });
    expect(chat.status).toBe(503);
    const ce = (await chat.json()).error;
    expect(ce).toMatchObject({ type: "no_attested_endpoint", metadata: { step: "chat" } });
    expect(ce.metadata.receipts.every((x: { provider: string; lane: string }) => x.provider === "gw" && x.lane === "attested")).toBe(true);
    expect(vendorCalls()).toBe(before);
  });

  test("proven_only with no models named: an attested embedding model is picked and every call is attested", async () => {
    const k = await keyWith({ route_default: "proven_only" });
    const before = vendorCalls();
    const r = await rag(k);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-anyroute-default-route")).toBe("proven_only; lane=attested");
    const j = await r.json();
    expect(j).toMatchObject({ lane: "attested", embedding_model: GW_EMBED });
    expect(j.receipts.every((x: { provider: string; lane: string }) => x.provider === "gw" && x.lane === "attested")).toBe(true);
    expect(vendorCalls()).toBe(before);
  });

  test("proven_first: a public embedding model falls back to the standard route, and its receipt and label say so", async () => {
    const k = await keyWith({ route_default: "proven_first" });
    const before = vendorCalls();
    const r = await rag(k, { embedding_model: PUBLIC_EMBED });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.lane).toBe("public"); // the request as a whole is never presented as proven
    const embedding = j.receipts.find((x: { step: string }) => x.step === "embeddings");
    expect(embedding).toMatchObject({ provider: "vendor", lane: "public" });
    expect(embedding.disclosure).not.toBe("attested");
    await expectStandardLabel(embedding.receipt_id);
    // Each call follows the default for its own model: the answer step's model has an attested endpoint.
    expect(j.receipts.find((x: { step: string }) => x.step === "chat")).toMatchObject({ provider: "gw", lane: "attested" });
    expect(vendorCalls()).toBe(before + 1);
  });

  test("an explicit lane always wins over the default, and the allowlist stays stricter", async () => {
    const only = await keyWith({ route_default: "proven_only" });
    const before = vendorCalls();
    const named = await rag(only, { embedding_model: PUBLIC_EMBED, provider: { lane: "public" } });
    expect(named.status).toBe(200);
    expect(named.headers.get("x-anyroute-default-route")).toBeNull();
    const j = await named.json();
    expect(j).toMatchObject({ lane: "public", lane_source: "request" });
    expect(j.receipts.every((x: { lane: string }) => x.lane === "public")).toBe(true);
    expect(vendorCalls()).toBe(before + 1);
    const refused = await rag(await keyWith({ route_default: "proven_only", lanes: ["public"] }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatchObject({ type: "agent_policy_denied", metadata: { step: "embeddings" } });
    expect(vendorCalls()).toBe(before + 1);
  });
});
