import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { picoToUsdString, usdToPico } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { MAX_BODY_BYTES } from "./common.ts";
import { bearer } from "./auth.ts";
import { verifyReceipt } from "./generation.ts";
import { labelForReceipt } from "../privacy/resolve.ts";

// AnyRoute MCP: a remote Model Context Protocol server (Streamable HTTP, stateless, JSON replies) so an
// agent can use every live model as a tool. There are no sessions and no SSE stream: each POST carries
// one JSON-RPC 2.0 message and gets one JSON answer. Tools reuse the router's own REST routes in-process
// with the caller's key, so billing, limits and signed receipts are exactly those of /api/v1.
// The attested surface: chat takes a lane and a disclosure ceiling (the router's own provider.lane / provider.disclosure,
// so it refuses rather than downgrade), the URL query or headers of a connection can set them for every call, and
// list_attested_models / verify_provider read the router's public attestation records. Nothing here labels anything
// attested that the router did not check: results repeat the receipt's own fields.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

// Lanes and disclosure ceilings an MCP connection can ask for (the router's own vocabulary, router/disclosure.ts).
// "unlinkable" needs a relay and a blind token, which a tool call cannot use.
const LANES = ["public", "attested"] as const;
const DISCLOSURES = ["none", "policy", "any"] as const;
type LaneName = (typeof LANES)[number];
type DisclosureName = (typeof DISCLOSURES)[number];
const LANE_RANK: Record<LaneName, number> = { public: 0, attested: 1 };
const DISCLOSURE_RANK: Record<DisclosureName, number> = { any: 0, policy: 1, none: 2 };

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
const toolError = (e: ApiError, extra: Json = {}): ToolResult => ({
  content: [text(typeof extra.hint === "string" ? `${e.message} ${extra.hint}` : e.message)],
  structuredContent: { error: { code: e.status, type: e.type, message: e.message, ...extra } },
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
    lane: z.enum(LANES).optional(),
    disclosure: z.enum(DISCLOSURES).optional(),
  })
  .refine((a) => (a.prompt === undefined) !== (a.messages === undefined), { message: "provide either prompt or messages, not both" });
