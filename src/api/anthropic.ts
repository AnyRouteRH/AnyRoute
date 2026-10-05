import { onionMessagesHeaders, onionCountAllowed } from "../anthropic/onion.ts";
import type { Context, Hono } from "hono";
import { randomBytes } from "node:crypto";
import { ZodError } from "zod";
import type { Ctx } from "../context.ts";
import { ApiError } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import { KEY_RE } from "../chain/keys.ts";
import { estimatePromptTokens } from "../router/pricing.ts";
import { bearer, requireRole, resolveKey } from "./auth.ts";
import { readJson } from "./common.ts";
import { clampMaxTokens, errorBody, routerErrorInfo, toChatRequest, toMessage, type AnyRouteInfo } from "../anthropic/convert.ts";
import { isAnthropicName, mappedModel } from "../anthropic/models.ts";
import { streamMessages, type StreamSummary } from "../anthropic/stream.ts";

// Anthropic Messages API: POST /v1/messages and /v1/messages/count_tokens (also under /api/v1), so the Anthropic SDKs
// and Claude Code (ANTHROPIC_BASE_URL pointed at the router, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN an AnyRoute key)
// can use AnyRoute models. This is an adapter, like src/api/mcp.ts: the request is converted and sent through the
// router's own /api/v1/chat/completions in-process, so keys, limits, billing, lanes, disclosure, receipts and the
// response headers are exactly those of a chat call, and are forwarded on the reply. Nothing is decided here.

/** How long a stream is held back to see whether the router refuses the request (see anthropic/stream.ts). */
const PEEK_MS = 4_000;

/** Response headers of a chat call that ride on the Anthropic reply. */
const FORWARDED = ["x-generation-id", "x-receipt-id", "inference-id", "x-anyroute-lane", "x-anyroute-policy-hash", "x-anyroute-disclosure", "x-anyroute-cache", "x-payment-response", "payment-response", "retry-after", "www-authenticate"];
/** Request headers passed to the chat call: routing options, not credentials. */
const PASSED = ["x-anyroute-lane", "x-anyroute-disclosure-max", "x-anyroute-cache", "x-pay-with", "http-referer", "x-title", "traceparent", "x-anyroute-decision-tag"];
/** The statuses Anthropic itself uses. Any other client error is not one an SDK should retry. */
const ANTHROPIC_STATUSES = new Set([400, 401, 402, 403, 404, 413, 429]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const newRequestId = () => "req_" + randomBytes(12).toString("hex");

/** The key a call presents: x-api-key (ANTHROPIC_API_KEY) or Authorization: Bearer (ANTHROPIC_AUTH_TOKEN). If both are sent, the one shaped like an AnyRoute key. */
function credential(c: Context): string | null {
  const found = [c.req.header("x-api-key"), bearer(c.req.header("authorization"))].map((v) => v?.trim()).filter((v): v is string => !!v);
  return found.find((k) => KEY_RE.test(k)) ?? found[0] ?? null;
}

function refusal(c: Context, status: number, message: string, requestId: string, o: { router?: Json; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "request-id": requestId, ...(o.headers ?? {}) };
  // Anthropic SDKs retry 408, 409, 429 and 5xx. A refusal the router will repeat (a lane that cannot be served, a lane
  // it does not run) is not worth retrying; x-should-retry says so.
  if ((status >= 400 && status < 500 && !ANTHROPIC_STATUSES.has(status) && status !== 408) || status === 501) headers["x-should-retry"] = "false";
  // A lane with no attested endpoint at all (503 no_attested_endpoint, reason none_attested) is refused again on retry;
  // only an outage of attested endpoints (reason attested_endpoints_down, with Retry-After) is worth retrying.
  const meta = isObj(o.router?.metadata) ? o.router.metadata : {};
  if (o.router?.type === "no_attested_endpoint" && meta.reason === "none_attested") headers["x-should-retry"] = "false";
  return c.json(errorBody(status, message, requestId, o.router), status as never, headers);
}

function thrown(c: Context, e: unknown, requestId: string) {
  if (e instanceof ApiError) return refusal(c, e.status, e.message, requestId, { router: routerErrorInfo(e), headers: e.headers });
  if (e instanceof ZodError) return refusal(c, 400, "Invalid request: " + e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), requestId);
  if ((e as Error)?.name === "AbortError") return refusal(c, 499, "Client closed the request.", requestId);
  log.error("anthropic request failed", { error: (e as Error)?.message });
  return refusal(c, 500, "Internal router error.", requestId);
}

