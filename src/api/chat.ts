import { linkNetworkReceipt } from "../network/receipt-link.ts";
import { agentReservation, enforceAgentCached } from "../agents/enforce.ts";
import { blindReceipt } from "../blind/set.ts";
import type { Context, Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { apps, byokKeys, generations, savedRoutes } from "../db/schema.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { ApiError, fail, isApiError } from "../lib/errors.ts";
import { type Pico, maxPico, picoToUsd, picoToUsdString, usdToPico } from "../lib/money.ts";
import { canonical, canonicalJson, decrypt, genId, log, sha256 } from "../lib/util.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { isRestricted } from "../router/lane.ts";
import { disclosureClass, disclosureRefusal, profileOf, type DisclosureClass, type DisclosureRequest } from "../router/disclosure.ts";
import { servedDisclosure, servedPolicyHash } from "./disclosure.ts";
import { batchHold, batchPrice, estimatePromptTokens, maxOutputTokens, priceUsage, readUsage, worstCase, type Mode, type Usage } from "../router/pricing.ts";
import { batchKey, batchLineOf } from "../router/batch-line.ts";
import { route, type Attempt, type RouteSuccess, type RouteTarget } from "../router/execute.ts";
import { providerKey } from "../providers/upstream.ts";
import { compactUpstream, recordGpuAttested, unverifiedUpstream, verifyAciExchange, type UpstreamAttestation } from "../providers/aci.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { buildClaimsV2, chainComment, ChunkChain, COSE_CONTENT_TYPE } from "../receipts/v2.ts";
import { applyGuardrails, mergeGuardrails, redactOutput, type GuardrailConfig } from "../gateway/guardrails.ts";
import { middleOut } from "../gateway/transforms.ts";
import type { CacheMode } from "../gateway/cache.ts";
import { bearer, requireRole, resolveKey, walletAuth, type KeyRow } from "./auth.ts";
import { addressBucket, generationHeaders, readJson, sharedPolicyHash } from "./common.ts";
import { grantFor, recordDebt, type PaywithGrant } from "../pay/paywith.ts";
import { resolveSavedRoute } from "../routing/saved-routes.ts";
import { resolvePreset } from "../routing/presets.ts";
import { recordCharacterUse, resolveCharacter, type CharacterMeta } from "../characters/registry.ts";
import { payPerCall } from "../pay/percall.ts";
import { holderTier, scaleLimit, walletOfAccount } from "../holders/tiers.ts";
import type { HolderTier } from "../config.ts";
import { COUNCIL_MODEL, applyDualDecoding, runCouncil, runDual, validateMulti } from "./council.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { requestLane } from "../ohttp/lane.ts";
import { blockReasonForStatus, isPrivateLaneRequest, noteLane, recordPrivateLane } from "../services/private-stats.ts";
import { parseTraceparent, shouldExportTrace } from "../services/tracing.ts";
import { BLIND_POOL, claimToken, confirmToken, isBlindRequest, presentBlindToken, redemptionSummary, requireValue, unclaimToken, type BlindPass } from "../blind/redeem.ts";

export type Kind = "chat" | "completion";
export type Billing =
  | { mode: "prepaid"; accountId: string; key: KeyRow }
  | { mode: "paywith"; accountId: string; key: KeyRow; grant: PaywithGrant }
  | { mode: "per_call"; accountId: string; payer: string; paymentTx?: string; paymentResponse?: string; key?: undefined }
  // A Privacy Pass token, charged to the pooled internal account: no key, no wallet, no buyer. `hold` is set once known.
  | { mode: "blind"; accountId: string; pass: BlindPass; hold: Pico; key?: undefined };

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

/** Who pays: the key's prepaid balance, a Stock Token pay-with grant, or (no key) a wallet / per-call payment. */
async function resolveBilling(ctx: Ctx, c: Context, key: KeyRow | null, wallet: { accountId: string; wallet: string } | null, pass: BlindPass | null): Promise<{ billing: Billing | null; paywithNote?: string }> {
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
  } else if (pass) {
    billing = { mode: "blind", accountId: BLIND_POOL, pass, hold: 0n };
  } else if (wallet) {
    billing = { mode: "per_call", accountId: wallet.accountId, payer: wallet.wallet };
  }
  return { billing, paywithNote };
}

/**
 * Providers able to serve each resolved model under the caller's routing preferences, in routing order.
 * Shared by single calls, council members and the judge, and dual-verification legs, so all of them honour a
 * disclosure ceiling or lane the same way: a request whose ceiling leaves no provider is refused (409, or 503
 * while compliant providers are down) and is never routed to one that does not meet it.
 */
