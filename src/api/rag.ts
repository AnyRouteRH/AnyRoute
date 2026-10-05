import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ModelRow } from "../catalog/catalog.ts";
import type { Ctx } from "../context.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { resolveDisclosureRequest } from "../router/disclosure.ts";
import { applyRagRouteDefault } from "../routing/route-default.ts"; // U101
import { buildMessages, chunkText, cosineScores, topK, type PromptSource } from "../rag/text.ts";
import { requireKey } from "./auth.ts";
import { generationHeaders, readJson, sharedPolicyHash } from "./common.ts";
import { modelJson } from "./models.ts";

// POST /api/v1/rag (alias /v1/rag): retrieval-augmented answers over documents sent with the question, and kept nowhere.
//
// The endpoint is an adapter over the router's own routes. It cuts the documents into chunks, embeds the chunks and the
// question through POST /api/v1/embeddings, ranks the chunks against the question by cosine similarity in memory, and
// answers from the best ones through POST /api/v1/chat/completions. Each of those calls is an ordinary call of the caller's
// key: billed, limited, routed by lane, and receipted exactly as if the caller had made it. The response lists every
// receipt.
//
// What is kept: nothing of the documents, the question or the answer. The chunks and their vectors live in this request's
// memory and are dropped when it ends; this endpoint itself writes nothing to the database, the cache or a log. The calls it
// makes leave the records every call leaves: a generation row and a signed receipt with ids, model, provider, token counts, cost, timing
// and the SHA-256 of the request and of the response, never their text. The response cache is never used: this endpoint
// sends neither `cache` nor X-Anyroute-Cache.
//
// Lane: a caller who states a lane or a disclosure ceiling (provider.lane, provider.disclosure, X-Anyroute-Lane,
// X-Anyroute-Disclosure-Max) gets exactly that on every call and is refused, never downgraded. A caller who states none gets
// the attested lane when the chat model and the embedding model are both served by an endpoint the router holds attested,
// and the router's ordinary (public) lane otherwise; the response says which, and why.

const PREFERRED_EMBEDDING = "qwen/qwen3-embedding-8b";
const MAX_TOP_K = 20;
const EMBED_BATCH_ITEMS = 64; // inputs per embeddings call, before the model's context narrows it
const EMBED_PARALLEL = 4; // embeddings calls in flight at once
const PROMPT_OVERHEAD_CHARS = 1200; // the grounding instructions, the question's frame and the per-source tags, generously

const LANES = ["public", "attested"] as const;
const DISCLOSURES = ["none", "policy", "any"] as const;
const CLASS_RANK: Record<string, number> = { attested: 2, policy: 1, "vendor-forwarded": 0 };

const documentSchema = z.union([z.string(), z.object({ id: z.string().min(1).max(200).optional(), text: z.string() }).strict()]);
const requestSchema = z
  .object({
    documents: z.array(documentSchema).min(1),
    question: z.string().trim().min(1).max(8000),
    model: z.string().min(1).max(200),
    embedding_model: z.string().min(1).max(200).optional(),
    top_k: z.number().int().min(1).max(MAX_TOP_K).default(4),
    chunk: z.object({ size: z.number().int().min(100).max(8000).optional(), overlap: z.number().int().min(0).optional() }).strict().optional(),
    max_tokens: z.number().int().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean().default(false),
    include_excerpts: z.boolean().default(false),
    provider: z.object({ lane: z.string().optional(), disclosure: z.string().optional() }).strict().optional(),
  })
  .strict();

type Json = Record<string, any>;

/** One provider call the request made, as its signed receipt records it. */
type Call = {
  step: "embeddings" | "chat";
  receipt_id: string;
  model: string | null;
  provider: string | null;
  lane: string | null;
  disclosure: string | null;
  cost: number;
  tokens: { prompt: number; completion: number };
  inputs?: number;
  policy_hash?: string | null;
  attestation_simulated?: true;
  upstream_attestation?: { attested: boolean; gpu_attested: boolean; receipt_verified: boolean; kind: unknown; receipt_id: unknown; reason?: string };
  /** The provider had already answered when the router withheld the reply (billed; the signed receipt says why). */
  withheld?: true;
  cost_pico: bigint;
};

