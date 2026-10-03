import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import { ONION_HEADER } from "../lib/onion.ts";
import { clientIp, EXPOSED_RESPONSE_HEADERS, readJson } from "../api/common.ts";
import { modelJson, servable } from "../api/models.ts";
import { parseLane } from "../router/disclosure.ts";
import { unlinkableServed } from "../onion/lane.ts";
import { estimatePromptTokens } from "../router/pricing.ts";
import { fromChat, fromEmbed, fromGenerate, loadReply, OLLAMA_VERSION, ollamaName, routerName, showEntry, tagEntry, toReply, type Converted, type ModelInfo } from "./convert.ts";
import { streamNdjson } from "./stream.ts";

// The Ollama API under /ollama, so an Ollama client (Open WebUI, Continue, the ollama libraries, LangChain's ChatOllama,
// editor and notes plugins) can use AnyRoute models with OLLAMA_HOST (or its base URL setting) pointed at
// https://<router>/ollama. Like src/api/anthropic.ts and src/api/responses.ts it is an adapter: a call is converted and
// sent through the router's own /api/v1/chat/completions or /api/v1/embeddings in-process, with the caller's credentials
// and routing headers, so keys, balances, limits, lanes, disclosure ceilings and signed receipts are exactly those of a
// chat call, and the receipt, lane and policy headers ride on the reply. Nothing is decided here.
//
// The key is sent as Authorization: Bearer (the API key field of an Ollama client). Model names are catalog ids with
// Ollama's ":latest" tag; a routing suffix (":free", ":nitro", ":private") works as a tag too.

const BASE = "/ollama";
const CHAT = "/api/v1/chat/completions";
const EMBEDDINGS = "/api/v1/embeddings";

/** How long a stream is held back to see whether the router refuses the request (see ollama/stream.ts). */
const PEEK_MS = 4_000;