function selectTargets(
  ctx: Ctx,
  o: { resolved: { model: ModelRow; modifiers: Set<Modifier> }[]; prefs: ProviderPrefs; params: string[]; promptTokens: number; byok: Map<string, string>; disc: DisclosureRequest },
) {
  const { resolved, prefs, params, promptTokens, byok, disc } = o;
  const strict = disc.max !== "any";
  const targets: RouteTarget[] = [];
  const excluded: { model: string; provider: string; reason: string }[] = [];
  const plan = (r: (typeof resolved)[number], p: ProviderPrefs) => {
    const sel = selectProviders({
      modelId: r.model.id,
      offers: ctx.catalog.offers(r.model.id),
      prefs: p,
      modifiers: r.modifiers,
      requestParams: params,
      estimatedTokens: promptTokens,
      byokProviders: new Set(byok.keys()),
      health: ctx.health,
      production: ctx.cfg.production,
      attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
      disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)),
      modelLane: ctx.catalog.laneOf(r.model),
      attestedBonus: ctx.cfg.routing.attestedBonus,
      rand: ctx.rand,
    });
    // Tools / structured output must be supported by whoever serves the request.
    const must = MUST_SUPPORT.filter((q) => params.includes(q));
    const notes: { model: string; provider: string; reason: string }[] = [];
    let ordered = sel.ordered.filter((cand) => {
      const sp = cand.supportedParameters ?? [];
      const ok = !must.length || !sp.length || must.every((q) => sp.includes(q));
      if (!ok) notes.push({ model: r.model.id, provider: cand.providerId, reason: `does not support ${must.join("/")}` });
      return ok;
    });
    // BYOK providers go first unless the caller pinned an order.
    if (!p.order?.length && byok.size) ordered = [...ordered.filter((x) => byok.has(x.providerId)), ...ordered.filter((x) => !byok.has(x.providerId))];
    for (const e of sel.excluded) notes.push({ model: r.model.id, ...e });
    return { ordered, notes };
  };
  for (const r of resolved) {
    const { ordered, notes } = plan(r, prefs);
    excluded.push(...notes);
    if (ordered.length) targets.push({ model: r.model, ordered });
  }
  if (!targets.length && strict) {
    // Would anything have matched without the disclosure ceiling? Then the ceiling is what blocked this request:
    // say so (409, or 503 when compliant providers exist but are down), and never fall back to one that does not meet it.
    const { disclosure: _d, lane: _l, ...relaxed } = prefs;
    const refusal = disclosureRefusal(disc, resolved.map((r) => r.model.id), excluded, () => resolved.some((r) => plan(r, relaxed).ordered.length > 0));
    if (refusal) throw refusal;
  }
  return { targets, excluded };
}

/** Undo a hold whose request was not served. A blind token is given back with it, so a failed request does not cost the token. */
async function giveBack(ctx: Ctx, billing: Billing, holdId: string) {
  await release(ctx.db, holdId);
  if (billing.mode === "blind") await unclaimToken(ctx, billing.pass);
}

/** x402: the settlement receipt rides on the served response. */
const paymentHeaders = (b: Billing): Record<string, string> => (b.mode === "per_call" && b.paymentResponse ? { "x-payment-response": b.paymentResponse } : {});

function chunkBase(id: string, created: number, model: ModelRow, provider: string, kind: Kind) {
  return { id, object: kind === "chat" ? "chat.completion.chunk" : "text_completion", created, model: model.id, provider };
}

/**
 * One chat or completion call. A refused private-lane request is counted (noisily, see services/private-stats.ts) under the
 * reason it was refused. `characterId` forces a character (POST /api/v1/characters/:id/chat, src/api/characters.ts).
 */
export async function runChat(ctx: Ctx, c: Context, kind: Kind, characterId?: string): Promise<Response> {
  const t0 = Date.now();
  try {
    return await handle(ctx, c, kind, characterId);
  } catch (e) {
    if (isPrivateLaneRequest(c.req.raw)) recordPrivateLane(ctx, c.req.raw, { blocked: isApiError(e) ? blockReasonForStatus(e.status, e.type) : "upstream_error", latencyMs: Date.now() - t0 });
    throw e;
  }
}

export function chatRoutes(app: Hono, ctx: Ctx) {
  const run = (c: Context, kind: Kind) => runChat(ctx, c, kind);
  app.post("/api/v1/chat/completions", (c) => run(c, "chat"));
  app.post("/api/v1/completions", (c) => run(c, "completion"));
  // OpenAI-SDK style base URLs (…/api/v1) already covered; also accept /v1/* for convenience.
  app.post("/v1/chat/completions", (c) => run(c, "chat"));
  app.post("/v1/completions", (c) => run(c, "completion"));
}

