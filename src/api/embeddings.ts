import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { maxPico, picoToUsd, picoToUsdString } from "../lib/money.ts";
import { genId, sha256 } from "../lib/util.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { priceUsage, readUsage } from "../router/pricing.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { requireKey, requireRole } from "./auth.ts";
import { readJson } from "./common.ts";
import type { Attempt } from "../router/execute.ts";

// POST /api/v1/embeddings — prepaid keys only (embeddings are too small to be worth a 402 round trip).
export function embeddingsRoutes(app: Hono, ctx: Ctx) {
  const handler = async (c: import("hono").Context) => {
    const t0 = Date.now();
    const key = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, key, ["owner", "admin", "member"]);
    const lim = await ctx.limiter.take(`k:${key.keyHash}`, 1, key.rpm ?? ctx.cfg.limits.defaultRpm, 60_000);
    if (!lim.ok) fail(429, "Rate limit exceeded.", "rate_limited", undefined, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
    const body = await readJson(c);
    const input = body.input;
    if (!(typeof input === "string" || (Array.isArray(input) && input.length > 0 && input.length <= 2048))) fail(400, "`input` must be a string or an array (max 2048 items).", "invalid_request");
    if (typeof body.model !== "string") fail(400, "`model` is required.", "invalid_request");
    await ctx.catalog.ensureFresh();
    const r = ctx.catalog.resolve(body.model);
    if (!r) fail(404, `Model ${body.model} is not available.`, "model_not_found");
    if (key.allowedModels?.length && !key.allowedModels.includes(r.model.id)) fail(403, "This key may not use that model.", "model_not_allowed");
    const chars = (Array.isArray(input) ? input : [input]).reduce((n: number, s) => n + String(s).length, 0);
    const promptTokens = Math.ceil(chars / 3) + 8;
    const sel = selectProviders({
      modelId: r.model.id,
      offers: ctx.catalog.offers(r.model.id),
      prefs: (body.provider ?? {}) as ProviderPrefs,
      modifiers: r.modifiers,
      requestParams: [],
      estimatedTokens: promptTokens,
      health: ctx.health,
      production: ctx.cfg.production,
      attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
      rand: ctx.rand,
    });
    if (!sel.ordered.length) fail(404, "No providers match this request.", "no_providers", { excluded: sel.excluded });
    const fees = { royaltyBps: r.model.royaltyBps, perCallMarginBps: 0, byokFeeBps: 0 };
    const worst = (cand: (typeof sel.ordered)[number]) =>
      priceUsage(cand, r.model, { prompt: promptTokens, completion: 0, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: true }, "prepaid", fees, false).total;
    const hold = maxPico(...sel.ordered.slice(0, ctx.cfg.routing.maxAttempts).map(worst));
    const id = genId();
    await reserve(ctx.db, { id, accountId: key.accountId, keyHash: key.keyHash, amount: hold * 2n + 1n, ttlMs: ctx.cfg.routing.providerTimeoutMs * 2 });
    const attempts: Attempt[] = [];
    try {
      for (const cand of sel.ordered.slice(0, ctx.cfg.routing.maxAttempts)) {
        const res = await callUpstream({
    appSecret: ctx.cfg.appSecret,
          candidate: cand,
          path: "/embeddings",
          body: upstreamBody(cand, body, false).body,
          stream: false,
          apiKey: providerKey(cand, ctx.cfg.appSecret),
          signal: c.req.raw.signal ?? new AbortController().signal,
          timeoutMs: ctx.cfg.routing.providerTimeoutMs,
          firstTokenTimeoutMs: ctx.cfg.routing.firstTokenTimeoutMs,
          production: ctx.cfg.production,
        });
        const empty = res.ok && res.kind === "json" && !(Array.isArray(res.json?.data) && res.json.data.length);
        if (!res.ok || empty) {
          const kind = res.ok ? "empty200" : res.errorKind;
          attempts.push({ provider: cand.providerId, model: r.model.id, ok: false, error_kind: kind, status: res.ok ? 200 : res.status, latency_ms: Math.round(res.latencyMs) });
          ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: false, errorKind: kind, empty200: kind === "empty200", source: "traffic" });
          continue;
        }
        if (res.kind !== "json") continue;
        attempts.push({ provider: cand.providerId, model: r.model.id, ok: true, status: 200, latency_ms: Math.round(res.latencyMs) });
        ctx.health.record({ modelId: cand.modelId, providerId: cand.providerId, ok: true, latencyMs: res.latencyMs, source: "traffic" });
        const usage = readUsage(res.json.usage, { prompt: promptTokens, completion: 0 });
        const cost = priceUsage(cand, r.model, { ...usage, completion: 0 }, "prepaid", fees, false);
        const { charged } = await settle(ctx.db, id, cost.total, { description: `${r.model.id} embeddings via ${cand.providerId}`, generationId: id });
        const payload = {
          v: 1,
          id,
          issued: new Date().toISOString(),
          router: ctx.cfg.publicUrl,
          model: r.model.id,
          provider: cand.providerId,
          tokens: { prompt: usage.prompt, completion: 0, reasoning: 0, cached: 0, estimated: usage.estimated },
          cost: picoToUsdString(charged),
          cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: "0" },
          paid_with: null,
          latency_ms: Math.round(res.latencyMs),
          quant: cand.quant,
          mode: "prepaid",
          payer: key.chainKeyHash,
          request_sha256: sha256(JSON.stringify(body)),
          response_sha256: sha256(JSON.stringify(res.json.data)),
        };
        const signed = ctx.signer.sign(payload);
        await ctx.db.insert(generations).values({
          id,
          keyHash: key.keyHash,
          accountId: key.accountId,
          modelId: r.model.id,
          providerId: cand.providerId,
          tokensIn: usage.prompt,
          cost: charged,
          upstreamCost: cost.upstream,
          royalty: cost.royalty,
          mode: "prepaid",
          latencyMs: Math.round(res.latencyMs),
          generationTimeMs: Date.now() - t0,
          quant: cand.quant,
          receiptId: id,
          receiptSig: signed.sig,
          receiptKeyId: signed.keyId,
          receipt: payload,
          receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes),
          attempts,
          requestSha256: payload.request_sha256,
          responseSha256: payload.response_sha256,
        });
        return c.json({
          ...res.json,
          id,
          model: r.model.id,
          provider: cand.provider.name,
          usage: { prompt_tokens: usage.prompt, total_tokens: usage.prompt, cost: picoToUsd(charged), cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty) } },
          receipt: { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload },
        });
      }
    } catch (e) {
      await release(ctx.db, id);
      throw e;
    }
    await release(ctx.db, id);
    fail(502, "All providers for this request failed. Nothing was charged.", "providers_unavailable", { attempts });
  };
  app.post("/api/v1/embeddings", handler);
  app.post("/v1/embeddings", handler);
}
