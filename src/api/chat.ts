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
import { applyGuardrails, mergeGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
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

function validateCacheTtl(body: Record<string, unknown>, maxTtlS: number) {
  if (body.cache == null) return;
  if (typeof body.cache !== "object" || Array.isArray(body.cache)) fail(400, "`cache` must be an object.", "invalid_request");
  const cache = body.cache as Record<string, unknown>;
  if (!Object.hasOwn(cache, "ttl")) return;
  const ttl = cache.ttl;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 1)
    fail(400, "`cache.ttl` must be a positive integer number of seconds.", "invalid_request");
  if (ttl > maxTtlS) fail(400, `\`cache.ttl\` cannot exceed the configured maximum of ${maxTtlS} seconds.`, "invalid_request");
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

async function handle(ctx: Ctx, c: Context, kind: Kind): Promise<Response> {
  const t0 = Date.now();
  const body = await readJson(c);
  validate(kind, body);
  validateCacheTtl(body, ctx.cfg.gateway.cacheTtlS);
  const stream = body.stream === true;
  const bodySha = requestHash(body);

  // ---- 1. Who is calling -------------------------------------------------------------------
  const secret = bearer(c.req.header("authorization"));
  let key: KeyRow | null = null;
  let wallet: { accountId: string; wallet: string; exists: boolean } | null = null;
  if (secret) {
    key = await resolveKey(ctx, secret);
    if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDG to its key hash first.", "invalid_key");
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    await limitOrThrow(ctx, `k:${key.keyHash}`, 1, key.rpm ?? ctx.cfg.limits.defaultRpm, "requests");
  } else {
    await limitOrThrow(ctx, `ip:${clientIp(c, ctx.cfg.trustProxy)}`, 1, ctx.cfg.limits.unauthRpm, "requests");
    const wa = c.req.header("x-wallet-auth");
    if (wa) wallet = await walletAuth(ctx, wa, bodySha);
  }

  // ---- 2. Key presets, model resolution, guardrails, transforms --------------------------------
  const routing = (key?.routing ?? null) as { aliases?: Record<string, { model: string; provider?: ProviderPrefs; models?: string[] }>; provider?: ProviderPrefs } | null;
  const alias = typeof body.model === "string" ? routing?.aliases?.[body.model] : undefined;
  if (alias) {
    body.model = alias.model;
    if (alias.models && !body.models) body.models = alias.models;
    body.provider = { ...(alias.provider ?? {}), ...((body.provider as object) ?? {}) };
  }
  if (routing?.provider) body.provider = { ...routing.provider, ...((body.provider as object) ?? {}) };
  const prefs = (body.provider ?? {}) as ProviderPrefs;

  const modelIds = [...new Set([...(typeof body.model === "string" ? [body.model] : []), ...((body.models as string[] | undefined) ?? [])])];
  if (!modelIds.length) fail(400, "`model` is required (e.g. \"meta-llama/llama-3.3-70b-instruct\").", "invalid_request");
  await ctx.catalog.ensureFresh();
  const resolved: { model: ModelRow; modifiers: Set<Modifier>; requested: string }[] = [];
  for (const id of modelIds) {
    const r = ctx.catalog.resolve(id);
    if (!r) continue;
    if (key?.allowedModels?.length && !key.allowedModels.includes(r.model.id)) continue;
    resolved.push({ ...r, requested: id });
  }
  if (!resolved.length)
    fail(
      key?.allowedModels?.length ? 403 : 404,
      key?.allowedModels?.length ? `This key may only use: ${key.allowedModels.join(", ")}.` : `Model ${modelIds[0]} is not available. See GET /api/v1/models.`,
      key?.allowedModels?.length ? "model_not_allowed" : "model_not_found",
    );

  // Request-level guardrails only for authenticated keys; a key's own guardrails always apply.
  const guardCfg = mergeGuardrails(key?.guardrails as GuardrailConfig | null, key ? body.guardrails as GuardrailConfig | undefined : undefined);
  const guard = applyGuardrails(body, guardCfg);
  if (stream && guardCfg?.redact_output) fail(400, "Output redaction requires a non-streaming response.", "invalid_guardrails");

  const transforms = Array.isArray(body.transforms) ? (body.transforms as string[]) : [];
  const primary = resolved[0].model;
  let middle: { removed: number; truncated: number } | null = null;
  if (transforms.includes("middle-out") && kind === "chat") {
    const reserveOut = Number(body.max_tokens ?? body.max_completion_tokens ?? Math.min(4096, Math.floor(primary.ctx / 4)));
    middle = middleOut(body, primary.ctx, reserveOut);
  }
  const promptTokens = estimatePromptTokens(body);

  // ---- 3. Accounts: key, pay-with, wallet change, per-call payment -------------------------------
  const paySymbol = c.req.header("x-pay-with") ?? (key?.payWithDefault || undefined);
  let billing: Billing | null = null;
  let paywithNote: string | undefined;
  if (key) {
    billing = { mode: "prepaid", accountId: key.accountId, key };
    if (paySymbol) {
      const { grant, reason } = await grantFor(ctx, key, paySymbol);
      if (grant) billing = { mode: "paywith", accountId: key.accountId, key, grant };
      else paywithNote = reason; // falls back to prepaid USDG (then 402 if empty)
    }
  } else if (wallet) {
    billing = { mode: "per_call", accountId: wallet.accountId, payer: wallet.wallet };
  }

  // ---- 4. Cache (opt-in, never across accounts, keys, policies or end users) ----------------------
  const cacheSpec = (body.cache as { mode?: CacheMode; ttl?: number } | undefined) ?? (c.req.header("x-anyroute-cache") ? { mode: c.req.header("x-anyroute-cache") as CacheMode } : undefined);
  const cacheMode: CacheMode | null = cacheSpec?.mode === "exact" || cacheSpec?.mode === "semantic" ? cacheSpec.mode : null;
  // `user` is forwarded to the provider as the end-user identity; a response made for one end user
  // must never be replayed to another behind the same key (exact or semantic).
  const cacheScope = billing ? `${billing.accountId}:policy-v3:${sha256(canonicalJson({ key: key?.keyHash ?? null, user: body.user ?? null, guardrails: guardCfg, provider: prefs, kind, models: resolved.map((r) => ({ id: r.model.id, modifiers: [...r.modifiers].sort() })) }))}` : "";
  if (cacheMode && billing && !stream) {
    const hit = await ctx.cache.get(cacheMode, cacheScope, body, ctx.cfg.gateway.semanticThreshold);
    if (hit) return cachedResponse(ctx, c, { body, hit, billing, model: primary, t0, bodySha });
  }

  // ---- 5. Provider selection ------------------------------------------------------------------
  const byok = await byokFor(ctx, billing?.accountId);
  const params = requestParams(body);
  const targets: RouteTarget[] = [];
  const excluded: { model: string; provider: string; reason: string }[] = [];
  for (const r of resolved) {
    const sel = selectProviders({
      modelId: r.model.id,
      offers: ctx.catalog.offers(r.model.id),
      prefs,
      modifiers: r.modifiers,
      requestParams: params,
      estimatedTokens: promptTokens,
      byokProviders: new Set(byok.keys()),
      health: ctx.health,
      production: ctx.cfg.production,
      attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
      rand: ctx.rand,
    });
    // Tools / structured output must be supported by whoever serves the request.
    const must = MUST_SUPPORT.filter((p) => params.includes(p));
    let ordered = sel.ordered.filter((cand) => {
      const sp = cand.supportedParameters ?? [];
      const ok = !must.length || !sp.length || must.every((p) => sp.includes(p));
      if (!ok) excluded.push({ model: r.model.id, provider: cand.providerId, reason: `does not support ${must.join("/")}` });
      return ok;
    });
    // BYOK providers go first unless the caller pinned an order.
    if (!prefs.order?.length && byok.size) ordered = [...ordered.filter((x) => byok.has(x.providerId)), ...ordered.filter((x) => !byok.has(x.providerId))];
    for (const e of sel.excluded) excluded.push({ model: r.model.id, ...e });
    if (ordered.length) targets.push({ model: r.model, ordered });
  }
  if (!targets.length)
    fail(404, "No providers match this request's model and routing preferences.", "no_providers", { excluded: excluded.slice(0, 50) });

  // ---- 6. Hold the worst case --------------------------------------------------------------------
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const modeForPrice: Mode = billing?.mode ?? "per_call";
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  const hold = maxPico(...attemptable.map(({ cand, model }) => worstCase(cand, model, body, promptTokens, modeForPrice, fees, byok.has(cand.providerId))));

  if (!billing) {
    const pay = c.req.header("x-payment");
    if (!pay) await paymentRequired(ctx, { pricePico: hold, bodySha, modelId: primary.id });
    const header = parsePaymentHeader(pay!);
    const txHash = header.kind === "tx" ? header.hash : await relayAuthorization(ctx, header.auth);
    const r = await redeemPayment(ctx, txHash, bodySha, ctx.cfg.fees.paymentWaitMs);
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash };
  }
  if (billing.key?.tpm) await limitOrThrow(ctx, `kt:${billing.key.keyHash}`, promptTokens, billing.key.tpm, "tokens");

  const holdId = genId();
  try {
    await reserve(ctx.db, {
      id: holdId,
      accountId: billing.accountId,
      keyHash: billing.key?.keyHash ?? null,
      amount: hold,
      kind: "usage",
      ttlMs: ctx.cfg.routing.providerTimeoutMs * (ctx.cfg.routing.maxAttempts + 1),
      creditLine: billing.mode === "paywith" ? billing.grant.creditLine : 0n,
    });
  } catch (e) {
    if (isApiError(e) && e.type === "insufficient_credits" && paywithNote) e.metadata = { ...e.metadata, pay_with: paywithNote };
    throw e;
  }

  // ---- 7. Route ---------------------------------------------------------------------------------
  const abort = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const keyFor = (cand: Candidate) => providerKey(cand, ctx.cfg.appSecret, byok.get(cand.providerId));
  const path = kind === "chat" ? ("/chat/completions" as const) : ("/completions" as const);
  const meta = { guard, middle, paywithNote, cacheMode, excluded };
  const common = { ctx, c, body, billing, holdId, t0, bodySha, stream, kind, byok, meta, guardCfg, promptTokens };

  if (stream) return streamResponse({ ...common, run: () => route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: true, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16) }), abort });

  let result: Awaited<ReturnType<typeof route>>;
  try {
    result = await route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: false, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16) });
  } catch (e) {
    await release(ctx.db, holdId);
    throw e;
  }
  if (!result.ok) {
    await release(ctx.db, holdId);
    throw allFailed(result.attempts, result.last);
  }
  const r = result as Extract<RouteSuccess, { kind: "json" }>;
  const json = r.json;
  const usage = readUsage(json.usage, { prompt: promptTokens, completion: Math.ceil(JSON.stringify(json.choices ?? []).length / 4) });
  const redactions = guardCfg?.redact_output ? redactOutput(json) : 0;
  const responseText = (json.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : ch?.text ?? "")).join("");
  const fin = await finalize({ ...common, r, usage, responseText, finishReason: json.choices?.[0]?.finish_reason ?? null, nativeFinish: json.choices?.[0]?.native_finish_reason ?? json.choices?.[0]?.finish_reason ?? null, generationMs: Date.now() - t0, cancelled: false });
  const out = {
    ...json,
    id: fin.id,
    model: r.model.id,
    provider: r.candidate.provider.name,
    object: kind === "chat" ? "chat.completion" : "text_completion",
    usage: fin.usageJson,
    receipt: fin.receiptJson,
    ...(fin.extras(redactions) ?? {}),
  };
  if (cacheMode && !stream) await ctx.cache.put(cacheMode, cacheScope, body, out, fin.upstream, (body.cache as { ttl?: number } | undefined)?.ttl ?? ctx.cfg.gateway.cacheTtlS);
  return c.json(out, 200, { "x-generation-id": fin.id });
}

