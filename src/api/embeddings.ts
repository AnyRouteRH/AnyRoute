import { agentReservation } from "../agents/enforce.ts";
import { blindReceipt } from "../blind/set.ts";
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { maxPico, picoToUsd, picoToUsdString } from "../lib/money.ts";
import { genId, log, sha256 } from "../lib/util.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";
import { disclosureRefusal, profileOf } from "../router/disclosure.ts";
import { batchHold, batchPrice, priceUsage, readUsage } from "../router/pricing.ts";
import { batchKey, batchLineOf } from "../router/batch-line.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
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

// POST /api/v1/embeddings — prepaid keys, or no key at all: an unpaid call gets the same 402 as chat
// (CallPay and/or x402, whichever this router has configured) and the paid retry is served.
//
// An attested aci/1 gateway is held to the same rule as for chat (providers/aci.ts): the router fetches the gateway's
// receipt for the call and checks it against the exact request and response bytes. On lane "attested" (any
// disclosure ceiling of "none", or `:private`) the vectors are returned only when the receipt shows an upstream the
// gateway verified inside a TEE; otherwise they are withheld, the call is billed, and the signed receipt says why.
// On other lanes the vectors are returned and the receipt records that they were not attested.
export function embeddingsRoutes(app: Hono, ctx: Ctx) {
  const handler = async (c: import("hono").Context) => {
    const t0 = Date.now();
    // A line of a batch (POST /api/v1/batches), dispatched in process by the batch runner as the key that submitted it.
    const batchLine = batchLineOf(c);
    const key = batchLine ? await batchKey(ctx, batchLine.keyHash) : bearer(c.req.header("authorization")) ? await requireKey(ctx, c.req.header("authorization")) : null;
    if (key) await requireRole(ctx, key, ["owner", "admin", "member"]);
    let tier = key ? await holderTier(ctx, walletOfAccount(key.accountId)) : null; // $ANYR holders get a higher rpm
    const from = addressBucket(c, ctx.cfg); // over Tor: the shared onion bucket, not a client address
    const lim = key
      ? await ctx.limiter.take(`k:${key.keyHash}`, 1, scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), 60_000)
      : gatewayOrigin(c.req.raw)
        ? { ok: true, retryAfterMs: 0 } // dispatched by the Oblivious HTTP gateway, which limited it per relay: there is no client address here
        : isBlindRequest(ctx, c.req.header("authorization"))
          ? await ctx.limiter.take(`blind-ip:${from.id}`, 1, from.scale(ctx.cfg.blind.redeemRpm), 60_000) // a token carries its own quota
          : await ctx.limiter.take(`ip:${from.id}`, 1, from.scale(ctx.cfg.limits.unauthRpm), 60_000);
    if (!lim.ok) fail(429, "Rate limit exceeded.", "rate_limited", undefined, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
    // A Privacy Pass token (Authorization: PrivateToken) instead of a key, when ANYROUTE_FEATURE_BLIND is on.
    const pass = key ? null : await presentBlindToken(ctx, c.req.header("authorization"));
    const body = await readJson(c);
    const input = body.input;
    if (!(typeof input === "string" || (Array.isArray(input) && input.length > 0 && input.length <= 2048))) fail(400, "`input` must be a string or an array (max 2048 items).", "invalid_request");
    if (typeof body.model !== "string") fail(400, "`model` is required.", "invalid_request");
    await ctx.catalog.ensureFresh();
    const r = ctx.catalog.resolve(body.model);
    if (!r) fail(404, `Model ${body.model} is not available.`, "model_not_found");
    if (key?.allowedModels?.length && !key.allowedModels.includes(r.model.id)) fail(403, "This key may not use that model.", "model_not_allowed");
    const chars = (Array.isArray(input) ? input : [input]).reduce((n: number, s) => n + String(s).length, 0);
    const promptTokens = Math.ceil(chars / 3) + 8;
    // Same disclosure ceiling and lane as chat (`provider.disclosure`, `provider.lane`, X-Anyroute-Disclosure-Max, X-Anyroute-Lane).
    const { disclosure: _wantDisclosure, lane: _wantLane, lane_downgrade: _wantDowngrade, ...basePrefs } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
    // A per-call payment names its payer as a wallet does: it is identity-bearing for lane "unlinkable".
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
        estimatedTokens: promptTokens,
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
    const worst = (cand: (typeof sel.ordered)[number]) =>
      priceUsage(cand, r.model, { prompt: promptTokens, completion: 0, reasoning: 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: true }, mode, fees, false).total;
    const worstHold = maxPico(...sel.ordered.slice(0, ctx.cfg.routing.maxAttempts).map(worst));
    const hold = batchLine ? batchHold(worstHold, batchLine.discountBps) : worstHold; // a batch line is held at its discounted worst case
    // No key: the caller pays this call up front (402 quote, or the X-Payment retry); the payment funds the hold.
    const paid = key || pass ? null : await payPerCall(ctx, c, { pricePico: hold * 2n + 1n, bodySha: requestHash(body), modelId: r.model.id });
    const accountId = key?.accountId ?? (pass ? BLIND_POOL : paid!.accountId);
    if (paid) tier = await holderTier(ctx, paid.payer); // a wallet paying per call: its $ANYR tier lowers the margin
    const id = batchLine?.generationId ?? genId();
    if (pass) {
      requireValue(ctx, pass, hold * 2n + 1n); // the token pays for at most its face value
      await claimToken(ctx, pass); // spends once; given back below if nothing is served
    }
    try {
      await reserve(ctx.db, { ...agentReservation(ctx, () => ({ models: [r.model.id], lane: disc.lane, max_output_tokens: 0, body })), id, accountId, keyHash: key?.keyHash ?? null, amount: hold * 2n + 1n, ttlMs: ctx.cfg.routing.providerTimeoutMs * 2 });
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
        const listCost = priceUsage(cand, r.model, { ...usage, completion: 0 }, mode, { ...fees, discountBps: tier?.discountBps ?? 0 }, false);
        const cost = batchLine ? batchPrice(listCost, batchLine.discountBps) : { ...listCost, batchDiscount: 0n };
        const { charged } = await settle(ctx.db, id, cost.total, { description: `${r.model.id} embeddings via ${cand.providerId}`, generationId: id });
        // An attested gateway's receipt for this exchange: checked before anything is returned.
        const ua = await toolkit.upstreamAttestationOf(ctx, { candidate: cand, exchange: res.exchange }, new Map());
        const refused = !!ua && requiresAttestedUpstream(body, disc) && !ua.attested;
        const served = toolkit.servedWith(ctx, cand, ua);
        if (ua) await recordGpuAttested(ctx.db, r.model.id, cand.providerId, ua).catch((e) => log.error("recording gpu attestation failed", { error: (e as Error).message }));
        const payload = {
          v: 1,
          id,
          issued: new Date().toISOString(),
          router: ctx.cfg.publicUrl,
          model: r.model.id,
          provider: cand.providerId,
          tokens: { prompt: usage.prompt, completion: 0, reasoning: 0, cached: 0, estimated: usage.estimated },
          cost: picoToUsdString(charged),
          cost_details: { upstream: picoToUsdString(cost.upstream), royalty: picoToUsdString(cost.royalty), margin: picoToUsdString(cost.margin), ...(batchLine ? { batch_discount: picoToUsdString(cost.batchDiscount) } : {}) },
          paid_with: null,
          latency_ms: Math.round(res.latencyMs),
          quant: cand.quant,
          mode,
          disclosure: served.class,
          lane: disc.lane,
          ...(served.simulated ? { attestation_simulated: true } : {}),
          payer: key?.chainKeyHash ?? paid?.payer ?? null,
          payment_tx: paid?.txHash ?? null,
          ...(pass ? blindReceipt(pass) : {}), // no account: the receipt names the spent token by its hash
          request_sha256: sha256(JSON.stringify(body)),
          response_sha256: sha256(JSON.stringify(res.json.data)),
          ...(ua ? { upstream_attestation: compactUpstream(ua) } : {}),
          ...(batchLine ? { batch: { id: batchLine.batchId, line: batchLine.idx } } : {}),
        };
        const signed = ctx.signer.sign(payload);
        await ctx.db.insert(generations).values({
          id,
          keyHash: key?.keyHash ?? null,
          accountId,
          modelId: r.model.id,
          providerId: cand.providerId,
          tokensIn: usage.prompt,
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
        const usageJson = { prompt_tokens: usage.prompt, total_tokens: usage.prompt, cost: picoToUsd(charged), cost_details: { upstream_inference_cost: picoToUsd(cost.upstream), royalty: picoToUsd(cost.royalty), ...(key ? {} : { margin: picoToUsd(cost.margin) }), ...(tier ? { holder_discount: picoToUsd(cost.holderDiscount) } : {}), ...(batchLine ? { batch_discount: picoToUsd(cost.batchDiscount) } : {}) } };
        const receiptJson = { id, sig: signed.sig, key_id: signed.keyId, alg: "Ed25519", payload };
        const headers = { ...generationHeaders(id, disc.lane, servedPolicyHash(ctx, cand)), "x-anyroute-disclosure": served.class, ...(paid?.paymentResponse ? { "x-payment-response": paid.paymentResponse } : {}) };
        // The gateway had already done (and billed) the work: the vectors are withheld, and the receipt records why.
        if (refused) return c.json({ ...unattestedUpstream(ua!).toJSON(), id, usage: usageJson, receipt: receiptJson }, 502, headers);
        return c.json({
          ...res.json,
          id,
          model: r.model.id,
          provider: cand.provider.name,
          usage: usageJson,
          ...(tier ? { holder: { tier: tier.name, rpm_multiplier: tier.rpmMultiplier, discount_bps: tier.discountBps } } : {}),
          ...(pass ? { blind: redemptionSummary(pass, charged) } : {}),
          receipt: receiptJson,
        }, 200, headers);
      }
    } catch (e) {
      await release(ctx.db, id);
      if (pass) await unclaimToken(ctx, pass);
      throw e;
    }
    await release(ctx.db, id);
    if (pass) await unclaimToken(ctx, pass); // nothing was served: the token is not spent
    fail(502, "All providers for this request failed. Nothing was charged.", "providers_unavailable", { attempts });
  };
  app.post("/api/v1/embeddings", handler);
  app.post("/v1/embeddings", handler);
}
