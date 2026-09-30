import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { maxPico, picoToUsd, picoToUsdString } from "../lib/money.ts";
import { genId, log, sha256 } from "../lib/util.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { isRerankModel } from "../catalog/catalog.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { disclosureRefusal, profileOf } from "../router/disclosure.ts";
import { priceUsage, type Usage } from "../router/pricing.ts";
import { estimateRerank, parseRerankRequest, readRerankResults, readRerankUsage, upstreamRerankBody } from "../router/rerank.ts";
import { callUpstream, providerKey } from "../providers/upstream.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { bearer, requireKey, requireRole } from "./auth.ts";
import { addressBucket, generationHeaders, readJson } from "./common.ts";
import { servedPolicyHash } from "./disclosure.ts";
import { requestHash, requiresAttestedUpstream, toolkit, unattestedUpstream } from "./chat.ts";
import { compactUpstream, recordGpuAttested } from "../providers/aci.ts";
import { payPerCall } from "../pay/percall.ts";
import type { Attempt } from "../router/execute.ts";
import { holderTier, scaleLimit, walletOfAccount } from "../holders/tiers.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { requestLane } from "../ohttp/lane.ts";
import { noteLane } from "../services/private-stats.ts";
import { BLIND_POOL, claimToken, confirmToken, isBlindRequest, presentBlindToken, redemptionSummary, requireValue, unclaimToken } from "../blind/redeem.ts";