const forwarded = (from: Headers) => Object.fromEntries(FORWARDED.flatMap((h) => (from.get(h) ? [[h, from.get(h)!]] : [])));

/** What a reply says about the call beyond the message: the receipt, the lane it was served under and what the router verified. */
function anyrouteInfo(o: { receipt: Json | null; provider: string | null; costUsd: number | null; headers: Headers }): AnyRouteInfo {
  const payload = isObj(o.receipt?.payload) ? (o.receipt!.payload as Json) : {};
  const policy = o.headers.get("x-anyroute-policy-hash");
  return {
    receipt_id: (typeof o.receipt?.id === "string" ? o.receipt.id : null) ?? o.headers.get("x-receipt-id"),
    lane: o.headers.get("x-anyroute-lane") ?? (typeof payload.lane === "string" ? payload.lane : null),
    disclosure: o.headers.get("x-anyroute-disclosure") ?? (typeof payload.disclosure === "string" ? payload.disclosure : null),
    ...(policy ? { policy_hash: policy } : {}),
    provider: o.provider,
    cost_usd: o.costUsd,
    ...(payload.attestation_simulated === true ? { attestation_simulated: true } : {}),
    ...(isObj(payload.upstream_attestation) ? { upstream_attestation: payload.upstream_attestation } : {}),
    ...(o.receipt ? { receipt: o.receipt } : {}),
  };
}