/** What the router knows about a model: whether it embeds, the context it accepts, and how many live endpoints serve it under each class. */
export type Avail = { id: string; embedding: boolean; chat: boolean; ctxMin: number; ctxMax: number; attested: number; policy: number; total: number; price: bigint };

function availability(ctx: Ctx, m: ModelRow): Avail {
  const j = modelJson(ctx, m);
  const out = (j.architecture as { output_modalities?: unknown }).output_modalities;
  const modalities = Array.isArray(out) ? out.map(String) : ["text"];
  const live = ctx.catalog.offers(m.id).filter((o) => o.status === "live" && o.provider.status === "live");
  const ctxs = live.map((o) => o.ctx ?? m.ctx);
  const e = j.disclosure.endpoints;
  let price = 0n;
  try {
    price = usdToPico(j.pricing.prompt);
  } catch {}
  return {
    id: m.id,
    embedding: modalities.includes("embeddings"),
    chat: modalities.includes("text"),
    ctxMin: ctxs.length ? Math.min(...ctxs) : m.ctx,
    ctxMax: ctxs.length ? Math.max(...ctxs) : m.ctx,
    attested: e.attested,
    policy: e.policy,
    total: e.attested + e.policy + e["vendor-forwarded"],
    price,
  };
}

const cheapestFirst = (a: Avail, b: Avail) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.id.localeCompare(b.id));

/**
 * The embedding model used when the caller names none, from the models `pool` allows: qwen/qwen3-embedding-8b if it is there,
 * else the cheapest. With `preferAttested`, models that have an attested endpoint are considered first.
 */
export function pickEmbedding(pool: Avail[], preferAttested: boolean): Avail | null {
  const usable = pool.filter((a) => a.embedding && a.total > 0);
  const attested = usable.filter((a) => a.attested > 0);
  const from = preferAttested && attested.length ? attested : usable;
  return from.find((a) => a.id === PREFERRED_EMBEDDING) ?? [...from].sort(cheapestFirst)[0] ?? null;
}