// POST /api/v1/rerank (and /v1/rerank): order documents by relevance to a query, Cohere / Jina shaped.
//   { model, query, documents: string[] | { text }[], top_n?, return_documents? }
//   -> { id, model, results: [{ index, relevance_score, document? }], usage: { total_tokens, search_units, cost }, cost, receipt }
//
// Served only by catalogue models whose output modalities include "rerank", through a provider's own /rerank
// (Cohere-, Jina- or OpenAI-compatible servers all take { model, query, documents, top_n }). Until a provider lists
// such a model the endpoint answers 404 model_not_found; it never scores documents itself or makes a score up.
//
// Billing, lanes and receipts are those of embeddings: a prepaid key, a blind token or a per-call payment; the
// provider's list price per token (pricing.prompt) and per search unit (pricing.request, one query over up to 100
// document chunks), as the provider reported them or, when it did not, as estimated (marked in the receipt); the
// disclosure ceiling and lane; :nitro / :floor and every provider preference; a signed receipt per call.
export function rerankRoutes(app: Hono, ctx: Ctx) {
  const handler = async (c: Context) => {
    const t0 = Date.now();
    const key = bearer(c.req.header("authorization")) ? await requireKey(ctx, c.req.header("authorization")) : null;
    if (key) await requireRole(ctx, key, ["owner", "admin", "member"]);
    let tier = key ? await holderTier(ctx, walletOfAccount(key.accountId)) : null;
    const from = addressBucket(c, ctx.cfg);
    const lim = key
      ? await ctx.limiter.take(`k:${key.keyHash}`, 1, scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), 60_000)
      : gatewayOrigin(c.req.raw)
        ? { ok: true, retryAfterMs: 0 }
        : isBlindRequest(ctx, c.req.header("authorization"))
          ? await ctx.limiter.take(`blind-ip:${from.id}`, 1, from.scale(ctx.cfg.blind.redeemRpm), 60_000)
          : await ctx.limiter.take(`ip:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), 60_000);
    if (!lim.ok) fail(429, "Rate limit exceeded.", "rate_limited", undefined, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
    const pass = key ? null : await presentBlindToken(ctx, c.req.header("authorization"));
    const body = await readJson(c);
    const req = parseRerankRequest(body);
    if (body.provider != null && (typeof body.provider !== "object" || Array.isArray(body.provider))) fail(400, "`provider` must be an object.", "invalid_request");
    await ctx.catalog.ensureFresh();
    const r = ctx.catalog.resolve(req.model);
    if (!r) fail(404, `Model ${req.model} is not available. See GET /api/v1/models?output_modalities=rerank.`, "model_not_found");
    if (!isRerankModel(r.model)) {
      const any = [...ctx.catalog.models.values()].some((m) => !m.hidden && isRerankModel(m));
      fail(404, any ? `Model ${r.model.id} is not a rerank model. See GET /api/v1/models?output_modalities=rerank.` : `Model ${r.model.id} is not a rerank model, and no rerank model is available on this router yet.`, "model_not_found");
    }
    if (key?.allowedModels?.length && !key.allowedModels.includes(r.model.id)) fail(403, "This key may not use that model.", "model_not_allowed");
    const est = estimateRerank(req);
    const { disclosure: _d, lane: _l, lane_downgrade: _ld, ...basePrefs } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
    const disc = requestLane(ctx, c, (body.provider ?? {}) as Record<string, unknown>, { hasKey: !!key, hasWallet: !key && !pass && (!!c.req.header("x-wallet-auth") || !!c.req.header("x-payment")), hasToken: !!pass });
    noteLane(c.req.raw, disc.lane); // the status page counts public-lane requests only (services/slo.ts)
    const strict = disc.max !== "any";
    const plan = (p: ProviderPrefs) =>
      selectProviders({
        modelId: r.model.id,
        offers: ctx.catalog.offers(r.model.id),
        prefs: p,
        modifiers: r.modifiers,
        requestParams: [],
        estimatedTokens: 0, // a long document is truncated or chunked by the provider, never refused for its length
        health: ctx.health,
        production: ctx.cfg.production,
        attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
        disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)),
        modelLane: ctx.catalog.laneOf(r.model),
        attestedBonus: ctx.cfg.routing.attestedBonus,
        rand: ctx.rand,
      });
    const sel = plan({ ...basePrefs, ...(strict ? { disclosure: disc.max } : {}), ...(disc.lane !== "public" ? { lane: disc.lane } : {}) });
    if (!sel.ordered.length) {
      const refusal = strict ? disclosureRefusal(disc, [r.model.id], sel.excluded, () => plan(basePrefs).ordered.length > 0) : null;
      if (refusal) throw refusal;
      fail(404, "No providers match this request.", "no_providers", { excluded: sel.excluded });
    }
    const mode = key ? "prepaid" : pass ? "blind" : "per_call";
    const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: key || pass ? 0 : ctx.cfg.fees.perCallMarginBps, byokFeeBps: 0 };
    const usageOf = (tokens: number, searchUnits: number, estimated: boolean): Usage => ({ prompt: tokens, completion: 0, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated, searchUnits });
    const worst = (cand: (typeof sel.ordered)[number]) => priceUsage(cand, r.model, usageOf(est.tokens, est.searchUnits, true), mode, fees, false).total;
    const hold = maxPico(...sel.ordered.slice(0, ctx.cfg.routing.maxAttempts).map(worst));
    const paid = key || pass ? null : await payPerCall(ctx, c, { pricePico: hold * 2n + 1n, bodySha: requestHash(body), modelId: r.model.id });
    const accountId = key?.accountId ?? (pass ? BLIND_POOL : paid!.accountId);
    if (paid) tier = await holderTier(ctx, paid.payer);
    const id = genId();
    if (pass) {
      requireValue(ctx, pass, hold * 2n + 1n);
      await claimToken(ctx, pass);
    }
    try {
      await reserve(ctx.db, { id, accountId, keyHash: key?.keyHash ?? null, amount: hold * 2n + 1n, ttlMs: ctx.cfg.routing.providerTimeoutMs * 2 });
    } catch (e) {
      if (pass) await unclaimToken(ctx, pass);
      throw e;
    }
    const attempts: Attempt[] = [];
    try {
      for (const cand of sel.ordered.slice(0, ctx.cfg.routing.maxAttempts)) {
        const res = await callUpstream({
          appSecret: ctx.cfg.appSecret,
          candidate: cand,
          path: "/rerank",
          body: upstreamRerankBody(cand.providerModelId, req),
          stream: false,
          apiKey: providerKey(cand, ctx.cfg.appSecret),
          signal: c.req.raw.signal ?? new AbortController().signal,
          timeoutMs: ctx.cfg.routing.providerTimeoutMs,
          firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs,
          production: ctx.cfg.production,
        });
        const results = res.ok && res.kind === "json" ? readRerankResults(res.json, req) : null;
        if (!res.ok || !results) {
          // An empty or malformed ranking is a failed attempt like a 5xx: the next provider is tried and nothing is billed for it.
          const empty = res.ok && res.kind === "json" && Array.isArray(res.json?.results) && res.json.results.length === 0;
          const kind = res.ok ? (empty ? "empty200" : "unreadable") : res.errorKind;
          attempts.push({ provider: cand.providerId, model: r.model.id, ok: false, error_kind: kind, status: res.ok ? 200 : res.status, latency_ms: Math.round(res.latencyMs) });
          ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: false, errorKind: kind, empty200: kind === "empty200", source: "traffic" });
          continue;
        }
        if (res.kind !== "json") continue;
        attempts.push({ provider: cand.providerId, model: r.model.id, ok: true, status: 200, latency_ms: Math.round(res.latencyMs) });
        ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: true, latencyMs: res.latencyMs, source: "traffic" });
        const reported = readRerankUsage(res.json);
        const tokens = reported.tokens ?? est.tokens;
        const searchUnits = reported.searchUnits ?? est.searchUnits;
        // Estimated only where a priced quantity went unreported.
        const estimated = (cand.pricePrompt > 0n && reported.tokens == null) || (cand.priceRequest > 0n && reported.searchUnits == null);
        const usage = usageOf(tokens, searchUnits, estimated);
        const cost = priceUsage(cand, r.model, usage, mode, { ...fees, discountBps: tier?.discountBps ?? 0 }, false);
        const { charged } = await settle(ctx.db, id, cost.total, { description: `${r.model.id} rerank via ${cand.providerId}`, generationId: id });
        const ua = await toolkit.upstreamAttestationOf(ctx, { candidate: cand, exchange: res.exchange }, new Map());
        const refused = !!ua && requiresAttestedUpstream(body, disc) && !ua.attested;
        const served = toolkit.servedWith(ctx, cand, ua);
        if (ua) await recordGpuAttested(ctx.db, r.model.id, cand.providerId, ua).catch((e) => log.error("recording gpu attestation failed", { error: (e as Error).message }));
        const payload = {
          v: 1,
          id,
          kind: "rerank",
          issued: new Date().toISOString(),
          router: ctx.cfg.publicUrl,
          model: r.model.id,
          provider: cand.providerId,
          tokens: { prompt: tokens, completion: 0, reasoning: 0, cached: 0, estimated },
          search_units: searchUnits,
          documents: req.documents.length,
          cost: picoToUsdString(charged),
          cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin) },
          paid_with: null,
          latency_ms: Math.round(res.latencyMs),
          quant: cand.quant,
          mode,
          disclosure: served.class,
          lane: disc.lane,
          ...(served.simulated ? { attestation_simulated: true } : {}),
          payer: key?.chainKeyHash ?? paid?.payer ?? null,
          payment_tx: paid?.txHash ?? null,
          ...(pass ? { nullifier: pass.nullifier, token_key_id: pass.keyId } : {}),
          request_sha256: sha256(JSON.stringify(body)),
          response_sha256: sha256(JSON.stringify(results)),
          ...(ua ? { upstream_attestation: compactUpstream(ua) } : {}),
        };
        const signed = ctx.signer.sign(payload);
        await ctx.db.insert(generations).values({
          id,
          keyHash: key?.keyHash ?? null,
          accountId,
          modelId: r.model.id,
          providerId: cand.providerId,
          tokensIn: tokens,
          cost: charged,
          upstreamCost: cost.upstream,
          royalty: cost.royalty,
          margin: cost.margin,
          mode,
          latencyMs: Math.round(res.latencyMs),
          generationTimeMs: Date.now() - t0,
          quant: cand.quant,
          receiptId: id,
          receiptSig: signed.sig,
          receiptKeyId: signed.keyId,
          receipt: payload,
          receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes),
          paymentTx: paid?.txHash ?? null,
          attempts,
          requestSha256: payload.request_sha256,
          responseSha256: payload.response_sha256,
        });
        if (pass) await confirmToken(ctx, pass, id);
        const costUsd = picoToUsd(charged);
        const usageJson = {
          total_tokens: tokens,
          search_units: searchUnits,
          ...(estimated ? { estimated: true } : {}),
          cost: costUsd,
          cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty), ...(key ? {} : { margin: picoToUsd(cost.margin) }), ...(tier ? { holder_discount: picoToUsd(cost.holderDiscount) } : {}) },
        };
        const receiptJson = { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload };
        const headers = { ...generationHeaders(id, disc.lane, servedPolicyHash(ctx, cand)), "x-anyroute-disclosure": served.class, ...(paid?.paymentResponse ? { "x-payment-response": paid.paymentResponse } : {}) };
        if (refused) return c.json({ ...unattestedUpstream(ua!).toJSON(), id, usage: usageJson, receipt: receiptJson }, 502, headers);
        return c.json(
          {
            id,
            object: "rerank",
            model: r.model.id,
            provider: cand.provider.name,
            results,
            usage: usageJson,
            // Cohere clients read the billed units here.
            meta: { billed_units: { search_units: searchUnits } },
            cost: costUsd,
            ...(tier ? { holder: { tier: tier.name, rpm_multiplier: tier.rpmMultiplier, discount_bps: tier.discountBps } } : {}),
            ...(pass ? { blind: redemptionSummary(pass, charged) } : {}),
            receipt: receiptJson,
          },
          200,
          headers,
        );
      }
    } catch (e) {
      await release(ctx.db, id);
      if (pass) await unclaimToken(ctx, pass);
      throw e;
    }
    await release(ctx.db, id);
    if (pass) await unclaimToken(ctx, pass);
    fail(502, "All providers for this request failed. Nothing was charged.", "providers_unavailable", { attempts });
  };
  app.post("/api/v1/rerank", handler);
  app.post("/v1/rerank", handler);
}