function allFailed(attempts: Attempt[], last?: { status?: number; errorKind: string; message: string }): ApiError {
  const allRejected = attempts.length > 0 && attempts.every((a) => a.error_kind === "rejected");
  const status = allRejected ? (last?.status && last.status >= 400 && last.status < 500 ? last.status : 400) : 502;
  return new ApiError(
    status,
    allRejected ? `Provider rejected the request: ${last?.message ?? "invalid request"}` : "All providers for this request failed. Nothing was charged.",
    allRejected ? "provider_rejected" : "providers_unavailable",
    { attempts: attempts.map(({ message, ...a }) => ({ ...a, message: message?.slice(0, 200) })) },
  );
}

type Common = {
  ctx: Ctx;
  c: Context;
  body: Record<string, unknown>;
  billing: Billing;
  holdId: string;
  t0: number;
  bodySha: string;
  stream: boolean;
  kind: Kind;
  byok: Map<string, string>;
  meta: { guard: ReturnType<typeof applyGuardrails>; middle: { removed: number; truncated: number } | null; paywithNote?: string; cacheMode: CacheMode | null; excluded: unknown[] };
  guardCfg: GuardrailConfig | null;
  promptTokens: number;
};

async function finalize(
  p: Common & {
    r: RouteSuccess;
    usage: Usage;
    responseText: string;
    finishReason: string | null;
    nativeFinish: string | null;
    generationMs: number;
    cancelled: boolean;
  },
) {
  const { ctx, billing, r } = p;
  const isByok = p.byok.has(r.candidate.providerId);
  const mode: Mode = isByok ? "byok" : billing.mode;
  const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const cost = priceUsage(r.candidate, r.model, p.usage, billing.mode === "per_call" ? "per_call" : mode, fees, isByok);
  const id = p.holdId;
  const settled = await settle(ctx.db, p.holdId, cost.total, {
    description: `${r.model.id} via ${r.candidate.providerId}`,
    generationId: id,
    creditLine: billing.mode === "paywith" ? billing.grant.creditLine : 0n,
  });
  const charged = settled.charged;

  // Pay-with: record the debt and an estimate of the share fraction it will cost.
  let paidWith: Record<string, unknown> | null = null;
  if (billing.mode === "paywith") {
    const raw = await recordDebt(ctx, { key: billing.key, generationId: id, amount: charged, grant: billing.grant });
    paidWith = { token: billing.grant.symbol, token_address: billing.grant.token, raw_units: raw?.toString() ?? "0", fair_price: billing.grant.fairPrice18.toString(), swap_tx: null, status: "accrued" };
  }

  const attestation = r.candidate.provider.attested && r.candidate.provider.attestationHash ? r.candidate.provider.attestationHash : null;
  const privateRoute = (p.body.provider as ProviderPrefs | undefined)?.private === true || String(p.body.model ?? "").includes(":private");
  const payer = billing.key ? billing.key.chainKeyHash : billing.mode === "per_call" ? billing.payer : null;
  const payload = {
    v: 1,
    id,
    issued: new Date().toISOString(),
    router: ctx.cfg.publicUrl,
    model: r.model.id,
    provider: r.candidate.providerId,
    tokens: { prompt: p.usage.prompt, completion: p.usage.completion, reasoning: p.usage.reasoning, cached: p.usage.cachedRead, estimated: p.usage.estimated },
    cost: picoToUsdString(charged),
    cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin) },
    paid_with: paidWith,
    latency_ms: Math.round(r.latencyMs),
    generation_ms: p.generationMs,
    quant: r.candidate.quant,
    mode,
    private: privateRoute,
    attestation,
    payer,
    payment_tx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    request_sha256: p.bodySha,
    response_sha256: sha256(p.responseText),
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);

  const referer = p.c.req.header("http-referer") ?? p.c.req.header("referer");
  const title = p.c.req.header("x-title");
  let appId: string | null = null;
  if (referer || title) {
    appId = sha256((referer ?? "") + "|" + (title ?? "")).slice(0, 24);
    await ctx.db.insert(apps).values({ id: appId, url: referer?.slice(0, 500) ?? null, title: title?.slice(0, 200) ?? null }).onConflictDoNothing();
  }

  const tps = p.usage.completion > 0 && p.generationMs > r.latencyMs ? p.usage.completion / ((p.generationMs - r.latencyMs) / 1000) : null;
  ctx.health.record({ modelId: r.candidate.modelId, providerId: r.candidate.providerId, ok: true, latencyMs: r.latencyMs, tps, source: "traffic" });

  await ctx.db.insert(generations).values({
    id,
    keyHash: billing.key?.keyHash ?? null,
    accountId: billing.accountId,
    modelId: r.model.id,
    providerId: r.candidate.providerId,
    tokensIn: p.usage.prompt,
    tokensOut: p.usage.completion,
    reasoningTokens: p.usage.reasoning,
    cachedTokens: p.usage.cachedRead,
    cacheWriteTokens: p.usage.cacheWrite,
    cost: charged,
    upstreamCost: cost.upstream,
    royalty: cost.royalty,
    margin: cost.margin,
    cacheDiscount: cost.cacheDiscount,
    mode,
    latencyMs: Math.round(r.latencyMs),
    generationTimeMs: p.generationMs,
    finishReason: p.finishReason,
    nativeFinishReason: p.nativeFinish,
    streamed: p.stream,
    cancelled: p.cancelled,
    quant: r.candidate.quant,
    dataRegion: r.candidate.provider.datacenter?.[0] ?? null,
    isByok,
    private: privateRoute,
    attestationHash: attestation,
    receiptId: id,
    receiptSig: signed.sig,
    receiptKeyId: signed.keyId,
    receipt: payload,
    receiptLeaf: leaf,
    paidWith,
    paymentTx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    appId,
    attempts: r.attempts,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
  });

  ctx.telemetry.span("chat " + r.model.id, p.t0, Date.now(), {
    "gen_ai.system": r.candidate.providerId,
    "gen_ai.operation.name": p.kind === "chat" ? "chat" : "text_completion",
    "gen_ai.request.model": String(p.body.model ?? r.model.id),
    "gen_ai.response.model": r.model.id,
    "gen_ai.usage.input_tokens": p.usage.prompt,
    "gen_ai.usage.output_tokens": p.usage.completion,
    "anyroute.generation_id": id,
    "anyroute.provider": r.candidate.providerId,
    "anyroute.mode": mode,
    "anyroute.cost_usd": picoToUsd(charged),
    "anyroute.attempts": r.attempts.length,
    "anyroute.streamed": p.stream,
  }, undefined, p.c.req.header("traceparent")?.split("-")[1]);

  const usageJson = {
    prompt_tokens: p.usage.prompt,
    completion_tokens: p.usage.completion,
    total_tokens: p.usage.prompt + p.usage.completion,
    cost: picoToUsd(charged),
    is_byok: isByok,
    cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty), margin: picoToUsd(cost.margin) },
    prompt_tokens_details: { cached_tokens: p.usage.cachedRead, cache_write_tokens: p.usage.cacheWrite },
    completion_tokens_details: { reasoning_tokens: p.usage.reasoning },
  };
  const receiptJson = {
    id,
    sig: signed.sig,
    key_id: signed.keyId,
    alg: "Ed25519",
    payload,
    leaf,
    anchor_hint: `Anchored on chain ${ctx.cfg.chain.id} within the hour; GET /api/v1/generation?id=${id} returns the merkle proof.`,
    ...(paidWith ? { paid_with: paidWith } : {}),
  };
  return {
    id,
    upstream: cost.upstream,
    usageJson,
    receiptJson,
    extras: (redactions: number) => {
      const x: Record<string, unknown> = {};
      if (p.meta.guard || redactions) x.guardrails = { ...(p.meta.guard ?? {}), output_redactions: redactions };
      if (p.meta.middle && (p.meta.middle.removed || p.meta.middle.truncated)) x.transforms = { "middle-out": p.meta.middle };
      if (p.meta.paywithNote) x.pay_with_fallback = p.meta.paywithNote;
      if (r.dropped.length) x.dropped_parameters = r.dropped;
      return Object.keys(x).length ? x : null;
    },
  };
}