/** Request headers the chat route reads: credentials, payment, routing (lane, disclosure) and tracing. */
const FORWARD = ["authorization", "x-pay-with", "x-payment", "payment-signature", "x-wallet-auth", "x-anyroute-lane", "x-anyroute-lane-downgrade", "x-anyroute-disclosure-max", "x-anyroute-cache", "http-referer", "x-title", "traceparent", ONION_HEADER];
/** Response headers passed on: the receipt, lane and policy headers, the payment headers and what a client needs to retry. */
const PASS = [...EXPOSED_RESPONSE_HEADERS, "www-authenticate"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const passHeaders = (res: Response) => Object.fromEntries(PASS.flatMap((h) => (res.headers.get(h) !== null ? [[h, res.headers.get(h)!]] : [])));

/** Ollama's error shape: {"error": "..."} with the HTTP status. */
const refusal = (c: Context, status: number, message: string, headers: Record<string, string> = {}) => c.json({ error: message }, status as never, headers);

function thrown(c: Context, e: unknown) {
  if (e instanceof ApiError) return refusal(c, e.status, e.message, e.headers ?? {});
  if (e instanceof ZodError) return refusal(c, 400, "Invalid request: " + e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  if ((e as Error)?.name === "AbortError") return refusal(c, 499, "Client closed the request.");
  log.error("ollama request failed", { error: (e as Error)?.message });
  return refusal(c, 500, "Internal router error.");
}

/** What a reply says about the call beyond the answer: the receipt, the lane it was served under and what it cost. */
function anyrouteInfo(o: { receipt: Json | null; provider: string | null; costUsd: number | null; headers: Headers }): Json {
  const payload = isObj(o.receipt?.payload) ? (o.receipt!.payload as Json) : {};
  const policy = o.headers.get("x-anyroute-policy-hash");
  return {
    receipt_id: (typeof o.receipt?.id === "string" ? o.receipt.id : null) ?? o.headers.get("x-receipt-id"),
    lane: o.headers.get("x-anyroute-lane") ?? (typeof payload.lane === "string" ? payload.lane : null),
    disclosure: o.headers.get("x-anyroute-disclosure") ?? (typeof payload.disclosure === "string" ? payload.disclosure : null),
    ...(policy ? { policy_hash: policy } : {}),
    provider: o.provider,
    cost_usd: o.costUsd,
  };
}

export function ollamaRoutes(app: Hono, ctx: Ctx) {
  const example = () => ollamaName(ctx.catalog.models.keys().next().value ?? "<author>/<model>");
  const notFound = (name: string) => `model "${name}" not found. Anyroute serves the models listed at GET /ollama/api/tags, for example "${example()}".`;

  /** The chat or embeddings call, in-process, with the caller's credentials and routing headers. */
  const inner = (c: Context, path: string, body: Json) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const name of FORWARD) {
      const v = c.req.header(name);
      if (v !== undefined) headers[name] = v;
    }
    // The inner request has no socket of its own: hand it the caller's address so per-address limits count the caller.
    const from = clientIp(c, ctx.cfg.trustProxy);
    return app.request(path, { method: "POST", headers, body: JSON.stringify(body), signal: c.req.raw.signal }, { requestIP: () => ({ address: from }) });
  };

  /** The router's refusal, in Ollama's shape, with its headers. */
  const fromRouter = async (c: Context, res: Response, requested: string, extra: Record<string, string>) => {
    const body = (await res.json().catch(() => null)) as { error?: { message?: unknown; type?: unknown } } | null;
    const err = isObj(body?.error) ? body!.error : {};
    let message = typeof err.message === "string" ? err.message : `The router answered ${res.status}.`;
    if (res.status === 404 && err.type === "model_not_found") message = notFound(requested);
    else if ((res.status === 401 || res.status === 402) && !c.req.header("authorization")) message = `Send your Anyroute key as Authorization: Bearer sk-ar-v1-... (the API key setting of your Ollama client). ${message}`;
    return refusal(c, res.status, message, { ...passHeaders(res), ...extra });
  };

  /** A model the catalog lists, in the shape GET /api/v1/models gives it; null when the name does not resolve. */
  const described = async (name: string): Promise<ModelInfo | null> => {
    await ctx.catalog.ensureFresh();
    const row = ctx.catalog.resolve(routerName(name))?.model;
    if (!row || row.hidden) return null;
    return modelJson(ctx, row) as ModelInfo;
  };

  const generation = (kind: "chat" | "generate") => async (c: Context) => {
    const t0 = performance.now();
    try {
      const raw = await readJson(c);
      const conv: Converted = kind === "chat" ? fromChat(raw) : fromGenerate(raw);
      const requested = (raw.model as string).trim();
      const extra: Record<string, string> = conv.ignored.length ? { "x-anyroute-ignored": conv.ignored.join(", ") } : {};
      if (conv.load) {
        // Nothing to answer: Ollama loads the model and says it is ready. Here that only needs the name to resolve.
        if (!(await described(requested))) return refusal(c, 404, notFound(requested));
        return c.json(loadReply(kind, requested, conv.load), 200, extra);
      }
      const body: Json = { ...conv.body, model: routerName(requested), ...(conv.stream ? { stream: true } : {}) };
      const promptEstimate = estimatePromptTokens(body);
      const res = await inner(c, CHAT, body);
      if (!res.ok) return await fromRouter(c, res, requested, extra);
      if (conv.stream) {
        return await streamNdjson(res, {
          kind,
          model: requested,
          think: conv.think,
          t0,
          promptEstimate,
          peekMs: PEEK_MS,
          headers: { ...passHeaders(res), ...extra },
          describe: (s, h) => anyrouteInfo({ receipt: s.receipt, provider: s.provider, costUsd: typeof (s.receipt?.payload as Json | undefined)?.cost === "string" ? Number((s.receipt!.payload as Json).cost) : null, headers: h }),
          refuse: (status, message) => refusal(c, status, message, { ...passHeaders(res), ...extra }),
        });
      }
      const oa = (await res.json()) as Json;
      const usage = isObj(oa.usage) ? oa.usage : {};
      const info = anyrouteInfo({ receipt: isObj(oa.receipt) ? oa.receipt : null, provider: typeof oa.provider === "string" ? oa.provider : null, costUsd: typeof usage.cost === "number" ? usage.cost : null, headers: res.headers });
      return c.json(toReply(oa, { kind, model: requested, think: conv.think, timing: { t0, firstAt: null, endAt: performance.now() }, promptEstimate, anyroute: info }), 200, { ...passHeaders(res), ...extra });
    } catch (e) {
      return thrown(c, e);
    }
  };

  const embed = (legacy: boolean) => async (c: Context) => {
    const t0 = performance.now();
    try {
      const raw = await readJson(c);
      const conv = fromEmbed(raw, legacy);
      const requested = (raw.model as string).trim();
      const extra: Record<string, string> = conv.ignored.length ? { "x-anyroute-ignored": conv.ignored.join(", ") } : {};
      const res = await inner(c, EMBEDDINGS, { ...conv.body, model: routerName(requested) });
      if (!res.ok) return await fromRouter(c, res, requested, extra);
      const oa = (await res.json()) as { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
      const vectors = [...(oa.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding ?? []);
      if (legacy) return c.json({ embedding: vectors[0] ?? [] }, 200, { ...passHeaders(res), ...extra });
      const duration = Math.round((performance.now() - t0) * 1e6);
      return c.json({ model: requested, embeddings: vectors, total_duration: duration, load_duration: 0, prompt_eval_count: Math.round(oa.usage?.prompt_tokens ?? 0) }, 200, { ...passHeaders(res), ...extra });
    } catch (e) {
      return thrown(c, e);
    }
  };

  // The liveness check Ollama clients make before anything else (the ollama CLI sends HEAD /).
  for (const path of [BASE, `${BASE}/`]) app.get(path, (c) => c.text("Ollama is running"));
  app.get(`${BASE}/api/version`, (c) => c.json({ version: OLLAMA_VERSION }));

  app.get(`${BASE}/api/tags`, async (c) => {
    try {
      await ctx.catalog.ensureFresh();
      // X-Anyroute-Lane: attested lists only the models that can be served on that lane now, as GET /v1/models?lane= does.
      const lane = parseLane(c.req.header("x-anyroute-lane") || undefined, "X-Anyroute-Lane", { unlinkable: unlinkableServed(ctx.cfg) });
      const models = [...ctx.catalog.models.values()]
        .filter((m) => !m.hidden && servable(ctx, m).length > 0)
        .map((m) => modelJson(ctx, m) as ModelInfo)
        .filter((m) => !lane || m.lanes.includes(lane))
        .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
        .map(tagEntry);
      return c.json({ models });
    } catch (e) {
      return thrown(c, e);
    }
  });

  // Models are served on demand by hosted providers: none is held in memory here.
  app.get(`${BASE}/api/ps`, (c) => c.json({ models: [] }));

  app.post(`${BASE}/api/show`, async (c) => {
    try {
      const raw = await readJson(c);
      const name = typeof raw.model === "string" ? raw.model : typeof raw.name === "string" ? raw.name : null;
      if (!name?.trim()) return refusal(c, 400, "model: Field required.");
      const m = await described(name);
      if (!m) return refusal(c, 404, notFound(name.trim()));
      return c.json(showEntry(m, { anyroute: { id: m.id, lanes: m.lanes, context_length: m.context_length } }));
    } catch (e) {
      return thrown(c, e);
    }
  });

  // Nothing is downloaded: a model the catalog lists is ready as soon as it is named, so a pull of one succeeds at once.
  app.post(`${BASE}/api/pull`, async (c) => {
    try {
      const raw = await readJson(c);
      const name = typeof raw.model === "string" ? raw.model : typeof raw.name === "string" ? raw.name : "";
      if (!name.trim()) return refusal(c, 400, "model: Field required.");
      if (!(await described(name))) return refusal(c, 404, notFound(name.trim()));
      if (raw.stream === false) return c.json({ status: "success" });
      return new Response(JSON.stringify({ status: "success" }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
    } catch (e) {
      return thrown(c, e);
    }
  });

  const local = (what: string) => (c: Context) => refusal(c, 501, `${what} is not available: Anyroute serves hosted models, so there are no local models to create, copy, push or delete. See GET /ollama/api/tags.`);
  app.post(`${BASE}/api/create`, local("Creating a model"));
  app.post(`${BASE}/api/copy`, local("Copying a model"));
  app.post(`${BASE}/api/push`, local("Pushing a model"));
  app.delete(`${BASE}/api/delete`, local("Deleting a model"));
  app.on(["HEAD", "POST"], `${BASE}/api/blobs/:digest`, local("Uploading a blob"));

  app.post(`${BASE}/api/chat`, generation("chat"));
  app.post(`${BASE}/api/generate`, generation("generate"));
  app.post(`${BASE}/api/embed`, embed(false));
  app.post(`${BASE}/api/embeddings`, embed(true));

  app.all(`${BASE}/*`, (c) => refusal(c, 404, `No Ollama route for ${c.req.method} ${new URL(c.req.url).pathname}.`));
}