export function anthropicRoutes(app: Hono, ctx: Ctx) {
  /** Why a claude-* name did not resolve: AnyRoute serves open models. Names a live model so the fix is one copy away. */
  const unknownAnthropicModel = (name: string) => {
    const example = ctx.catalog.models.keys().next().value ?? "<author>/<model>";
    return `The model '${name}' is not available here: AnyRoute serves open models, not Anthropic's. Choose a model from GET /v1/models (for example ANTHROPIC_MODEL=${example} in Claude Code, or model="${example}" in an SDK call), or ask the operator to map this name with ANTHROPIC_MODEL_MAP.`;
  };

  const messages = async (c: Context) => {
    const requestId = newRequestId();
    try {
      const blindHeaders = onionMessagesHeaders(c, ctx);
      const key = credential(c);
      if (!key && !blindHeaders) return refusal(c, 401, "Provide your AnyRoute key in the x-api-key header (ANTHROPIC_API_KEY) or as Authorization: Bearer (ANTHROPIC_AUTH_TOKEN).", requestId, { router: { type: "missing_key" } });
      const raw = await readJson(c);
      const conv = toChatRequest(raw);
      const requested = raw.model as string;
      const stream = conv.body.stream === true;

      // The model: the operator's map, else the name as sent (a catalog id, a saved route or one of the key's own aliases).
      const target = mappedModel(ctx.cfg.anthropic.modelMap, requested) ?? requested;
      conv.body.model = target;
      await ctx.catalog.ensureFresh();
      const row = ctx.catalog.resolve(target)?.model;
      const promptTokens = estimatePromptTokens(conv.body);
      // Anthropic clients ask for large max_tokens; a provider rejects more than the model can produce or the context can hold.
      if (row) conv.body.max_tokens = clampMaxTokens(conv.body.max_tokens as number, row, promptTokens);

      const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json" };
      for (const h of PASSED) {
        const v = c.req.header(h);
        if (v) headers[h] = v;
      }
      if (blindHeaders) Object.assign(headers, blindHeaders);
      const res = await app.request("/api/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(conv.body), signal: c.req.raw.signal });
      const extra: Record<string, string> = { "request-id": requestId, ...(conv.ignored.length ? { "x-anyroute-ignored": conv.ignored.join(", ") } : {}) };

      const fromRouter = async () => {
        const body = (await res.json().catch(() => null)) as { id?: unknown; error?: { message?: string; type?: string; metadata?: Record<string, unknown> } } | null;
        const err = body?.error;
        let message = typeof err?.message === "string" ? err.message : `The router answered ${res.status}.`;
        if (res.status === 404 && err?.type === "model_not_found") {
          if (target !== requested) message = `ANTHROPIC_MODEL_MAP maps '${requested}' to '${target}', which is not available. See GET /v1/models.`;
          else if (isAnthropicName(requested)) message = unknownAnthropicModel(requested);
        }
        return refusal(c, res.status, message, requestId, { router: routerErrorInfo(err ?? {}, body?.id), headers: forwarded(res.headers) });
      };

      if (!res.ok) return await fromRouter();

      if (stream) {
        return await streamMessages(res, {
          requestId,
          model: target,
          inputTokens: promptTokens,
          stops: conv.stops,
          peekMs: PEEK_MS,
          headers: { ...forwarded(res.headers), ...extra },
          describe: (s: StreamSummary, h: Headers) => anyrouteInfo({ receipt: s.receipt, provider: s.provider, costUsd: typeof (s.receipt?.payload as Json | undefined)?.cost === "string" ? Number((s.receipt!.payload as Json).cost) : null, headers: h }),
          refuse: (status, message, router) => refusal(c, status, message, requestId, { router, headers: forwarded(res.headers) }),
        });
      }

      const oa = (await res.json()) as Json;
      const usage = isObj(oa.usage) ? oa.usage : {};
      const info = anyrouteInfo({ receipt: isObj(oa.receipt) ? oa.receipt : null, provider: typeof oa.provider === "string" ? oa.provider : null, costUsd: typeof usage.cost === "number" ? usage.cost : null, headers: res.headers });
      return c.json(toMessage(oa, { model: target, stops: conv.stops, id: requestId, anyroute: info }), 200, { ...forwarded(res.headers), ...extra });
    } catch (e) {
      return thrown(c, e, requestId);
    }
  };

  /** Token count for a prompt: the router's own estimate (about one token per three characters of text and JSON, 1,600 per image), not a tokenizer's count. Free; needs a key except on the unlinkable onion path. */
  const countTokens = async (c: Context) => {
    const requestId = newRequestId();
    try {
      if (!onionCountAllowed(c, ctx)) {
        const secret = credential(c);
        if (!secret) return refusal(c, 401, "Provide your AnyRoute key in the x-api-key header (ANTHROPIC_API_KEY) or as Authorization: Bearer (ANTHROPIC_AUTH_TOKEN).", requestId, { router: { type: "missing_key" } });
        const key = await resolveKey(ctx, secret);
        if (!key) return refusal(c, 401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDG to its key hash first.", requestId, { router: { type: "invalid_key" } });
        await requireRole(ctx, key, ["owner", "admin", "member"]);
        const limit = key.rpm ?? ctx.cfg.limits.defaultRpm;
        if (limit) {
          const r = await ctx.limiter.take(`kc:${key.keyHash}`, 1, limit, 60_000);
          if (!r.ok) {
            const s = Math.ceil(r.retryAfterMs / 1000);
            return refusal(c, 429, `Rate limit exceeded (${limit} requests/min). Retry in ${s}s.`, requestId, { router: { type: "rate_limited" }, headers: { "retry-after": String(s) } });
          }
        }
      }
      const conv = toChatRequest(await readJson(c), { countOnly: true });
      return c.json({ input_tokens: estimatePromptTokens(conv.body) }, 200, { "request-id": requestId });
    } catch (e) {
      return thrown(c, e, requestId);
    }
  };

  for (const base of ["/v1/messages", "/api/v1/messages"]) {
    app.post(base, messages);
    app.post(`${base}/count_tokens`, countTokens);
  }
}
