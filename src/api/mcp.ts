import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { MAX_BODY_BYTES } from "./common.ts";
import { bearer } from "./auth.ts";
import { verifyReceipt } from "./generation.ts";

// AnyRoute MCP: a remote Model Context Protocol server (Streamable HTTP, stateless, JSON replies) so an
// agent can use every live model as a tool. There are no sessions and no SSE stream: each POST carries
// one JSON-RPC 2.0 message and gets one JSON answer. Tools reuse the router's own REST routes in-process
// with the caller's key, so billing, limits and signed receipts are exactly those of /api/v1.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;
type Json = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Json; isError?: boolean };

class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

const text = (t: string) => ({ type: "text" as const, text: t });
const ok = (data: Json, ...lead: string[]): ToolResult => ({ content: [...lead.map(text), text(JSON.stringify(data, null, 2))], structuredContent: data });
const toolError = (e: ApiError): ToolResult => ({
  content: [text(e.message)],
  structuredContent: { error: { code: e.status, type: e.type, message: e.message } },
  isError: true,
});

/** Per 1M tokens in USD, from the router's per-token decimal price string (exact, no float drift). */
const perMillion = (perToken: string) => Number(picoToUsdString(usdToPico(perToken) * 1_000_000n));

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");

const listModelsArgs = z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(25) });
const chatArgs = z
  .object({
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).optional(),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).min(1).optional(),
    max_tokens: z.number().int().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .refine((a) => (a.prompt === undefined) !== (a.messages === undefined), { message: "provide either prompt or messages, not both" });
const receiptArgs = z.object({ id: z.string().min(1).max(200) });