/** How the calls are grouped: at most EMBED_BATCH_ITEMS texts and, under the router's chars/3 token estimate, at most what the model's context takes. */
export function planBatches(inputs: string[], contextTokens: number): number[][] {
  const budget = Math.max(1, 3 * (contextTokens - 8));
  const batches: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  inputs.forEach((s, i) => {
    if (cur.length && (cur.length >= EMBED_BATCH_ITEMS || chars + s.length > budget)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += s.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

const summarize = (ua: Json) => ({
  attested: ua.attested === true,
  gpu_attested: ua.gpu_attested === true,
  receipt_verified: ua.receipt_verified === true,
  kind: ua.kind ?? null,
  receipt_id: ua.receipt_id ?? null,
  ...(typeof ua.reason === "string" ? { reason: ua.reason } : {}),
});

/** A call as its signed receipt records it. `headers` are the response headers of the route that made it. */
function callOf(step: Call["step"], id: string, payload: Json | undefined, headers: Headers | null, extra: Partial<Call> = {}): Call {
  const p = payload ?? {};
  let pico = 0n;
  try {
    pico = usdToPico(String(p.cost ?? "0"));
  } catch {}
  const ua = p.upstream_attestation;
  return {
    step,
    receipt_id: id,
    model: typeof p.model === "string" ? p.model : null,
    provider: typeof p.provider === "string" ? p.provider : null,
    lane: typeof p.lane === "string" ? p.lane : (headers?.get("x-anyroute-lane") ?? null),
    disclosure: typeof p.disclosure === "string" ? p.disclosure : (headers?.get("x-anyroute-disclosure") ?? null),
    cost: picoToUsd(pico),
    tokens: { prompt: Number(p.tokens?.prompt ?? 0), completion: Number(p.tokens?.completion ?? 0) },
    ...(headers?.get("x-anyroute-policy-hash") ? { policy_hash: headers.get("x-anyroute-policy-hash") } : {}),
    ...(p.attestation_simulated === true ? { attestation_simulated: true as const } : {}),
    ...(ua && typeof ua === "object" ? { upstream_attestation: summarize(ua) } : {}),
    ...extra,
    cost_pico: pico,
  };
}

/** The receipts as sent to the caller (without the exact-cost helper). */
const publicCall = ({ cost_pico: _p, ...call }: Call) => call;

/** The call a refused request had already made and been billed for (an attested answer the router withheld), or null. */
function billedCall(step: Call["step"], body: Json | null, headers: Headers): Call | null {
  return typeof body?.id === "string" && body.receipt?.payload ? callOf(step, body.id, body.receipt.payload, headers, { withheld: true }) : null;
}

/** A step the router refused: its error, said plainly, with the receipts of every call already made (and billed). */
function refusal(step: Call["step"], status: number, body: Json | null, headers: Headers, calls: Call[]): ApiError {
  const err = (body?.error ?? {}) as { message?: string; type?: string; metadata?: Record<string, unknown> };
  const retry = headers.get("retry-after");
  return new ApiError(
    status,
    `RAG stopped at the ${step} step: ${err.message ?? `the router answered ${status}.`}`,
    err.type ?? "upstream_error",
    { ...err.metadata, step, receipts: calls.map(publicCall) },
    retry ? { "retry-after": retry } : undefined,
  );
}

/** The weakest of a set of disclosure classes, or null when any is unknown. */
function weakest(classes: (string | null | undefined)[]): string | null {
  if (!classes.length || classes.some((x) => !x || !Object.hasOwn(CLASS_RANK, x))) return null;
  return (classes as string[]).reduce((w, x) => (CLASS_RANK[x]! < CLASS_RANK[w]! ? x : w));
}

function fetchVectors(body: Json | null, expected: number): Float32Array[] | null {
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== expected) return null;
  const ordered = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  const out: Float32Array[] = [];
  for (const d of ordered) {
    const v = d?.embedding;
    if (!Array.isArray(v) || !v.length) return null;
    const f = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (typeof x !== "number" || !Number.isFinite(x)) return null;
      f[i] = x;
    }
    out.push(f);
  }
  return out;
}

export function ragRoutes(app: Hono, ctx: Ctx) {
  const handler = async (c: Context) => {
    c.header("cache-control", "no-store");
    // Who is asking, before anything is read: an unknown key never gets its body parsed or chunked.
    const key = await requireKey(ctx, c.req.header("authorization"));
    const limits = ctx.cfg.rag;

    const raw = await readJson(c);
    if (Array.isArray(raw.documents) && raw.documents.length > limits.maxDocuments)
      fail(413, `A request may carry at most ${limits.maxDocuments} documents.`, "payload_too_large", { limit: limits.maxDocuments, documents: raw.documents.length });
    const req = requestSchema.parse(raw);

    // ---- documents: ids, sizes, caps ---------------------------------------------------------
    const docs = req.documents.map((d, i) => {
      const text = typeof d === "string" ? d : d.text;
      const id = typeof d === "string" ? undefined : d.id;
      return { id: id ?? `doc-${i + 1}`, text };
    });
    const seen = new Set<string>();
    let bytes = 0;
    docs.forEach((d, i) => {
      if (!d.text.trim()) fail(400, `documents[${i}] has no text.`, "invalid_request");
      if (seen.has(d.id)) fail(400, `documents[${i}] repeats the id ${JSON.stringify(d.id.slice(0, 80))}: document ids must be unique.`, "invalid_request");
      seen.add(d.id);
      bytes += Buffer.byteLength(d.text, "utf8");
      if (bytes > limits.maxBytes) fail(413, `A request may carry at most ${limits.maxBytes} bytes of document text.`, "payload_too_large", { limit: limits.maxBytes });
    });

    // ---- chunking ------------------------------------------------------------------------------
    const size = req.chunk?.size ?? 1000;
    const overlap = req.chunk?.overlap ?? Math.round(size * 0.15);
    if (overlap > Math.floor(size / 2)) fail(400, "`chunk.overlap` may be at most half of `chunk.size`.", "invalid_request");
    const chunks: { doc: number; index: number; start: number; end: number; text: string }[] = [];
    docs.forEach((d, di) => {
      chunkText(d.text, size, overlap).forEach((p, index) => {
        chunks.push({ doc: di, index, ...p });
      });
    });
    if (!chunks.length) fail(400, "The documents have no text to search.", "invalid_request");
    if (chunks.length > limits.maxChunks) fail(413, `The documents make ${chunks.length} chunks, and a request may embed at most ${limits.maxChunks}. Send fewer documents or a larger chunk.size.`, "payload_too_large", { limit: limits.maxChunks, chunks: chunks.length });

    // ---- the lane the caller asked for -----------------------------------------------------
    await applyRagRouteDefault(ctx, c, req, key); // U101: the key's default privacy route, only when the request names no lane
    // The request's own setting, else the one pinned on the key (routing.provider, which chat applies and embeddings would not).
    const pinned = ((key.routing as { provider?: Record<string, unknown> } | null)?.provider ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined);
    const asked = { lane: text(req.provider?.lane) ?? text(pinned.lane), disclosure: text(req.provider?.disclosure) ?? text(pinned.disclosure) };
    const laneHeader = text(c.req.header("x-anyroute-lane"));
    const ceilingHeader = text(c.req.header("x-anyroute-disclosure-max"));
    const laneFrom = req.provider?.lane !== undefined ? "provider.lane" : "the lane in this key's routing preset";
    for (const [what, v] of [[laneFrom, asked.lane], ["X-Anyroute-Lane", laneHeader]] as const)
      if (v !== undefined && !(LANES as readonly string[]).includes(v))
        fail(400, `${what} must be one of: ${LANES.join(", ")}.${v === "unlinkable" ? " The unlinkable lane needs a relay and a blind token, which this endpoint cannot use." : ""} Nothing was sent.`, "invalid_request");
    if (asked.disclosure !== undefined && !(DISCLOSURES as readonly string[]).includes(asked.disclosure)) fail(400, `The disclosure ceiling must be one of: ${DISCLOSURES.join(", ")}. Nothing was sent.`, "invalid_request");
    const disc = resolveDisclosureRequest(asked, { disclosureMax: ceilingHeader, lane: laneHeader });
    const restricted = disc.lane !== "public" || disc.max !== "any";
    // Anything stated, even public or any, is kept as stated: only a request that states nothing gets a default.
    const stated = asked.lane !== undefined || asked.disclosure !== undefined || laneHeader !== undefined || ceilingHeader !== undefined;
    const wanted = disc.lane !== "public" ? `lane "${disc.lane}"` : `provider.disclosure "${disc.max}"`;
    const meets = (a: Avail) => (disc.max === "none" ? a.attested > 0 : disc.max === "policy" ? a.attested + a.policy > 0 : a.total > 0);

    // ---- the models -----------------------------------------------------------------------------
    await ctx.catalog.ensureFresh();
    const named = (id: string) => ctx.catalog.resolve(id);
    const allowed = key.allowedModels ?? [];
    const guardAllowed = (m: ModelRow | undefined) => {
      if (m && allowed.length && !allowed.includes(m.id)) fail(403, `This key may not use ${m.id}.`, "model_not_allowed");
    };
    const chatRes = named(req.model);
    // An alias of the key, a saved route, a preset or a router model are resolved by the chat route itself.
    const routed = req.model.startsWith("@route/") || req.model.startsWith("@preset/") || req.model.startsWith("anyroute/") || !!(key.routing as { aliases?: Record<string, unknown> } | null)?.aliases?.[req.model];
    if (!chatRes && !routed) fail(404, `Model ${req.model} is not available. See GET /api/v1/models.`, "model_not_found");
    if (!chatRes && !stated)
      fail(400, `${req.model} is resolved by the router (a saved route, a preset, an alias of this key or a router model), and it can pin a lane of its own, so the lane for the embeddings step cannot be chosen for you. Set provider.lane to "attested" or "public". Nothing was sent.`, "lane_required");
    guardAllowed(chatRes?.model);
    const chat = chatRes ? availability(ctx, chatRes.model) : null;
    if (chat && chat.embedding && !chat.chat) fail(400, `${chat.id} is an embedding model. \`model\` must be a chat model; name the embedding model in \`embedding_model\`.`, "invalid_request");

    let embed: Avail | null;
    if (req.embedding_model !== undefined) {
      const r = named(req.embedding_model);
      if (!r) fail(404, `Embedding model ${req.embedding_model} is not available. See GET /api/v1/models.`, "model_not_found");
      guardAllowed(r.model);
      embed = availability(ctx, r.model);
      if (!embed.embedding) fail(400, `${embed.id} is not an embedding model.`, "invalid_request");
    } else {
      const embeds = (m: ModelRow) => Array.isArray((m.arch as { output_modalities?: unknown } | null)?.output_modalities) && ((m.arch as { output_modalities: unknown[] }).output_modalities).includes("embeddings");
      const catalog = [...ctx.catalog.models.values()].filter((m) => !m.hidden && embeds(m)).map((m) => availability(ctx, m));
      embed = pickEmbedding(restricted ? catalog.filter(meets) : catalog, !restricted);
      if (!embed) {
        if (disc.lane !== "public")
          fail(503, `No embedding model has an endpoint with a fresh, verified attestation, so ${wanted} cannot be served. Nothing was sent to any provider and nothing was charged. Name an embedding_model, or see GET /api/v1/models?lane=attested.`, "no_attested_endpoint", { lane: disc.lane, reason: "none_attested", requested: { disclosure: disc.max, lane: disc.lane }, step: "embeddings" });
        if (restricted) fail(409, `No embedding model has an endpoint that meets ${wanted}. Nothing was sent to any provider and nothing was charged. Name an embedding_model, relax the option, or see GET /api/v1/models?lane=attested.`, "disclosure_unavailable", { requested: { disclosure: disc.max, lane: disc.lane }, step: "embeddings" });
        fail(404, "No embedding model is available. Name one in `embedding_model`.", "model_not_found");
      }
    }

    // The lane: the caller's, exactly, or attested when every model this request uses has an attested endpoint.
    let lane: string;
    let laneNote: string | undefined;
    let provider: { lane?: string; disclosure?: string } | undefined;
    if (stated) {
      lane = disc.lane;
      provider = { ...(asked.lane !== undefined ? { lane: asked.lane } : {}), ...(asked.disclosure !== undefined ? { disclosure: asked.disclosure } : {}) };
      if (!Object.keys(provider).length) provider = undefined;
    } else if (chat && chat.attested > 0 && embed.attested > 0) {
      lane = "attested";
      provider = { lane: "attested" };
    } else {
      lane = "public";
      const missing = [!chat ? `${req.model} (resolved by the router when it answers)` : chat.attested === 0 ? chat.id : null, embed.attested === 0 ? embed.id : null].filter(Boolean);
      laneNote = `Not defaulted to the attested lane: no attested endpoint is known for ${missing.join(" and ")}. Set provider.lane to "attested" to be refused instead of served.`;
    }

    // ---- what the chat prompt can hold, before anything is sent --------------------------------
    const longest = chunks.map((k) => k.text.length).sort((a, b) => b - a).slice(0, req.top_k);
    const worstPrompt = Math.ceil((longest.reduce((n, x) => n + x, 0) + req.question.length + PROMPT_OVERHEAD_CHARS + 120 * longest.length) / 3) + 8;
    if (chat && worstPrompt > chat.ctxMax)
      fail(400, `${req.top_k} chunks of up to ${size} characters can make a prompt of about ${worstPrompt} tokens, and ${chat.id} takes ${chat.ctxMax}. Lower top_k or chunk.size, or use a model with a longer context. Nothing was sent.`, "context_too_small", { estimated_tokens: worstPrompt, context_length: chat.ctxMax });

    // ---- the plan: [question, ...chunks] in as few embeddings calls as the model's context allows
    const inputs = [req.question, ...chunks.map((k) => k.text)];
    const batches = planBatches(inputs, embed.ctxMin);
    if (batches.length > limits.maxEmbeddingCalls)
      fail(413, `These chunks need ${batches.length} embeddings calls with ${embed.id} (its context is ${embed.ctxMin} tokens), and a request may make at most ${limits.maxEmbeddingCalls}. Send fewer documents, or use an embedding model with a longer context.`, "payload_too_large", { limit: limits.maxEmbeddingCalls, calls: batches.length });

    // ---- calling the router's own routes, as the caller ----------------------------------------
    const forward = new Headers({ "content-type": "application/json", authorization: c.req.header("authorization")! });
    for (const h of ["x-pay-with", "x-anyroute-lane", "x-anyroute-disclosure-max"]) {
      const v = c.req.header(h);
      if (v) forward.set(h, v);
    }
    const post = (path: string, body: Json) => app.request(path, { method: "POST", headers: forward, body: JSON.stringify(body), signal: c.req.raw.signal });
    const readBody = (res: Response) => res.json().catch(() => null) as Promise<Json | null>;

    const calls: Call[] = [];
    const vectors: Float32Array[] = new Array(inputs.length);
    type Done = { ok: true; call: Call; batch: number[]; vecs: Float32Array[] } | { ok: false; status: number; body: Json | null; headers: Headers; call: Call | null };
    const embedOne = async (batch: number[]): Promise<Done> => {
      const res = await post("/api/v1/embeddings", { model: embed!.id, input: batch.map((i) => inputs[i]), encoding_format: "float", ...(provider ? { provider } : {}) });
      const body = await readBody(res);
      if (!res.ok) return { ok: false, status: res.status, body, headers: res.headers, call: billedCall("embeddings", body, res.headers) };
      const call = callOf("embeddings", String(body?.id ?? res.headers.get("x-receipt-id") ?? ""), body?.receipt?.payload, res.headers, { inputs: batch.length });
      const vecs = fetchVectors(body, batch.length);
      if (!vecs) return { ok: false, status: 502, body: { error: { message: "The embedding response was not a list of vectors, one per input.", type: "invalid_embedding_response" } }, headers: res.headers, call };
      return { ok: true, call, batch, vecs };
    };
    for (let w = 0; w < batches.length; w += EMBED_PARALLEL) {
      const wave = await Promise.all(batches.slice(w, w + EMBED_PARALLEL).map(embedOne));
      for (const r of wave) if (r.call) calls.push(r.call);
      const failed = wave.find((r) => !r.ok);
      if (failed && !failed.ok) throw refusal("embeddings", failed.status, failed.body, failed.headers, calls);
      for (const r of wave) if (r.ok) r.batch.forEach((inputIndex, j) => (vectors[inputIndex] = r.vecs[j]!));
    }
    const dims = vectors[0]!.length;
    if (vectors.some((v) => v.length !== dims)) throw new ApiError(502, "RAG stopped at the embeddings step: the embedding model returned vectors of different sizes.", "invalid_embedding_response", { step: "embeddings", receipts: calls.map(publicCall) });

    // ---- ranking, in memory ----------------------------------------------------------------------
    const scores = cosineScores(vectors[0]!, vectors.slice(1));
    const best = topK(scores, req.top_k);
    const picked = best.map((b, n) => ({ ref: n + 1, chunk: chunks[b.index]!, score: b.score }));
    const sources = picked.map((s) => ({
      ref: s.ref,
      document_id: docs[s.chunk.doc]!.id,
      chunk_index: s.chunk.index,
      score: Math.round(s.score * 1e6) / 1e6,
      start: s.chunk.start,
      end: s.chunk.end,
      ...(req.include_excerpts ? { excerpt: s.chunk.text } : {}),
    }));
    const promptSources: PromptSource[] = picked.map((s) => ({ ref: s.ref, document: docs[s.chunk.doc]!.id, part: s.chunk.index + 1, text: s.chunk.text }));

    // ---- the answer ---------------------------------------------------------------------------------
    const chatRes2 = await post("/api/v1/chat/completions", {
      model: req.model,
      messages: buildMessages(req.question, promptSources),
      stream: req.stream,
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(provider ? { provider } : {}),
    });
    const retrieval = { documents: docs.length, chunks: chunks.length, top_k: picked.length, chunk: { size, overlap }, embedding_calls: batches.length };
    const common = () => ({ embedding_model: embed!.id, lane, lane_source: stated ? "request" : "default", ...(laneNote ? { lane_note: laneNote } : {}), retrieval });
    const totals = (all: Call[]) => {
      const pico = all.reduce((n, x) => n + x.cost_pico, 0n);
      return {
        disclosure: weakest(all.map((x) => x.disclosure)),
        ...(all.some((x) => x.attestation_simulated) ? { attestation_simulated: true } : {}),
        usage: {
          embedding_tokens: all.filter((x) => x.step === "embeddings").reduce((n, x) => n + x.tokens.prompt, 0),
          prompt_tokens: all.filter((x) => x.step === "chat").reduce((n, x) => n + x.tokens.prompt, 0),
          completion_tokens: all.reduce((n, x) => n + x.tokens.completion, 0),
          cost: picoToUsd(pico),
          cost_usd: picoToUsdString(pico),
        },
      };
    };
    /** Receipt, lane, policy and disclosure headers for a response that stands for several calls: the chat call's receipt,
     * and a policy hash or disclosure class only when it holds for every call. */
    const headersFor = (chatId: string, chatPolicy: string | null, chatDisclosure: string | null): Record<string, string> => {
      const headers = generationHeaders(chatId, lane, sharedPolicyHash([...calls.map((x) => x.policy_hash), chatPolicy]));
      const w = weakest([...calls.map((x) => x.disclosure), chatDisclosure]);
      if (w) headers["x-anyroute-disclosure"] = w;
      return headers;
    };

    if (!chatRes2.ok) {
      const failedBody = await readBody(chatRes2);
      const billed = billedCall("chat", failedBody, chatRes2.headers);
      throw refusal("chat", chatRes2.status, failedBody, chatRes2.headers, billed ? [...calls, billed] : calls);
    }

    if (!req.stream) {
      const out = await readBody(chatRes2);
      const chatId = String(out?.id ?? chatRes2.headers.get("x-receipt-id") ?? "");
      const chatCall = callOf("chat", chatId, out?.receipt?.payload, chatRes2.headers);
      const all = [...calls, chatCall];
      const content = out?.choices?.[0]?.message?.content;
      return c.json(
        {
          id: chatId,
          object: "rag.answer",
          model: chatCall.model ?? req.model,
          answer: typeof content === "string" ? content : "",
          finish_reason: out?.choices?.[0]?.finish_reason ?? null,
          sources,
          receipts: all.map(publicCall),
          ...common(),
          ...totals(all),
        },
        200,
        headersFor(chatId, chatCall.policy_hash ?? null, chatCall.disclosure),
      );
    }

    // ---- streaming: sources first, then the chat stream as the router sends it, then the receipts -----------
    const chatId = chatRes2.headers.get("x-receipt-id") ?? "";
    const created = Math.floor(Date.now() / 1000);
    const frame = (extra: Json) => `data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: req.model, choices: [], rag: extra })}\n\n`;
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } | undefined;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string) => {
          if (!closed) controller.enqueue(enc.encode(s));
        };
        send(frame({ object: "rag.sources", sources, receipts: calls.map(publicCall), ...common() }));
        let receipt: Json | null = null;
        let failure: Json | null = null;
        let served: string | null = null;
        const take = (block: string) => {
          if (!block.trim()) return;
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (data === "[DONE]") return;
          if (data) {
            try {
              const ev = JSON.parse(data) as Json;
              if (ev.receipt) receipt = ev.receipt;
              if (ev.error && !failure) failure = ev.error;
              if (typeof ev.model === "string") served = ev.model;
            } catch {}
          }
          send(block + "\n\n");
        };
        try {
          reader = chatRes2.body!.getReader();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buffer.indexOf("\n\n")) >= 0) {
              take(buffer.slice(0, i));
              buffer = buffer.slice(i + 2);
            }
          }
          take(buffer);
        } catch {
          /* the caller went away, or the chat stream broke: the summary below still lists what was billed */
        }
        const refused = (failure as Json | null)?.type === "upstream_not_attested";
        const chatCall = callOf("chat", chatId, (receipt as Json | null)?.payload, chatRes2.headers, refused ? { withheld: true } : {});
        const all = [...calls, chatCall];
        send(frame({ object: "rag.summary", model: served ?? chatCall.model ?? req.model, receipts: all.map(publicCall), ...(failure ? { error: { type: (failure as Json).type ?? null, message: (failure as Json).message ?? null } } : {}), ...common(), ...totals(all) }));
        send("data: [DONE]\n\n");
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      },
      cancel(reason) {
        closed = true;
        void reader?.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...headersFor(chatId, chatRes2.headers.get("x-anyroute-policy-hash"), chatRes2.headers.get("x-anyroute-disclosure")),
      },
    });
  };
  app.post("/api/v1/rag", handler);
  app.post("/v1/rag", handler);
}