async function handle(ctx: Ctx, c: Context, kind: Kind, characterId?: string): Promise<Response> {
  const t0 = Date.now();
  const body = await readJson(c);
  validate(kind, body);
  validateCacheTtl(body, ctx.cfg.gateway.cacheTtlS);
  validateMulti(ctx, kind, body);
  const stream = body.stream === true;
  const bodySha = requestHash(body);

  // ---- 1. Who is calling -------------------------------------------------------------------
  const secret = bearer(c.req.header("authorization"));
  // A line of a batch (POST /api/v1/batches), dispatched in process by the batch runner as the key that submitted it.
  const batchLine = batchLineOf(c);
  let key: KeyRow | null = null;
  let wallet: { accountId: string; wallet: string; exists: boolean } | null = null;
  // A verified Privacy Pass token (Authorization: PrivateToken), when ANYROUTE_FEATURE_BLIND is on.
  let pass: BlindPass | null = null;
  // $ANYR holder tier of the wallet behind this request (null unless HOLDER_TIERS is live).
  let tier: HolderTier | null = null;
  if (batchLine || secret) {
    key = batchLine ? await batchKey(ctx, batchLine.keyHash) : await resolveKey(ctx, secret!);
    if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDG to its key hash first.", "invalid_key");
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    tier = await holderTier(ctx, walletOfAccount(key.accountId));
    await limitOrThrow(ctx, `k:${key.keyHash}`, 1, scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), "requests");
  } else {
    // A token carries its own quota (one request), so token callers get their own, larger per-address limit:
    // behind a relay many strangers share an address. A request the Oblivious HTTP gateway dispatched has no client
    // address (the gateway already limited it per relay), so it has no per-address bucket here.
    // A request that came over Tor has no client address: it counts against the shared onion bucket (see addressBucket).
    if (!gatewayOrigin(c.req.raw)) {
      const from = addressBucket(c, ctx.cfg);
      if (isBlindRequest(ctx, c.req.header("authorization"))) await limitOrThrow(ctx, `blind-ip:${from.id}`, 1, from.scale(ctx.cfg.blind.redeemRpm), "requests");
      else await limitOrThrow(ctx, `ip:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), "requests");
    }
    pass = await presentBlindToken(ctx, c.req.header("authorization"));
    const wa = c.req.header("x-wallet-auth");
    if (wa && !pass) wallet = await walletAuth(ctx, wa, bodySha);
  }

  // ---- 2. Key presets, model resolution, guardrails, transforms --------------------------------
  const routing = (key?.routing ?? null) as { aliases?: Record<string, { model: string; provider?: ProviderPrefs; models?: string[] }>; provider?: ProviderPrefs } | null;
  const alias = typeof body.model === "string" ? routing?.aliases?.[body.model] : undefined;
  if (alias) {
    body.model = alias.model;
    if (alias.models && !body.models) body.models = alias.models;
    body.provider = { ...(alias.provider ?? {}), ...((body.provider as object) ?? {}) };
  }
  // Saved route (`model: "@route/<slug>"`, the caller's account only): fills in the fallback models,
  // provider prefs and default params the request leaves unset. Precedence: request > alias > route > key.
  const savedRoute = await resolveSavedRoute(ctx.db, key?.accountId ?? wallet?.accountId ?? null, body);
  // Preset (`model: "@preset/<name>[@<version>]"`): a versioned saved route that can also carry a system prompt, tools and a
  // response_format (routing/presets.ts). Same precedence and the same stricter-wins privacy settings as a saved route.
  const preset = savedRoute ? null : await resolvePreset(ctx.db, key?.accountId ?? wallet?.accountId ?? null, body, kind);
  const presetMeta = preset ? { name: preset.name, version: preset.version, hash: preset.hash } : null;
  // Character (`model: "@character/<id>"`, or POST /api/v1/characters/:id/chat): the card becomes the system prompt, assembled
  // in memory for this call only; the lane defaults to attested when the model has an attested provider (characters/registry.ts).
  const character = savedRoute || preset ? null : await resolveCharacter(ctx, c, body, key?.accountId ?? wallet?.accountId ?? null, kind, characterId);
  if (routing?.provider) body.provider = { ...routing.provider, ...((body.provider as object) ?? {}) };
  // Disclosure ceiling and lane: `provider.disclosure` / `provider.lane` and the X-Anyroute-* headers, the
  // stricter of the two winning, after the key's default and the saved route filled in what the request left unset.
  // A request naming no lane is public, except one relayed through the Oblivious HTTP gateway and paid with a blind
  // token, which defaults to unlinkable. Defaults (any, public) add nothing to `prefs`, so such requests route as before.
  // Lane "unlinkable" (OHTTP_ENABLED or UNLINKABLE_VIA_ONION): only through an independent relay or the onion service, only with a blind token and no key or wallet.
  // Checked before anything is priced or spent (ohttp/lane.ts).
  const { disclosure: _wantDisclosure, lane: _wantLane, lane_downgrade: _wantDowngrade, ...basePrefs } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
  const disc = requestLane(ctx, c, (body.provider ?? {}) as Record<string, unknown>, { hasKey: !!key, hasWallet: !!wallet || (!key && !pass && !!c.req.header("x-payment")), hasToken: !!pass });
  // Private-lane traffic (and `:private`, stored as private) is published only through noisy hourly counters.
  noteLane(c.req.raw, disc.lane !== "public" ? disc.lane : (body.provider as ProviderPrefs | undefined)?.private === true || String(body.model ?? "").includes(":private") ? "attested" : "public");
  const strict = disc.max !== "any";
  const prefs: ProviderPrefs = { ...basePrefs, ...(strict ? { disclosure: disc.max } : {}), ...(disc.lane !== "public" ? { lane: disc.lane } : {}) };

  // A blind token pays for one provider call. Council mode and dual verification make several, each with its own hold.
  if (pass && ((ctx.cfg.features.council && body.model === COUNCIL_MODEL) || body.verify != null))
    fail(400, "Council mode and dual verification make several provider calls, so they cannot be paid with a blind token. Use an API key.", "blind_unsupported");

  if (batchLine && (stream || body.verify != null || (ctx.cfg.features.council && body.model === COUNCIL_MODEL)))
    fail(400, "Batch lines cannot stream, use council mode or use dual verification.", "invalid_request");
  // Council mode (`model: "anyroute/council"`): several member calls plus a judge call, each billed and receipted.
  if (ctx.cfg.features.council && body.model === COUNCIL_MODEL) return runCouncil(toolkit, { ctx, c, kind, body, bodySha, t0, key, wallet, tier, prefs, disc });

  const modelIds = [...new Set([...(typeof body.model === "string" ? [body.model] : []), ...((body.models as string[] | undefined) ?? [])])];
  if (!modelIds.length) fail(400, "`model` is required (e.g. \"meta-llama/llama-3.3-70b-instruct\").", "invalid_request");
  await ctx.catalog.ensureFresh();
  // A key allowed `@route/<slug>` (e.g. an agent session) may use exactly that route's own models.
  const allowed = new Set(key?.allowedModels ?? []);
  if (savedRoute && allowed.has(`@route/${savedRoute}`) && key) {
    const [row] = await ctx.db.select({ config: savedRoutes.config }).from(savedRoutes).where(and(eq(savedRoutes.accountId, key.accountId), eq(savedRoutes.slug, savedRoute)));
    for (const m of ((row?.config as { models?: string[] } | undefined)?.models ?? [])) {
      const r = ctx.catalog.resolve(m);
      if (r) allowed.add(r.model.id);
    }
  }
  // Likewise a key allowed `@preset/<name>` may use the models of the preset version it resolved.
  if (preset && allowed.has(`@preset/${preset.name}`) && key)
    for (const m of preset.models) {
      const r = ctx.catalog.resolve(m);
      if (r) allowed.add(r.model.id);
    }
  const resolved: { model: ModelRow; modifiers: Set<Modifier>; requested: string }[] = [];
  for (const id of modelIds) {
    const r = ctx.catalog.resolve(id);
    if (!r) continue;
    if (allowed.size && !allowed.has(r.model.id)) continue;
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
  const { billing: resolvedBilling, paywithNote } = await resolveBilling(ctx, c, key, wallet, pass);
  let billing: Billing | null = resolvedBilling;

  // ---- 4. Cache (opt-in, never across accounts, keys, policies or end users) ----------------------
  const cacheSpec = (body.cache as { mode?: CacheMode; ttl?: number } | undefined) ?? (c.req.header("x-anyroute-cache") ? { mode: c.req.header("x-anyroute-cache") as CacheMode } : undefined);
  // The response cache keeps prompts and answers in the router, and a hit is served without any provider, so a
  // request with a disclosure ceiling never reads or writes it. Nor does a restricted variant (abliterated,
  // native_low_refusal): those are served only under attested retention, and the router must not keep their prompts.
  // Blind-token callers all share one internal account, so a cached answer would cross between strangers: never cache.
  const cacheMode: CacheMode | null = !strict && billing?.mode !== "blind" && !resolved.some((r) => isRestricted(ctx.catalog.laneOf(r.model).variant)) && (cacheSpec?.mode === "exact" || cacheSpec?.mode === "semantic") ? cacheSpec.mode : null;
  // `user` is forwarded to the provider as the end-user identity; a response made for one end user
  // must never be replayed to another behind the same key (exact or semantic).
  const cacheScope = billing ? `${billing.accountId}:policy-v3:${sha256(canonicalJson({ key: key?.keyHash ?? null, user: body.user ?? null, guardrails: guardCfg, provider: prefs, kind, models: resolved.map((r) => ({ id: r.model.id, modifiers: [...r.modifiers].sort() })), ...(savedRoute ? { route: savedRoute } : {}), ...(presetMeta ? { preset: presetMeta } : {}) }))}` : "";
  if (cacheMode && billing && !stream && body.verify == null) {
    const hit = await ctx.cache.get(cacheMode, cacheScope, body, ctx.cfg.gateway.semanticThreshold);
    if (hit) return cachedResponse(ctx, c, { body, hit, billing, model: primary, t0, bodySha, disc });
  }

  // ---- 5. Provider selection ------------------------------------------------------------------
  const byok = await byokFor(ctx, billing?.accountId);
  if (body.verify != null) applyDualDecoding(body); // temperature 0 and a fixed seed, before parameter support is checked
  const params = requestParams(body);
  const { targets, excluded } = selectTargets(ctx, { resolved, prefs, params, promptTokens, byok, disc });
  if (!targets.length)
    fail(404, "No providers match this request's model and routing preferences.", "no_providers", { excluded: excluded.slice(0, 50) });

  // Dual verification (`verify: "dual"`): the same request to two providers, outputs compared.
  if (body.verify != null) return runDual(toolkit, { ctx, c, kind, body, bodySha, t0, key, wallet, tier, billing, paywithNote, prefs, disc, resolved, targets, excluded, promptTokens, byok, guard, guardCfg, middle, savedRoute, preset: presetMeta });

  // ---- 6. Hold the worst case --------------------------------------------------------------------
  const fees = { royaltyBps: 0, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps };
  const modeForPrice: Mode = billing?.mode ?? "per_call";
  const attemptable = targets.flatMap((t) => t.ordered.map((cand) => ({ cand, model: t.model }))).slice(0, ctx.cfg.routing.maxAttempts);
  const worst = maxPico(...attemptable.map(({ cand, model }) => worstCase(cand, model, body, promptTokens, modeForPrice, fees, byok.has(cand.providerId))));
  const hold = batchLine ? batchHold(worst, batchLine.discountBps) : worst; // a batch line is held at its discounted worst case

  if (!billing) {
    const r = await payPerCall(ctx, c, { pricePico: hold, bodySha, modelId: primary.id });
    billing = { mode: "per_call", accountId: r.accountId, payer: r.payer, paymentTx: r.txHash, paymentResponse: r.paymentResponse };
  }
  if (billing.mode === "per_call") tier = await holderTier(ctx, billing.payer);
  if (billing.mode === "blind") {
    requireValue(ctx, billing.pass, hold); // the token pays for at most its face value
    billing.hold = hold;
    await claimToken(ctx, billing.pass); // spends once: a second claim of the same token fails; undone if nothing is served
  }
  if (billing.key?.tpm) await limitOrThrow(ctx, `kt:${billing.key.keyHash}`, promptTokens, scaleLimit(billing.key.tpm, tier), "tokens");

  const holdId = batchLine?.generationId ?? genId(); // a batch line's id is chosen by the runner, so an interrupted line can be traced to its charge
  try {
    await reserve(ctx.db, {
      ...agentReservation(ctx, () => ({ models: attemptable.map(t => t.model.id), lane: disc.lane, max_output_tokens: Math.max(...attemptable.map(t => maxOutputTokens(body, t.cand, t.model, promptTokens))), body })),
      id: holdId,
      accountId: billing.accountId,
      keyHash: billing.key?.keyHash ?? null,
      amount: hold,
      kind: "usage",
      ttlMs: ctx.cfg.routing.providerTimeoutMs * (ctx.cfg.routing.maxAttempts + 1),
      creditLine: billing.mode === "paywith" ? billing.grant.creditLine : 0n,
    });
  } catch (e) {
    if (billing.mode === "blind") await unclaimToken(ctx, billing.pass);
    if (isApiError(e) && e.type === "insufficient_credits" && paywithNote) e.metadata = { ...e.metadata, pay_with: paywithNote };
    throw e;
  }

  // ---- 7. Route ---------------------------------------------------------------------------------
  const abort = new AbortController();
  c.req.raw.signal?.addEventListener("abort", () => abort.abort(new DOMException("client disconnected", "AbortError")), { once: true });
  const keyFor = (cand: Candidate) => providerKey(cand, ctx.cfg.appSecret, byok.get(cand.providerId));
  const path = kind === "chat" ? ("/chat/completions" as const) : ("/completions" as const);
  const meta = { guard, middle, paywithNote, cacheMode, excluded, route: savedRoute, preset: presetMeta, character };
  // Streams send their headers before a provider is chosen, so the header is only set up front when every
  // provider this request can reach is served under the same class; the signed receipt always carries the truth.
  const classes = new Set(attemptable.map(({ cand }) => servedDisclosure(ctx, cand).class));
  const planned = classes.size === 1 ? [...classes][0] : null;
  // Likewise the policy hash: up front on a stream only when every reachable endpoint attested the same one.
  const plannedPolicy = sharedPolicyHash(attemptable.map(({ cand }) => servedPolicyHash(ctx, cand)));
  const common = { ctx, c, body, billing, holdId, t0, bodySha, stream, kind, byok, meta, guardCfg, promptTokens, tier, disc, planned, plannedPolicy };

  if (stream) return streamResponse({ ...common, run: () => route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: true, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16) }), abort });

  let result: Awaited<ReturnType<typeof route>>;
  try {
    result = await route({ appSecret: ctx.cfg.appSecret, targets, path, body, stream: false, keyFor, signal: abort.signal, health: ctx.health, maxAttempts: ctx.cfg.routing.maxAttempts, timeoutMs: ctx.cfg.routing.providerTimeoutMs, firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs, production: ctx.cfg.production, caller: sha256(billing.accountId).slice(0, 16) });
  } catch (e) {
    await giveBack(ctx, billing, holdId);
    throw e;
  }
  if (!result.ok) {
    await giveBack(ctx, billing, holdId);
    throw allFailed(result.attempts, result.last);
  }
  const r = result as Extract<RouteSuccess, { kind: "json" }>;
  const json = r.json;
  const usage = readUsage(json.usage, { prompt: promptTokens, completion: Math.ceil(JSON.stringify(json.choices ?? []).length / 4) });
  const redactions = guardCfg?.redact_output ? redactOutput(json) : 0;
  const responseText = (json.choices ?? []).map((ch: any) => (typeof ch?.message?.content === "string" ? ch.message.content : ch?.text ?? "")).join("");
  // An attested gateway's receipt for this exchange: checked before anything is returned.
  const upstreamAttestation = await upstreamAttestationOf(ctx, r, byok);
  const fin = await finalize({ ...common, r, usage, responseText, finishReason: json.choices?.[0]?.finish_reason ?? null, nativeFinish: json.choices?.[0]?.native_finish_reason ?? json.choices?.[0]?.finish_reason ?? null, generationMs: Date.now() - t0, cancelled: false, upstreamAttestation });
  if (upstreamAttestation && requiresAttestedUpstream(body, disc) && !upstreamAttestation.attested) {
    const err = unattestedUpstream(upstreamAttestation);
    return c.json({ ...err.toJSON(), id: fin.id, usage: fin.usageJson, receipt: fin.receiptJson }, 502, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), "x-anyroute-disclosure": fin.disclosure, ...paymentHeaders(billing) });
  }
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
  return c.json(out, 200, { ...generationHeaders(fin.id, disc.lane, fin.policyHash), "x-anyroute-disclosure": fin.disclosure, ...paymentHeaders(billing) });
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

/** A request that may only be answered by attested hardware: lane "attested" (or any disclosure "none"), or `:private`. */
export function requiresAttestedUpstream(body: Record<string, unknown>, disc: DisclosureRequest) {
  return disc.max === "none" || (body.provider as ProviderPrefs | undefined)?.private === true || String(body.model ?? "").includes(":private");
}

/**
 * The receipt check for a call an attested aci/1 gateway served (providers/aci.ts); null for every other provider.
 * A gateway call the router kept no record of cannot be checked, so it counts as not attested.
 */
async function upstreamAttestationOf(ctx: Ctx, r: Pick<RouteSuccess, "candidate" | "exchange">, byok: Map<string, string>): Promise<UpstreamAttestation | null> {
  const g = r.candidate.provider.aci;
  if (!g) return null;
  if (!r.exchange) return unverifiedUpstream(g, null, "the router kept no record of the exchange to check");
  return verifyAciExchange({
    baseUrl: r.candidate.provider.baseUrl,
    gateway: g,
    exchange: r.exchange,
    apiKey: providerKey(r.candidate, ctx.cfg.appSecret, byok.get(r.candidate.providerId)),
    tlsPin: r.candidate.provider.tlsPin,
    production: ctx.cfg.production,
  });
}

/**
 * The class a call was served under, given its gateway receipt check: an answer whose receipt does not show an
 * attested upstream is served under the class the provider has without a fresh attestation.
 */
function servedWith(ctx: Ctx, cand: Candidate, ua: UpstreamAttestation | null | undefined, base = servedDisclosure(ctx, cand)): { class: DisclosureClass; simulated: boolean } {
  if (!ua || ua.attested || base.class !== "attested") return base;
  return { class: disclosureClass(profileOf(ctx.catalog.disclosure.get(cand.providerId)), false), simulated: false };
}

/**
 * The answer for a request that required attested hardware when the gateway's receipt does not show it: the
 * upstream already did (and billed) the work, so the call is settled like any finished call, but its output is
 * withheld and the signed receipt records why.
 */
export function unattestedUpstream(ua: UpstreamAttestation): ApiError {
  return new ApiError(
    502,
    `The provider's receipt does not show an attested upstream (${ua.reason ?? "not attested"}). The response was withheld. The upstream had already generated it, so the call is billed as usual; the signed receipt records the verification result.`,
    "upstream_not_attested",
    { upstream_attestation: compactUpstream(ua) },
  );
}

export type Common = {
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
  meta: { guard: ReturnType<typeof applyGuardrails>; middle: { removed: number; truncated: number } | null; paywithNote?: string; cacheMode: CacheMode | null; excluded: unknown[]; route: string | null; preset?: { name: string; version: number; hash: string } | null; character?: CharacterMeta | null };
  guardCfg: GuardrailConfig | null;
  promptTokens: number;
  tier: HolderTier | null;
  disc: DisclosureRequest;
  /** The disclosure class every reachable provider shares, or null when it depends on who serves the call. */
  planned: DisclosureClass | null;
  /** The attested policy hash every reachable endpoint shares, or null (see generationHeaders); used by streams. */
  plannedPolicy?: string | null;
};

/** Extra inputs for calls made on behalf of a larger request (council members, dual verification). */
export type FinalizeExtra = {
  /**
   * Extra signed receipt fields; never replaces a base field. `attestation_ref` is set only for calls made under an
   * attested council or attested dual verification (see router/council.ts `attestationRefOf`); other receipts omit it.
   */
  payload?: { council?: unknown; verification?: unknown; attestation_ref?: unknown };
  /** The most this call may charge: usage above it is not billed to the caller (reported as `over_budget`). */
  budget?: Pico;
  /**
   * For a receipt that stands for several calls (the top-level council receipt): the weakest disclosure class
   * among all of them, and whether any rests on a simulated attestation. Never stronger than this call's own.
   */
  served?: { class: DisclosureClass; simulated: boolean };
};

export type FinalizeInput = Common & {
  r: RouteSuccess;
  usage: Usage;
  responseText: string;
  finishReason: string | null;
  nativeFinish: string | null;
  generationMs: number;
  cancelled: boolean;
  extra?: FinalizeExtra;
  /**
   * The checked receipt of an attested aci/1 gateway for this call. When omitted and the call went to such a
   * gateway, finalize checks it itself (council and dual verification calls).
   */
  upstreamAttestation?: UpstreamAttestation | null;
  /** For a stream: the head of the chunk hash chain over every event sent before the receipt (receipt v2 resp.chain). */
  chainHead?: string | null;
};

async function finalize(p: FinalizeInput) {
  const { ctx, billing, r } = p;
  const isByok = p.byok.has(r.candidate.providerId);
  const mode: Mode = isByok ? "byok" : billing.mode;
  const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: ctx.cfg.fees.perCallMarginBps, byokFeeBps: ctx.cfg.fees.byokFeeBps, discountBps: p.tier?.discountBps ?? 0 };
  const listCost = priceUsage(r.candidate, r.model, p.usage, billing.mode === "per_call" ? "per_call" : mode, fees, isByok);
  // A batch line is charged the discounted price (BATCH_DISCOUNT_BPS); everything else the list price.
  const batchLine = batchLineOf(p.c);
  const cost = batchLine ? batchPrice(listCost, batchLine.discountBps) : { ...listCost, batchDiscount: 0n };
  const id = p.holdId;
  const budget = p.extra?.budget;
  const overBudget = budget != null && cost.total > budget;
  // A blind token pays for at most its face value: anything above the hold would come out of the pool's other tokens.
  const settleAmount = billing.mode === "blind" && cost.total > billing.hold ? billing.hold : cost.total;
  const settled = await settle(ctx.db, p.holdId, overBudget ? budget : settleAmount, {
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
  const ua = p.upstreamAttestation !== undefined ? p.upstreamAttestation : await upstreamAttestationOf(ctx, r, p.byok);
  // A gateway answer whose receipt does not show an attested upstream is served under the class the provider has
  // without a fresh attestation, whatever the gateway's own attestation says.
  const served = servedWith(ctx, r.candidate, ua, p.extra?.served ?? servedDisclosure(ctx, r.candidate));
  if (ua) await recordGpuAttested(ctx.db, r.model.id, r.candidate.providerId, ua).catch((e) => log.error("recording gpu attestation failed", { error: (e as Error).message }));
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
    cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin), ...(overBudget ? { over_budget: picoToUsdString(cost.total) } : {}), ...(batchLine ? { batch_discount: picoToUsdString(cost.batchDiscount) } : {}) },
    paid_with: paidWith,
    latency_ms: Math.round(r.latencyMs),
    generation_ms: p.generationMs,
    quant: r.candidate.quant,
    mode,
    private: privateRoute,
    attestation,
    disclosure: served.class,
    lane: p.disc.lane,
    ...(served.simulated ? { attestation_simulated: true } : {}),
    payer,
    payment_tx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    // A blind redemption names no account: the receipt carries the hash of the spent token (its nullifier) and the key that signed it.
    ...(billing.mode === "blind" ? blindReceipt(billing.pass) : {}),
    request_sha256: p.bodySha,
    response_sha256: sha256(p.responseText),
    ...(ua ? { upstream_attestation: compactUpstream(ua) } : {}),
    ...(batchLine ? { batch: { id: batchLine.batchId, line: batchLine.idx } } : {}),
    ...(p.extra?.payload ?? {}),
  };
  const signed = ctx.signer.sign(payload);
  const leaf = receiptLeaf(signed.bytes, signed.sigBytes);
  // Receipt v2 alongside v1: the same facts minus payer and exact counts, as a COSE_Sign1 under the same key.
  const policyHash = servedPolicyHash(ctx, r.candidate);
  const claimsV2 = buildClaimsV2({
    rid: id,
    issuedAt: new Date(payload.issued),
    router: ctx.cfg.publicUrl,
    modelId: r.model.id,
    providerId: r.candidate.providerId,
    attestation,
    policyHash,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
    chainHead: p.stream ? (p.chainHead ?? null) : null,
    tokensIn: p.usage.prompt,
    tokensOut: p.usage.completion,
    finish: p.finishReason,
    stream: p.stream,
    complete: !p.cancelled && p.finishReason !== "error",
    lane: p.disc.lane,
    disclosure: served.class,
    mode,
    chargedPico: charged,
    keyset: billing.mode === "blind" && !billing.pass.tokens ? billing.pass.keyId : null,
  });
  const signedV2 = ctx.signer.signCose(claimsV2);

  const referer = p.c.req.header("http-referer") ?? p.c.req.header("referer");
  const title = p.c.req.header("x-title");
  let appId: string | null = null;
  // App attribution names where a call came from, so it is never recorded for the unlinkable lane.
  if ((referer || title) && p.disc.lane !== "unlinkable") {
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
    receiptV2: claimsV2,
    receiptCose: signedV2.cose.toString("base64"),
    receiptLeafV2: signedV2.leaf,
    paidWith,
    paymentTx: billing.mode === "per_call" ? (billing.paymentTx ?? null) : null,
    appId,
    attempts: r.attempts,
    requestSha256: p.bodySha,
    responseSha256: payload.response_sha256,
  });
  await linkNetworkReceipt(ctx, id, r.candidate.providerId, r);
  if (billing.mode === "blind") await confirmToken(ctx, billing.pass, id);
  // Creator attribution for a public character: a count and a cost per day, never on the unlinkable lane.
  if (p.meta.character?.attribute && p.disc.lane !== "unlinkable") await recordCharacterUse(ctx, p.meta.character.id, charged);

  // A private-lane request is counted once in the noisy counters and sends no per-request trace span.
  const privateLane = isPrivateLaneRequest(p.c.req.raw);
  recordPrivateLane(ctx, p.c.req.raw, { latencyMs: p.generationMs, tokens: p.usage.prompt + p.usage.completion });
  if (!privateLane) ctx.telemetry.span("chat " + r.model.id, p.t0, Date.now(), {
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
  // The key owner's own trace export (services/tracing.ts): public-lane calls only. An attested or unlinkable call
  // never reaches the queue, whatever the key is configured to do. Queued without waiting; it cannot fail the call.
  if (billing.key?.tracing && shouldExportTrace({ lane: p.disc.lane, privateLaneRequest: privateLane, privateRoute })) {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    ctx.tracing.enqueue(billing.key.keyHash, billing.key.tracing, {
      generationId: id,
      startMs: p.t0,
      endMs: Date.now(),
      ...parseTraceparent(p.c.req.header("traceparent")),
      operation: p.kind === "chat" ? "chat" : "text_completion",
      provider: r.candidate.providerId,
      requestModel: String(p.body.model ?? r.model.id),
      responseModel: r.model.id,
      inputTokens: p.usage.prompt,
      outputTokens: p.usage.completion,
      temperature: num(p.body.temperature),
      topP: num(p.body.top_p),
      maxTokens: num(p.body.max_tokens ?? p.body.max_completion_tokens),
      finishReasons: p.finishReason ? [p.finishReason] : [],
      costUsd: picoToUsd(charged),
      timeToFirstTokenMs: r.latencyMs,
      mode,
      streamed: p.stream,
      attempts: r.attempts.length,
      input: p.kind === "chat" ? p.body.messages : p.body.prompt,
      output: p.responseText,
    });
  }

  const usageJson = {
    prompt_tokens: p.usage.prompt,
    completion_tokens: p.usage.completion,
    total_tokens: p.usage.prompt + p.usage.completion,
    cost: picoToUsd(charged),
    is_byok: isByok,
    cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty), margin: picoToUsd(cost.margin), ...(p.tier ? { holder_discount: picoToUsd(cost.holderDiscount) } : {}), ...(batchLine ? { batch_discount: picoToUsd(cost.batchDiscount) } : {}) },
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
    anchor_hint: `Rooted within the hour; GET /api/v1/receipts/${id}/proof returns the merkle path.`,
    ...(paidWith ? { paid_with: paidWith } : {}),
    v2: { alg: "EdDSA", kid: signedV2.keyId, content_type: COSE_CONTENT_TYPE, cose: signedV2.cose.toString("base64"), claims: claimsV2, leaf: signedV2.leaf },
  };
  return {
    id,
    disclosure: served.class,
    simulated: served.simulated,
    /** The classifier policy hash the serving endpoint's fresh attestation bound, or null (X-Anyroute-Policy-Hash). */
    policyHash,
    upstream: cost.upstream,
    charged,
    cost,
    overBudget,
    mode,
    isByok,
    payload,
    usageJson,
    receiptJson,
    extras: (redactions: number) => {
      const x: Record<string, unknown> = {};
      if (p.meta.route) x.route = p.meta.route; // the saved route (`@route/<slug>`) that resolved this call
      if (p.meta.preset) x.preset = p.meta.preset; // the preset version (`@preset/<name>@<version>`) that resolved this call
      if (p.meta.character) x.character = { id: p.meta.character.id, card_hash: p.meta.character.card_hash, lane: p.meta.character.lane, lorebook_entries: p.meta.character.lore.length, greeting: p.meta.character.greeting, ...(p.meta.character.note ? { note: p.meta.character.note } : {}) };
      if (p.meta.guard || redactions) x.guardrails = { ...(p.meta.guard ?? {}), output_redactions: redactions };
      if (p.meta.middle && (p.meta.middle.removed || p.meta.middle.truncated)) x.transforms = { "middle-out": p.meta.middle };
      if (p.meta.paywithNote) x.pay_with_fallback = p.meta.paywithNote;
      if (p.billing.mode === "blind") x.blind = redemptionSummary(p.billing.pass, charged);
      if (p.tier) x.holder = { tier: p.tier.name, rpm_multiplier: p.tier.rpmMultiplier, discount_bps: p.tier.discountBps };
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
        await giveBack(ctx, p.billing, p.holdId);
        if (!p.abort.signal.aborted) event({ error: { code: 502, message: (e as Error).message, type: "router_error" } });
        send("data: [DONE]\n\n");
        closed = true;
        controller.close();
        return;
      }
      clearInterval(keepalive);
      if (!result.ok) {
        await giveBack(ctx, p.billing, p.holdId);
        const err = allFailed(result.attempts, result.last);
        event(err.toJSON());
        send("data: [DONE]\n\n");
        closed = true;
        controller.close();
        return;
      }
      const r = result as Extract<RouteSuccess, { kind: "stream" }>;
      const base = chunkBase(p.holdId, created, r.model, r.candidate.provider.name, kind);
      // Chunk hash chain (receipt v2 resp.chain): every event before the receipt is chained, and c_i follows the
      // i-th event as an SSE comment, which OpenAI-compatible parsers discard. Only what was enqueued is chained.
      const chain = new ChunkChain(p.holdId);
      const chained = (obj: unknown) => {
        if (closed) return;
        const data = JSON.stringify(obj);
        const hex = chain.push(data);
        send(`data: ${data}\n\n` + chainComment(chain.count, hex));
      };
      // What an attested gateway streams for a request that requires attested hardware is held back until its
      // receipt shows an attested upstream (providers/aci.ts); every other stream is relayed as it arrives.
      const hold = !!r.candidate.provider.aci && requiresAttestedUpstream(p.body, p.disc);
      const held: unknown[] = [];
      const relay = (obj: unknown) => (hold ? held.push(obj) : chained(obj));
      const holdKeepalive = hold ? setInterval(() => send(": ANYROUTE PROCESSING\n\n"), 5_000) : undefined;
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
        relay({ ...base, ...rest, choices });
      };
      try {
        for (const ev of r.buffered) emit(ev);
        for await (const ev of r.rest) {
          if (ev?.error) {
            midError = String(ev.error?.message ?? "provider error");
            relay({ ...base, error: { code: 502, message: midError, type: "provider_error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
            break;
          }
          emit(ev);
        }
      } catch (e) {
        if (p.abort.signal.aborted) cancelled = true;
        else {
          midError = (e as Error).message;
          relay({ ...base, error: { code: 502, message: "Provider stream was interrupted.", type: "provider_interrupted" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
        }
      }
      try {
        const reasoningEst = Math.ceil(reasoningText.length / 4);
        const usage = readUsage(providerUsage, { prompt: p.promptTokens, completion: Math.ceil((text.length + toolText.length) / 4) + reasoningEst });
        if (!providerUsage) usage.reasoning = reasoningEst;
        const upstreamAttestation = await upstreamAttestationOf(ctx, r, p.byok);
        clearInterval(holdKeepalive);
        const refused = hold && !!upstreamAttestation && !upstreamAttestation.attested;
        if (hold && !refused) for (const e of held) chained(e);
        // The refusal goes out before the receipt is signed, so the chain covers it too.
        if (refused) chained({ ...unattestedUpstream(upstreamAttestation!).toJSON(), id: p.holdId });
        const fin = await finalize({ ...p, r, usage, responseText: text, finishReason: finish ?? (cancelled ? "cancelled" : midError ? "error" : null), nativeFinish, generationMs: Date.now() - p.t0, cancelled, upstreamAttestation, chainHead: chain.head });
        event({ ...base, choices: [], usage: fin.usageJson, receipt: fin.receiptJson, ...(fin.extras(0) ?? {}) });
      } catch (e) {
        clearInterval(holdKeepalive);
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
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...generationHeaders(p.holdId, p.disc.lane, p.plannedPolicy), ...(p.planned ? { "x-anyroute-disclosure": p.planned } : {}), ...paymentHeaders(p.billing) },
  });
}

async function cachedResponse(ctx: Ctx, c: Context, p: { body: Record<string, unknown>; hit: { response: any; upstream: bigint; similarity: number }; billing: Billing; model: ModelRow; t0: number; bodySha: string; disc: DisclosureRequest }) {
  const id = genId();
  await enforceAgentCached(ctx, p.billing.key, p.model.id, p.disc.lane, p.body, id);
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
    // The answer was first produced by a provider under no disclosure ceiling (a request with one never uses the cache).
    disclosure: "vendor-forwarded" satisfies DisclosureClass,
    lane: p.disc.lane,
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
    // Served from the cache, not by an attested endpoint: no policy hash.
    { ...generationHeaders(id, p.disc.lane), "x-anyroute-cache": "hit", "x-anyroute-disclosure": "vendor-forwarded", ...paymentHeaders(p.billing) },
  );
}

/** What the multi-call modes (council, dual verification) reuse from the single-call path. */
export const toolkit = { finalize, selectTargets, resolveBilling, allFailed, byokFor, limitOrThrow, requestHash, requestParams, paymentHeaders, upstreamAttestationOf, servedWith };

export { canonical };