const TOOLS = [
  {
    name: "list_models",
    title: "List live models",
    description: "List the models currently live on this AnyRoute router with context length and price per 1M input and output tokens (USD). Optionally filter by a search string. Needs no API key.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive words that must all appear in the model id or name, for example \"llama 70b\"." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25, description: "Maximum models to return (newest first)." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "chat",
    title: "Chat with any model",
    description:
      "Send a prompt to any live model through AnyRoute and get the reply, a signed receipt id, the cost in USD and the latency. Billed to the API key that connected this server. Give either prompt or messages.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id from list_models, for example \"meta-llama/llama-3.3-70b-instruct\"." },
        prompt: { type: "string", description: "A single user message. Use this or messages." },
        messages: {
          type: "array",
          description: "A full conversation. Use this or prompt.",
          items: {
            type: "object",
            properties: { role: { type: "string", enum: ["system", "user", "assistant"] }, content: { type: "string" } },
            required: ["role", "content"],
          },
        },
        max_tokens: { type: "integer", minimum: 1, description: "Maximum tokens to generate." },
        temperature: { type: "number", minimum: 0, maximum: 2 },
      },
      required: ["model"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_receipt",
    title: "Get a signed receipt",
    description: "Fetch the public signed receipt for a generation by id: payload, Ed25519 signature, signing key id, merkle leaf and the anchor proof once it is anchored. Needs no API key.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Receipt id, as returned by chat." } }, required: ["id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "verify_receipt",
    title: "Verify a signed receipt",
    description: "Verify a receipt's signature against the published signing key and, when it has been anchored, its merkle inclusion. Returns valid true or false. Needs no API key.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Receipt id, as returned by chat." } }, required: ["id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const ARGS: Record<string, z.ZodType> = { list_models: listModelsArgs, chat: chatArgs, get_receipt: receiptArgs, verify_receipt: receiptArgs };
const NEEDS_KEY = new Set(["chat"]);

export function mcpRoutes(app: Hono, ctx: Ctx) {
  /** Call one of the router's own REST routes in-process, turning its error body back into an ApiError. */
  const internal = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; type?: string; metadata?: Record<string, unknown> } } | null;
    if (!res.ok) throw new ApiError(res.status, body?.error?.message ?? `The router answered ${res.status}.`, body?.error?.type ?? "upstream_error", body?.error?.metadata);
    return body as Json;
  };

  const listModels = async (a: z.infer<typeof listModelsArgs>) => {
    const { data } = (await internal("/api/v1/models")) as { data: { id: string; name: string; context_length: number; pricing: { prompt: string; completion: string } }[] };
    const terms = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = data.filter((m) => terms.every((t) => `${m.id} ${m.name}`.toLowerCase().includes(t)));
    const models = hits.slice(0, a.limit).map((m) => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      price_per_1m_input_usd: perMillion(m.pricing.prompt),
      price_per_1m_output_usd: perMillion(m.pricing.completion),
    }));
    return ok({ total: hits.length, returned: models.length, models });
  };

  const chat = async (c: Context, a: z.infer<typeof chatArgs>) => {
    const started = Date.now();
    const out = (await internal("/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: c.req.header("authorization")!, "content-type": "application/json" },
      body: JSON.stringify({
        model: a.model,
        messages: a.messages ?? [{ role: "user", content: a.prompt }],
        ...(a.max_tokens !== undefined ? { max_tokens: a.max_tokens } : {}),
        ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
        stream: false,
      }),
      signal: c.req.raw.signal,
    })) as { id?: string; model?: string; provider?: string; choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }; receipt?: { id?: string } };
    const content = out.choices?.[0]?.message?.content;
    const reply = typeof content === "string" ? content : "";
    const meta = {
      receipt_id: out.receipt?.id ?? out.id ?? null,
      cost_usd: out.usage?.cost ?? 0,
      latency_ms: Date.now() - started,
      model: out.model ?? a.model,
      provider: out.provider ?? null,
      finish_reason: out.choices?.[0]?.finish_reason ?? null,
      usage: { prompt_tokens: out.usage?.prompt_tokens ?? 0, completion_tokens: out.usage?.completion_tokens ?? 0 },
    };
    return { content: [text(reply), text(JSON.stringify(meta))], structuredContent: { text: reply, ...meta } } satisfies ToolResult;
  };

  const receiptOf = async (id: string) => ((await internal(`/api/v1/receipts/${encodeURIComponent(id)}`)) as { data: { id: string; payload: Json | null; sig: string | null; key_id: string | null; anchor: (Json & { root: string; proof: string[]; index?: number }) | null } }).data;

  const verify = async (a: z.infer<typeof receiptArgs>) => {
    const r = await receiptOf(a.id);
    if (!r.payload || !r.sig || !r.key_id) return ok({ id: r.id, valid: false, reason: "This generation has no signed receipt." });
    const v = await verifyReceipt(ctx, { payload: r.payload, sig: r.sig, key_id: r.key_id, anchor: r.anchor ?? undefined });
    return ok({ id: r.id, valid: v.valid, signature_valid: v.signature_valid, anchored: v.inclusion_valid === true, key_source: v.key_source, onchain_root: v.onchain_root });
  };

  async function callTool(c: Context, params: unknown): Promise<ToolResult> {
    const p = params as { name?: unknown; arguments?: unknown } | null;
    if (!p || typeof p !== "object" || typeof p.name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call needs params.name.");
    if (p.arguments !== undefined && (p.arguments === null || typeof p.arguments !== "object" || Array.isArray(p.arguments))) throw new RpcError(INVALID_PARAMS, "params.arguments must be an object.");
    const args = p.arguments ?? {};
    const schema = ARGS[p.name];
    if (!schema) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${p.name}.`);
    const parsed = schema.safeParse(args);
    if (!parsed.success) throw new RpcError(INVALID_PARAMS, `Invalid arguments for ${p.name}: ${issues(parsed.error)}.`);
    try {
      if (NEEDS_KEY.has(p.name) && !bearer(c.req.header("authorization")))
        throw new ApiError(401, `The ${p.name} tool needs an AnyRoute API key. Send it as \`Authorization: Bearer sk-ar-v1-...\` in this MCP server's HTTP headers. list_models, get_receipt and verify_receipt work without one.`, "missing_key");
      switch (p.name) {
        case "list_models":
          return await listModels(parsed.data as z.infer<typeof listModelsArgs>);
        case "chat":
          return await chat(c, parsed.data as z.infer<typeof chatArgs>);
        case "get_receipt":
          return ok((await receiptOf((parsed.data as z.infer<typeof receiptArgs>).id)) as Json);
        default:
          return await verify(parsed.data as z.infer<typeof receiptArgs>);
      }
    } catch (e) {
      if (e instanceof ApiError) return toolError(e);
      throw e;
    }
  }

  /** DNS-rebinding guard: a request that carries an Origin must come from this router's own origin. */
  const sameOrigin = (c: Context) => {
    const origin = c.req.header("origin");
    if (origin === undefined) return true;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    return host === new URL(c.req.url).host || host === new URL(ctx.cfg.publicUrl).host;
  };

  app.post("/mcp", async (c) => {
    c.header("cache-control", "no-store");
    if (!sameOrigin(c)) return c.json(rpcError(null, INVALID_REQUEST, "Cross-origin requests to /mcp are not allowed."), 403);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return c.json(rpcError(null, INVALID_REQUEST, "Request body is too large (16 MB max)."), 413);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json(rpcError(null, INVALID_REQUEST, "Request body is too large (16 MB max)."), 413);
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return c.json(rpcError(null, PARSE_ERROR, "Parse error: the body must be valid JSON."), 400);
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return c.json(rpcError(null, INVALID_REQUEST, "Invalid Request: send one JSON-RPC 2.0 message per POST."), 400);
    const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (m.jsonrpc !== "2.0") return c.json(rpcError(null, INVALID_REQUEST, 'Invalid Request: "jsonrpc" must be "2.0".'), 400);
    if (typeof m.method !== "string") {
      // A reply to a server-to-client request: this server sends none, so just acknowledge it.
      if (m.id !== undefined && ("result" in m || "error" in m)) return c.body(null, 202);
      return c.json(rpcError(null, INVALID_REQUEST, 'Invalid Request: "method" must be a string.'), 400);
    }
    if (m.id === undefined) return c.body(null, 202); // notification, e.g. notifications/initialized
    if (typeof m.id !== "string" && typeof m.id !== "number") return c.json(rpcError(null, INVALID_REQUEST, 'Invalid Request: "id" must be a string or a number.'), 400);
    const id = m.id;
    try {
      switch (m.method) {
        case "initialize":
          return c.json(
            rpcResult(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "anyroute", title: "AnyRoute", version: SERVER_VERSION },
              instructions: "Use list_models to find a model, chat to call it (needs an API key; every call returns a signed receipt id), then get_receipt or verify_receipt to check the receipt.",
            }),
          );
        case "ping":
          return c.json(rpcResult(id, {}));
        case "tools/list":
          return c.json(rpcResult(id, { tools: TOOLS }));
        case "tools/call":
          return c.json(rpcResult(id, await callTool(c, m.params)));
        default:
          return c.json(rpcError(id, METHOD_NOT_FOUND, `Method not found: ${m.method}.`));
      }
    } catch (e) {
      if (e instanceof RpcError) return c.json(rpcError(id, e.code, e.message));
      log.error("mcp request failed", { method: m.method, error: (e as Error)?.message });
      return c.json(rpcError(id, INTERNAL_ERROR, "Internal router error."));
    }
  });
  // Stateless: there is no server-to-client SSE stream to open and no session to delete.
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json(rpcError(null, INVALID_REQUEST, "Method not allowed: POST JSON-RPC messages to /mcp."), 405, { allow: "POST" }));
}