function streamResponse(p: Common & { run: () => ReturnType<typeof route>; abort: AbortController }): Response {
  const { ctx, kind } = p;
  const enc = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const event = (obj: unknown) => send(`data: ${JSON.stringify(obj)}\n\n`);
      send(": ANYROUTE PROCESSING\n\n");
      const keepalive = setInterval(() => send(": ANYROUTE PROCESSING\n\n"), 5_000);
      let result: Awaited<ReturnType<typeof route>> | null = null;
      try {
        result = await p.run();
      } catch (e) {
        clearInterval(keepalive);
        await release(ctx.db, p.holdId);
        if (!p.abort.signal.aborted) event({ error: { code: 502, message: (e as Error).message, type: "router_error" } });
        send("data: [DONE]\n\n");
        closed = true;
        controller.close();
        return;
      }
      clearInterval(keepalive);
      if (!result.ok) {
        await release(ctx.db, p.holdId);
        const err = allFailed(result.attempts, result.last);
        event(err.toJSON());
        send("data: [DONE]\n\n");
        closed = true;
        controller.close();
        return;
      }
      const r = result as Extract<RouteSuccess, { kind: "stream" }>;
      const base = chunkBase(p.holdId, created, r.model, r.candidate.provider.name, kind);
      let text = "";
      let reasoningText = ""; // billed when usage never arrives (e.g. the client cancels mid-stream)
      let toolText = "";
      let finish: string | null = null;
      let nativeFinish: string | null = null;
      let providerUsage: any = null;
      let cancelled = false;
      let midError: string | null = null;
      const emit = (ev: any) => {
        if (ev?.usage) providerUsage = ev.usage;
        const choices = Array.isArray(ev?.choices) ? ev.choices : [];
        for (const ch of choices) {
          const d = ch?.delta ?? {};
          if (typeof d.content === "string") text += d.content;
          if (typeof ch?.text === "string") text += ch.text;
          if (typeof d.reasoning === "string") reasoningText += d.reasoning;
          if (typeof d.reasoning_content === "string") reasoningText += d.reasoning_content;
          if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) toolText += String(tc?.function?.arguments ?? "") + String(tc?.function?.name ?? "");
          if (ch?.finish_reason) {
            finish = ch.finish_reason;
            nativeFinish = ch.native_finish_reason ?? ch.finish_reason;
          }
        }
        if (!choices.length && ev?.usage) return; // usage-only chunk: we send our own at the end
        const { usage: _u, id: _i, model: _m, created: _c, object: _o, ...rest } = ev ?? {};
        event({ ...base, ...rest, choices });
      };
      try {
        for (const ev of r.buffered) emit(ev);
        for await (const ev of r.rest) {
          if (ev?.error) {
            midError = String(ev.error?.message ?? "provider error");
            event({ ...base, error: { code: 502, message: midError, type: "provider_error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
            break;
          }
          emit(ev);
        }
      } catch (e) {
        if (p.abort.signal.aborted) cancelled = true;
        else {
          midError = (e as Error).message;
          event({ ...base, error: { code: 502, message: "Provider stream was interrupted.", type: "provider_interrupted" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
        }
      }
      try {
        const reasoningEst = Math.ceil(reasoningText.length / 4);
        const usage = readUsage(providerUsage, { prompt: p.promptTokens, completion: Math.ceil((text.length + toolText.length) / 4) + reasoningEst });
        if (!providerUsage) usage.reasoning = reasoningEst;
        const fin = await finalize({ ...p, r, usage, responseText: text, finishReason: finish ?? (cancelled ? "cancelled" : midError ? "error" : null), nativeFinish, generationMs: Date.now() - p.t0, cancelled });
        event({ ...base, choices: [], usage: fin.usageJson, receipt: fin.receiptJson, ...(fin.extras(0) ?? {}) });
      } catch (e) {
        log.error("stream finalize failed", { error: (e as Error).message, hold: p.holdId });
        await release(ctx.db, p.holdId).catch(() => undefined);
      }
      send("data: [DONE]\n\n");
      closed = true;
      try {
        controller.close();
      } catch {
        /* client gone */
      }
    },
    cancel() {
      closed = true;
      p.abort.abort(new DOMException("client disconnected", "AbortError"));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-generation-id": p.holdId, "x-accel-buffering": "no" },
  });
}

async function cachedResponse(ctx: Ctx, c: Context, p: { body: Record<string, unknown>; hit: { response: any; upstream: bigint; similarity: number }; billing: Billing; model: ModelRow; t0: number; bodySha: string }) {
  const id = genId();
  const payload = {
    v: 1,
    id,
    issued: new Date().toISOString(),
    router: ctx.cfg.publicUrl,
    model: p.model.id,
    provider: "cache",
    tokens: { prompt: 0, completion: 0, reasoning: 0, cached: 0, estimated: false },
    cost: "0",
    cost_details: { upstream: "0", royalty: "0", margin: "0" },
    paid_with: null,
    latency_ms: Date.now() - p.t0,
    mode: "cache",
    cache: { similarity: Number(p.hit.similarity.toFixed(4)), original: p.hit.response?.id ?? null },
    payer: p.billing.key?.chainKeyHash ?? (p.billing.mode === "per_call" ? p.billing.payer : null),
    request_sha256: p.bodySha,
    response_sha256: sha256((p.hit.response?.choices ?? []).map((ch: any) => ch?.message?.content ?? "").join("")),
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);
  await ctx.db.insert(generations).values({
    id,
    keyHash: p.billing.key?.keyHash ?? null,
    accountId: p.billing.accountId,
    modelId: p.model.id,
    providerId: "cache",
    mode: "cache",
    cost: 0n,
    cacheDiscount: p.hit.upstream,
    latencyMs: Date.now() - p.t0,
    generationTimeMs: Date.now() - p.t0,
    receiptId: id,
    receiptSig: signed.sig,
    receiptKeyId: signed.keyId,
    receipt: payload,
    receiptLeaf: leaf,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
    finishReason: p.hit.response?.choices?.[0]?.finish_reason ?? null,
  });
  return c.json(
    {
      ...p.hit.response,
      id,
      cached: true,
      usage: { ...(p.hit.response?.usage ?? {}), cost: 0, cost_details: { upstream_inference_cost: 0, royalty: 0, margin: 0, cache_savings: picoToUsd(p.hit.upstream) } },
      receipt: { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload, leaf },
    },
    200,
    { "x-generation-id": id, "x-anyroute-cache": "hit" },
  );
}

export { canonical };
