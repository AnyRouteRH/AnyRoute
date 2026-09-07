import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { apps, byokKeys, generations } from "../db/schema.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { ApiError, fail, isApiError } from "../lib/errors.ts";
import { type Pico, maxPico, picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { canonical, canonicalJson, decrypt, genId, log, sha256 } from "../lib/util.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { estimatePromptTokens, maxOutputTokens, priceUsage, readUsage, worstCase, type Mode, type Usage } from "../router/pricing.ts";
import { route, type Attempt, type RouteSuccess, type RouteTarget } from "../router/execute.ts";
import { providerKey } from "../providers/upstream.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { applyGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
import { middleOut } from "../gateway/transforms.ts";
import type { CacheMode } from "../gateway/cache.ts";
import { bearer, requireRole, resolveKey, walletAuth, type KeyRow } from "./auth.ts";
import { clientIp, readJson } from "./common.ts";
import { grantFor, recordDebt, type PaywithGrant } from "../pay/paywith.ts";
import { parsePaymentHeader, paymentRequired, redeemPayment, relayAuthorization } from "../pay/percall.ts";

type Kind = "chat" | "completion";
type Billing =
  | { mode: "prepaid"; accountId: string; key: KeyRow }
  | { mode: "paywith"; accountId: string; key: KeyRow; grant: PaywithGrant }
  | { mode: "per_call"; accountId: string; payer: string; paymentTx?: string; key?: undefined };

const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
// Parameters that change what a provider must be able to do; never silently dropped.
const SEMANTIC_PARAMS = ["tools", "tool_choice", "response_format", "structured_outputs", "reasoning", "include_reasoning", "logprobs", "top_logprobs", "seed", "max_tokens", "temperature", "top_p", "stop", "frequency_penalty", "presence_penalty", "top_k", "repetition_penalty", "min_p", "logit_bias", "parallel_tool_calls"];
const MUST_SUPPORT = ["tools", "response_format"];

function validate(kind: Kind, body: Record<string, unknown>) {
  if (kind === "chat") {
    if (!Array.isArray(body.messages) || body.messages.length === 0) fail(400, "`messages` must be a non-empty array.", "invalid_request");
    for (const m of body.messages as any[]) {
      if (!m || typeof m !== "object" || !ROLES.has(m.role)) fail(400, `Invalid message role: ${JSON.stringify(m?.role)}.`, "invalid_request");
      if (m.content != null && typeof m.content !== "string" && !Array.isArray(m.content)) fail(400, "Message content must be a string or an array of parts.", "invalid_request");
    }
  } else if (typeof body.prompt !== "string" && !Array.isArray(body.prompt)) fail(400, "`prompt` must be a string.", "invalid_request");
  if (body.model != null && typeof body.model !== "string") fail(400, "`model` must be a string.", "invalid_request");
  if (body.models != null && (!Array.isArray(body.models) || body.models.some((m) => typeof m !== "string"))) fail(400, "`models` must be an array of model ids.", "invalid_request");
  if (body.provider != null && (typeof body.provider !== "object" || Array.isArray(body.provider))) fail(400, "`provider` must be an object.", "invalid_request");
  for (const k of ["max_tokens", "max_completion_tokens"]) if (body[k] != null && (!Number.isInteger(body[k]) || (body[k] as number) < 1)) fail(400, `\`${k}\` must be a positive integer.`, "invalid_request");
  for (const k of ["n", "best_of"]) if (body[k] != null && (!Number.isInteger(body[k]) || (body[k] as number) < 1 || (body[k] as number) > 16)) fail(400, `\`${k}\` must be an integer from 1 to 16.`, "invalid_request");
}

function requestParams(body: Record<string, unknown>) {
  return SEMANTIC_PARAMS.filter((p) => body[p] !== undefined && body[p] !== null && !(Array.isArray(body[p]) && (body[p] as unknown[]).length === 0));
}

/** Body hash that binds a 402 quote to one request (stream flags excluded). */
export function requestHash(body: Record<string, unknown>) {
  const { stream: _s, stream_options: _so, ...rest } = body;
  return sha256(canonicalJson(rest));
}

async function limitOrThrow(ctx: Ctx, key: string, amount: number, limit: number, what: string) {
  const r = await ctx.limiter.take(key, amount, limit, 60_000);
  if (!r.ok)
    fail(429, `Rate limit exceeded (${limit} ${what}/min). Retry in ${Math.ceil(r.retryAfterMs / 1000)}s.`, "rate_limited", { retry_after_ms: r.retryAfterMs }, { "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) });
}

async function byokFor(ctx: Ctx, accountId: string | undefined) {
  const map = new Map<string, string>();
  if (!accountId) return map;
  const rows = await ctx.db.select().from(byokKeys).where(eq(byokKeys.accountId, accountId));
  for (const r of rows) {
    try {
      map.set(r.providerId, decrypt(ctx.cfg.appSecret, r.keyEnc));
    } catch {
      log.warn("undecryptable BYOK key", { provider: r.providerId });
    }
  }
  return map;
}

function chunkBase(id: string, created: number, model: ModelRow, provider: string, kind: Kind) {
  return { id, object: kind === "chat" ? "chat.completion.chunk" : "text_completion", created, model: model.id, provider };
}

export function chatRoutes(app: Hono, ctx: Ctx) {
  app.post("/api/v1/chat/completions", (c) => handle(ctx, c, "chat"));
  app.post("/api/v1/completions", (c) => handle(ctx, c, "completion"));
  // OpenAI-SDK style base URLs (…/api/v1) already covered; also accept /v1/* for convenience.
  app.post("/v1/chat/completions", (c) => handle(ctx, c, "chat"));
  app.post("/v1/completions", (c) => handle(ctx, c, "completion"));
}