const receiptArgs = z.object({ id: z.string().min(1).max(200) });
const listAttestedArgs = z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(25) });
/** The same shape the verify page and the router's attestation route accept for a provider id. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const verifyProviderArgs = z.object({ provider_id: z.string().regex(PROVIDER_ID, "must be a provider id (letters, digits and . _ : -)") });

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
      "Send a prompt to any live model through AnyRoute and get the reply, a signed receipt id, the cost in USD and the latency. Billed to the API key that connected this server. Give either prompt or messages. Set lane to \"attested\" to send the prompt only to a provider whose TEE attestation the router has verified and that documents no retention: if none can answer, the call fails and nothing is sent or charged. A connection whose URL ends in ?lane=attested does this for every call. The result reports the lane, the disclosure class the answer was served under and, when the receipt carries one, the gateway's upstream_attestation (attested, gpu_attested). It also carries a privacy summary in plain English (who read the prompt, who saw the address, how it was paid, what was kept, what hardware answered), computed from the signed receipt.",
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
        lane: { type: "string", enum: ["public", "attested"], description: "attested: only providers with a fresh, router-verified TEE attestation and attested retention; the call is refused (nothing sent, nothing charged) when none qualifies. Never relaxes the server default." },
        disclosure: { type: "string", enum: ["none", "policy", "any"], description: "Strictest ceiling on who may see the prompt: none (attested retention with a fresh attestation), policy (also a documented no-retention policy) or any (default)." },
      },
      required: ["model"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "list_attested_models",
    title: "List models with a proven enclave",
    description:
      "List the models that have at least one endpoint the router currently serves under attested retention with a fresh TEE attestation it verified itself (the attested lane), with context length, price per 1M tokens and gpu_attested: true when the latest verified gateway receipt for the model asserted GPU attestation, false when it did not, null when no receipt has been recorded. Attestation shows what is running, not what it does with data; verify_provider lists what is not checked. Needs no API key.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive words that must all appear in the model id or name." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25, description: "Maximum models to return (newest first)." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "verify_provider",
    title: "Check a provider's attestation",
    description:
      "Return the router's own attestation record for a provider in plain terms: status (attested or unverified, or a development report marked as such), the TEE and the verifiers that accepted its quote, whether the router pins the provider's TLS certificate, the transparency-log status of its measurement, and the list of what the router does not check. The provider id is the provider field of a receipt (see get_receipt) or the id shown on the verify page. Needs no API key.",
    inputSchema: { type: "object", properties: { provider_id: { type: "string", description: "Provider id, for example the provider field of a receipt payload." } }, required: ["provider_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
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

const ARGS: Record<string, z.ZodType> = {
  list_models: listModelsArgs,
  chat: chatArgs,
  get_receipt: receiptArgs,
  verify_receipt: receiptArgs,
  list_attested_models: listAttestedArgs,
  verify_provider: verifyProviderArgs,
};
const NEEDS_KEY = new Set(["chat"]);

export function mcpRoutes(app: Hono, ctx: Ctx) {
  /** Call one of the router's own REST routes in-process, turning its error body back into an ApiError. */
  const internal = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    const body = (await res.json().catch(() => null)) as { id?: unknown; error?: { message?: string; type?: string; metadata?: Record<string, unknown> } } | null;
    if (!res.ok) {
      // A refusal that was billed (an attested answer withheld) carries the generation id of its receipt.
      const billed = typeof body?.id === "string" ? { receipt_id: body.id } : {};
      const metadata = body?.error?.metadata || billed.receipt_id ? { ...body?.error?.metadata, ...billed } : undefined;
      throw new ApiError(res.status, body?.error?.message ?? `The router answered ${res.status}.`, body?.error?.type ?? "upstream_error", metadata);
    }
    return body as Json;
  };

  /** The lane and disclosure ceiling this connection asks for by default: ?lane= / ?disclosure= on the /mcp URL and the
   * X-Anyroute-Lane / X-Anyroute-Disclosure-Max headers, the strictest of them. An unrecognised value is a 400, never a weaker setting. */
  const connectionDefaults = (c: Context) => {
    const pick = <T extends string>(what: string, values: string[], allowed: readonly T[], rank: Record<T, number>, base: T): T =>
      values.reduce<T>((strictest, raw) => {
        const v = raw.trim().toLowerCase();
        if (!v) return strictest;
        if (!(allowed as readonly string[]).includes(v))
          throw new ApiError(400, `${what} must be one of: ${allowed.join(", ")}.${v === "unlinkable" ? " The unlinkable lane needs a relay and a blind token, which an MCP connection cannot use." : ""} No prompt was sent.`, "invalid_request");
        return rank[v as T] > rank[strictest] ? (v as T) : strictest;
      }, base);
    return {
      lane: pick("The lane on the /mcp URL (?lane=) or in X-Anyroute-Lane", [...(c.req.queries("lane") ?? []), c.req.header("x-anyroute-lane") ?? ""], LANES, LANE_RANK, "public"),
      disclosure: pick("The disclosure ceiling on the /mcp URL (?disclosure=) or in X-Anyroute-Disclosure-Max", [...(c.req.queries("disclosure") ?? []), c.req.header("x-anyroute-disclosure-max") ?? ""], DISCLOSURES, DISCLOSURE_RANK, "any"),
    };
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
    // The strictest of the connection's default and this call's own setting: a call can tighten but never relax it.
    const def = connectionDefaults(c);
    const lane: LaneName = LANE_RANK[a.lane ?? "public"] > LANE_RANK[def.lane] ? (a.lane ?? "public") : def.lane;
    const disclosure: DisclosureName = DISCLOSURE_RANK[a.disclosure ?? "any"] > DISCLOSURE_RANK[def.disclosure] ? (a.disclosure ?? "any") : def.disclosure;
    const provider = { ...(lane !== "public" ? { lane } : {}), ...(disclosure !== "any" ? { disclosure } : {}) };
    const started = Date.now();
    const out = (await internal("/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: c.req.header("authorization")!, "content-type": "application/json" },
      body: JSON.stringify({
        model: a.model,
        messages: a.messages ?? [{ role: "user", content: a.prompt }],
        ...(a.max_tokens !== undefined ? { max_tokens: a.max_tokens } : {}),
        ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
        ...(Object.keys(provider).length ? { provider } : {}),
        stream: false,
      }),
      signal: c.req.raw.signal,
    })) as { id?: string; model?: string; provider?: string; choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }; receipt?: { id?: string; payload?: { disclosure?: unknown; attestation_simulated?: unknown; upstream_attestation?: Record<string, unknown> } } };
    const content = out.choices?.[0]?.message?.content;
    const reply = typeof content === "string" ? content : "";
    const served = out.receipt?.payload;
    const ua = served?.upstream_attestation;
    // "What we saw": the plain-English label derived from this answer's signed receipt (privacy/label.ts).
    const label = served ? await labelForReceipt(ctx, { id: out.receipt?.id ?? out.id, payload: served }).catch(() => null) : null;
    const meta = {
      receipt_id: out.receipt?.id ?? out.id ?? null,
      cost_usd: out.usage?.cost ?? 0,
      latency_ms: Date.now() - started,
      model: out.model ?? a.model,
      provider: out.provider ?? null,
      finish_reason: out.choices?.[0]?.finish_reason ?? null,
      usage: { prompt_tokens: out.usage?.prompt_tokens ?? 0, completion_tokens: out.usage?.completion_tokens ?? 0 },
      // What was asked for, and what the signed receipt says the answer was served under (attested, policy or vendor-forwarded).
      ...(label ? { privacy: { summary: label.summary, short: label.short, verify_url: label.verify_url } } : {}),
      lane,
      disclosure: typeof served?.disclosure === "string" ? served.disclosure : null,
      ...(served?.attestation_simulated === true ? { attestation_simulated: true } : {}),
      // The gateway's receipt check, when the provider is an attested gateway: only what the router verified.
      ...(ua && typeof ua === "object"
        ? { upstream_attestation: { attested: ua.attested === true, gpu_attested: ua.gpu_attested === true, receipt_verified: ua.receipt_verified === true, kind: ua.kind ?? null, receipt_id: ua.receipt_id ?? null, ...(typeof ua.reason === "string" ? { reason: ua.reason } : {}) } }
        : {}),
    };
    return { content: [text(reply), text(JSON.stringify(meta))], structuredContent: { text: reply, ...meta } } satisfies ToolResult;
  };

  const listAttested = async (a: z.infer<typeof listAttestedArgs>) => {
    const { data } = (await internal("/api/v1/models?lane=attested")) as {
      data: { id: string; name: string; context_length: number; pricing: { prompt: string; completion: string }; gpu_attested?: boolean | null; disclosure?: { endpoints?: { attested?: number } } }[];
    };
    const terms = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = data.filter((m) => terms.every((t) => `${m.id} ${m.name}`.toLowerCase().includes(t)));
    const models = hits.slice(0, a.limit).map((m) => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      price_per_1m_input_usd: perMillion(m.pricing.prompt),
      price_per_1m_output_usd: perMillion(m.pricing.completion),
      attested_endpoints: m.disclosure?.endpoints?.attested ?? 0,
      gpu_attested: typeof m.gpu_attested === "boolean" ? m.gpu_attested : null,
    }));
    return ok({
      lane: "attested",
      total: hits.length,
      returned: models.length,
      models,
      gpu_attested_means: "true: the latest verified gateway receipt for this model asserted GPU attestation; false: it did not; null: no receipt recorded yet.",
      attested_means: "The router verified the endpoint's TEE attestation itself and the provider documents no retention. It shows what is running, not what it does with data; see verify_provider for what is not checked.",
    });
  };

  const REASONS: Record<string, string> = {
    no_attestation: "The router has no attestation on record for this provider.",
    last_attempt_failed: "The router's last attempt to verify this provider failed.",
    attestation_stale: "The router's last verified attestation is older than it accepts.",
    simulated_evidence_refused: "The only evidence on record is a development report, which this router does not accept.",
  };

  const verifyProvider = async (a: z.infer<typeof verifyProviderArgs>) => {
    const { data: d } = (await internal(`/api/v1/attestation/${encodeURIComponent(a.provider_id)}`)) as {
      data: {
        provider: string;
        status: "attested" | "simulated" | "unverified";
        reason?: string;
        tee: string | null;
        attested_at: string | null;
        verifiers: string[];
        tls_pin: { spki_sha256: string; attestation_ref: string | null; pinned_at: string | null } | null;
        measurement: { status?: string; transparency_log?: { found?: boolean; inclusion_verified?: boolean; checkpoint_signature_verified?: boolean; kind?: string | null; subject?: string | null; entry_url?: string | null; log_index?: number | null } } | null;
        checks: Record<string, boolean>;
        gateway?: Json;
        not_checked: string[];
      };
    };
    const log = d.measurement?.transparency_log;
    const logged = log?.found === true;
    const tee = d.tee ? d.tee.toUpperCase() : "TEE";
    const summary =
      d.status === "attested"
        ? `The router verified this provider's ${tee} attestation itself${d.verifiers.length ? ` (accepted by ${d.verifiers.join(", ")})` : ""}${d.attested_at ? ` at ${d.attested_at}` : ""}. ${
            d.tls_pin ? "Its TLS connections are pinned to the key that attestation bound." : "No TLS key is pinned for it."
          } ${logged ? "A transparency-log entry for its measurement exists and its inclusion was verified." : d.measurement ? "No transparency-log entry has been verified for its measurement." : "No measurement is recorded for it."} This shows what is running, not what it does with a prompt; not_checked lists what the router does not verify.`
        : d.status === "simulated"
          ? "The only evidence is a development report. It is not a hardware attestation, and a production router refuses it. The attested lane must not be relied on for this provider."
          : `${(d.reason && REASONS[d.reason]) || "The router holds no fresh, verified attestation for this provider."} The router will not send an attested-lane request to it.`;
    return ok({
      provider: d.provider,
      status: d.status,
      ...(d.reason ? { reason: d.reason } : {}),
      summary,
      tee: d.tee,
      verifiers: d.verifiers,
      attested_at: d.attested_at,
      tls_pin: d.tls_pin ? { pinned: true, spki_sha256: d.tls_pin.spki_sha256, pinned_at: d.tls_pin.pinned_at } : { pinned: false },
      transparency_log: {
        entry_found: logged,
        inclusion_verified: log?.inclusion_verified === true,
        checkpoint_signature_verified: log?.checkpoint_signature_verified === true,
        subject: log?.subject ?? null,
        entry_url: log?.entry_url ?? null,
      },
      registered_on_chain: d.checks?.registered_on_chain === true,
      ...(d.gateway ? { gateway: d.gateway } : {}),
      not_checked: d.not_checked,
      verify_page: `${ctx.cfg.publicUrl}/verify?p=${encodeURIComponent(d.provider)}`,
    });
  };

  const receiptOf = async (id: string) => ((await internal(`/api/v1/receipts/${encodeURIComponent(id)}`)) as { data: { id: string; payload: Json | null; sig: string | null; key_id: string | null; anchor: (Json & { root: string; proof: string[]; index?: number }) | null } }).data;

  const verify = async (a: z.infer<typeof receiptArgs>) => {
    const r = await receiptOf(a.id);
    if (!r.payload || !r.sig || !r.key_id) return ok({ id: r.id, valid: false, reason: "This generation has no signed receipt." });
    const v = await verifyReceipt(ctx, { payload: r.payload, sig: r.sig, key_id: r.key_id, anchor: r.anchor ?? undefined });
    return ok({ id: r.id, valid: v.valid, signature_valid: v.signature_valid, anchored: v.inclusion_valid === true, key_source: v.key_source, onchain_root: v.onchain_root });
  };

  /** Extra, plain context for a chat call the router refused. Nothing here relaxes the refusal. */
  const chatFailure = (e: ApiError): Json => {
    const receipt = typeof e.metadata?.receipt_id === "string" ? { receipt_id: e.metadata.receipt_id } : {};
    switch (e.type) {
      case "no_attested_endpoint":
      case "lane_unavailable":
      case "disclosure_unavailable":
        return { hint: "Call list_attested_models to see which models have a proven enclave right now, or leave lane and disclosure unset (and drop ?lane=attested from the server URL) to allow any provider." };
      case "upstream_not_attested":
        return { ...receipt, hint: "The reply was withheld, not shown. The provider had already generated it, so the call is billed; the signed receipt records why." };
      default:
        return receipt;
    }
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
        case "list_attested_models":
          return await listAttested(parsed.data as z.infer<typeof listAttestedArgs>);
        case "verify_provider":
          return await verifyProvider(parsed.data as z.infer<typeof verifyProviderArgs>);
        default:
          return await verify(parsed.data as z.infer<typeof receiptArgs>);
      }
    } catch (e) {
      if (e instanceof ApiError) return toolError(e, p.name === "chat" ? chatFailure(e) : {});
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
        case "initialize": {
          // A malformed default is reported by the first chat call (which refuses it); initialize just does not announce it.
          let restricted = false;
          try {
            const d = connectionDefaults(c);
            restricted = d.lane !== "public" || d.disclosure !== "any";
          } catch {}
          return c.json(
            rpcResult(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "anyroute", title: "AnyRoute", version: SERVER_VERSION },
              instructions:
                "Use list_models to find a model, chat to call it (needs an API key; every call returns a signed receipt id), then get_receipt or verify_receipt to check the receipt. To keep a prompt with proven enclaves, list_attested_models shows the models that have one, chat with lane \"attested\" sends only to them (and refuses, sending nothing, when none can answer), and verify_provider shows what the router checked about a provider and what it did not." +
                (restricted ? " This connection is restricted by its URL or headers: chat calls carry that lane or disclosure ceiling and cannot relax it." : ""),
            }),
          );
        }
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
