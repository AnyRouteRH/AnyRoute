import { agentReservation } from "../agents/enforce.ts";
import { profileOf } from "../router/disclosure.ts";
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Ctx } from "../context.ts";
import { generations } from "../db/schema.ts";
import { bearer, requireRole, resolveKey } from "./auth.ts";
import { addressBucket, generationHeaders } from "./common.ts";
import { fail } from "../lib/errors.ts";
import { genId, sha256 } from "../lib/util.ts";
import { picoToUsdString } from "../lib/money.ts";
import { reserve, release, settle } from "../ledger/ledger.ts";
import { priceUsage, type Usage } from "../router/pricing.ts";
import { attestationFresh, selectProviders } from "../router/select.ts";
import { requestLane } from "../ohttp/lane.ts";
import { gatewayOrigin } from "../ohttp/origin.ts";
import { noteLane } from "../services/private-stats.ts";
import { paymentHeaderOf } from "../pay/x402.ts";
import { holderTier, scaleLimit, walletOfAccount } from "../holders/tiers.ts";
import { BLIND_POOL, presentBlindToken, requireValue, claimToken, unclaimToken, confirmToken } from "../blind/redeem.ts";
import { blindReceipt } from "../blind/set.ts";
import { receiptLeaf } from "../receipts/merkle.ts";
import { servedPolicyHash } from "./disclosure.ts";
import { providerFetch, boundedJson } from "../providers/network.ts";
import { PHALA_PROVIDER } from "../e2ee/config.ts";
import { assessResponse, configuredGateway, gatewayJson, gatewayTransport, gatewayHeaders } from "../e2ee/gateway.ts";
import { E2EE_HEADERS, MAX_ENVELOPE, MAX_WIRE, SUITE, WireObserver, inputBound, reportedUsage, validateEnvelope } from "../e2ee/protocol.ts";

export function e2eeRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.e2ee.enabled) return;
  if (ctx.cfg.production) configuredGateway(ctx); // startup refuses an enabled adapter without the database provider
  app.get("/api/v1/e2ee/attestation", async c => {
    const nonce = c.req.query("nonce");
    if (!nonce || !/^[0-9a-f]{64}$/.test(nonce)) fail(400, "A fresh 32-byte nonce is required.", "e2ee_invalid_nonce");
    const p = configuredGateway(ctx);
    try {
      const url = new URL(p.attestationUrl!); url.searchParams.set("nonce", nonce);
      const r = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } }, gatewayTransport(ctx, p));
      if (!r.ok) { await r.body?.cancel(); fail(502, "Gateway attestation unavailable.", "e2ee_evidence_unavailable"); }
      return c.json(await boundedJson(r), 200, { "cache-control": "no-store" });
    } catch { fail(502, "Gateway attestation unavailable.", "e2ee_evidence_unavailable"); }
  });
  // Public signed evidence only; the provider credential is never returned.
  app.get("/api/v1/e2ee/receipts/:id", async c => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(c.req.param("id"))) fail(400, "Invalid gateway receipt id.");
    try { return c.json(await gatewayJson(ctx, configuredGateway(ctx), `/aci/receipts/${c.req.param("id")}`), 200, { "cache-control": "no-store" }); }
    catch { fail(502, "Gateway receipt unavailable.", "e2ee_evidence_unavailable"); }
  });
  app.get("/api/v1/e2ee/sessions/:id", async c => {
    if (!/^[0-9a-f]{64}$/.test(c.req.param("id"))) fail(400, "Invalid gateway session id.");
    try { return c.json(await gatewayJson(ctx, configuredGateway(ctx), `/aci/sessions/${c.req.param("id")}`), 200, { "cache-control": "no-store" }); }
    catch { fail(502, "Gateway session unavailable.", "e2ee_evidence_unavailable"); }
  });
  app.post("/api/v1/e2ee/chat/completions", c => runEncrypted(ctx, c));
}

async function runEncrypted(ctx: Ctx, c: Context) {
  const t0 = Date.now();
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, "An encrypted JSON envelope is required.");
  const parts: Uint8Array[] = []; let size = 0;
  try { while (true) { const v = await reader.read(); if (v.done) break; size += v.value.length; if (size > MAX_ENVELOPE) fail(413, "Encrypted envelope exceeds 1 MiB."); parts.push(v.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const wire = Buffer.concat(parts);
  const body = validateEnvelope(wire, c.req.raw.headers);
  const secret = bearer(c.req.header("authorization"));
  const key = secret ? await resolveKey(ctx, secret) : null;
  if (secret && !key) fail(401, "Unknown API key.", "invalid_key");
  if (key) await requireRole(ctx, key, ["owner", "admin", "member"]);
  const pass = key ? null : await presentBlindToken(ctx, c.req.header("authorization"));
  // Content policies cannot run on ciphertext. Refuse keys with those settings rather than bypassing them.
  if (key?.guardrails || key?.routing || key?.payWithDefault || c.req.header("x-pay-with") || c.req.header("x-wallet-auth") || paymentHeaderOf(c)) fail(400, "Encrypted chat supports prepaid keys without content policies, or blind tokens.", "e2ee_unsupported_auth");
  const disc = requestLane(ctx, c, { lane: c.req.header("x-anyroute-lane") === "unlinkable" ? "unlinkable" : "attested", disclosure: "none" }, { hasKey: !!key, hasToken: !!pass, hasWallet: !!c.req.header("x-wallet-auth") });
  noteLane(c.req.raw, disc.lane);
  const tier = key ? await holderTier(ctx, walletOfAccount(key.accountId)) : null;
  if (key) {
    if (!(await ctx.limiter.take(`k:${key.keyHash}`, 1, scaleLimit(key.rpm ?? ctx.cfg.limits.defaultRpm, tier), 60_000)).ok) fail(429, "Request rate limit exceeded.");
  } else if (!gatewayOrigin(c.req.raw)) {
    const from = addressBucket(c, ctx.cfg);
    if (!(await ctx.limiter.take(`blind-ip:${from.id}`, 1, from.scale(ctx.cfg.blind.redeemRpm), 60_000)).ok) fail(429, "Request rate limit exceeded.");
  }
  if (!key && !pass) fail(401, "A prepaid API key or blind token is required.", "unauthorized");
  await ctx.catalog.ensureFresh();
  const p = configuredGateway(ctx);
  const model = ctx.catalog.models.get(body.model);
  const cand = model && selectProviders({ modelId: model.id, offers: ctx.catalog.offers(model.id), prefs: { only: [PHALA_PROVIDER], allow_fallbacks: false, lane: disc.lane, disclosure: "none" }, modifiers: new Set(), requestParams: ["max_tokens", "stream"], estimatedTokens: inputBound(body), health: ctx.health, production: ctx.cfg.production, attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3, disclosure: id => profileOf(ctx.catalog.disclosure.get(id)), modelLane: ctx.catalog.laneOf(model), attestedBonus: ctx.cfg.routing.attestedBonus }).ordered.find(o => o.providerModelId === body.model);
  if (!model || !cand) fail(404, "The exact model is unavailable on the Phala confidential AI provider.", "model_not_found");
  if (key?.allowedModels?.length && !key.allowedModels.includes(model.id)) fail(403, "This key is not allowed to use that model.", "model_not_allowed");
  if (!attestationFresh(cand, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production) || !p.aci || Date.now() / 1000 >= Math.min(p.aci.notAfter, p.aci.staleAfter ?? Infinity) || (ctx.cfg.production && !p.tlsPin)) fail(503, "Fresh gateway attestation is required.", "no_attested_endpoint");
  const prompt = inputBound(body);
  if (prompt + body.max_tokens > (cand.ctx ?? model.ctx) || body.max_tokens > (cand.maxOut ?? model.maxOut ?? 32768)) fail(400, "Reservation exceeds model context or output limits.");
  if (key?.tpm && !(await ctx.limiter.take(`kt:${key.keyHash}`, prompt, scaleLimit(key.tpm, tier), 60_000)).ok) fail(429, "Token rate limit exceeded.");
  const mode = pass ? "blind" : "prepaid";
  const bound: Usage = { prompt, completion: body.max_tokens, reasoning: cand.priceReasoning > cand.priceCompletion ? body.max_tokens : 0, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: true };
  const hold = priceUsage(cand, model, bound, mode, { ...ctx.cfg.fees, royaltyBps: ctx.cfg.fees.defaultRoyaltyBps }, false).total;
  const id = genId(); const accountId = key?.accountId ?? BLIND_POOL;
  if (pass) { requireValue(ctx, pass, hold); await claimToken(ctx, pass); }
  try { await reserve(ctx.db, { ...agentReservation(ctx, () => ({ models: [model.id], lane: disc.lane, max_output_tokens: body.max_tokens, body })), id, accountId, keyHash: key?.keyHash, amount: hold, ttlMs: 15 * 60_000 }); }
  catch (e) { if (pass) await unclaimToken(ctx, pass); throw e; }
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, c.req.raw.signal, AbortSignal.timeout(Math.min(p.timeoutMs ?? ctx.cfg.routing.providerTimeoutMs, 600_000))]);
  const headers = gatewayHeaders(ctx, p); headers.set("content-type", "application/json");
  for (const h of E2EE_HEADERS) headers.set(h, c.req.header(h)!);
  let upstream: Response;
  try {
    upstream = await providerFetch(p.baseUrl.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers, body: wire, redirect: "error", signal }, gatewayTransport(ctx, p));
    if (!upstream.ok || !upstream.body) {
      const status = upstream.status;
      let type = "e2ee_gateway_rejected";
      try { const err = await boundedJson(upstream, 8192) as any; if (/^e2ee_[a-z_]{1,64}$/.test(err?.error?.type ?? "")) type = err.error.type; } catch {}
      fail(status === 400 ? 400 : 502, "The gateway refused encrypted chat.", type);
    }
    if (upstream.headers.get("x-e2ee-applied") !== "true" || upstream.headers.get("x-e2ee-version") !== "2" || upstream.headers.get("x-e2ee-algo") !== SUITE) { await upstream.body.cancel(); fail(502, "The gateway did not apply E2EE v2.", "e2ee_not_applied"); }
  } catch (e) { await release(ctx.db, id); if (pass) await unclaimToken(ctx, pass); if (e instanceof Error && "status" in e) throw e; fail(502, "Encrypted gateway transport failed.", "e2ee_transport_failed"); }
  const upstreamId = upstream.headers.get("x-receipt-id");
  const outHeaders = new Headers({ ...generationHeaders(id, disc.lane, servedPolicyHash(ctx, cand)), "x-anyroute-disclosure": "attested", "cache-control": "no-store", "content-type": body.stream ? "text/event-stream" : "application/json" });
  for (const h of ["x-e2ee-applied", "x-e2ee-version", "x-e2ee-algo"]) outHeaders.set(h, upstream.headers.get(h)!);
  if (upstreamId && /^[A-Za-z0-9._-]{1,128}$/.test(upstreamId)) outHeaders.set("x-e2ee-receipt-id", upstreamId);
  const hash = createHash("sha256"); const observer = new WireObserver();
  let usage: Usage | null = null; let finish: string | null = null; let bytes = 0;
  let finalizing: Promise<void> | undefined;
  const finalize = (complete: boolean) => finalizing ??= (async () => {
    const responseHash = hash.digest("hex");
    let evidence: Awaited<ReturnType<typeof assessResponse>> | null = null;
    if (complete && upstreamId && /^[A-Za-z0-9._-]{1,128}$/.test(upstreamId)) {
      try { evidence = await assessResponse(ctx, p, upstreamId, body.model, responseHash, body.provider.aci_session_ids); } catch {}
    }
    const cost = priceUsage(cand, model, usage ?? bound, mode, { ...ctx.cfg.fees, royaltyBps: ctx.cfg.fees.defaultRoyaltyBps }, false);
    const amount = pass && cost.total > hold ? hold : cost.total;
    const payload = { v: 1, id, issued: new Date().toISOString(), router: ctx.cfg.publicUrl, model: model.id, provider: PHALA_PROVIDER, lane: disc.lane, disclosure: evidence ? "attested" : "vendor-forwarded", mode, payer: key?.chainKeyHash ?? null, ...(pass ? blindReceipt(pass) : {}), end_to_end_encrypted: true, e2ee: { version: 2, suite: SUITE, gateway_attested: true, complete: complete && !!evidence, billing_basis: usage ? "gateway_reported_usage" : "reservation_bound", input_byte_bound: prompt, max_tokens: body.max_tokens, request_bytes: wire.length, response_bytes: bytes, gateway_receipt: evidence }, attestation: p.attestationHash, tokens: { prompt: (usage ?? bound).prompt, completion: (usage ?? bound).completion, estimated: !usage }, request_sha256: sha256(wire), response_sha256: responseHash, cost: "" };
    // Ledger close + generation + token confirmation are one transaction. A receipt failure cannot leave a charge without its row.
    await ctx.db.transaction(async tx => {
      const settled = await settle(tx as unknown as Ctx["db"], id, amount, { generationId: id, description: "Encrypted chat" });
      payload.cost = picoToUsdString(settled.charged);
      const signed = ctx.signer.sign(payload);
      await tx.insert(generations).values({ id, accountId, keyHash: key?.keyHash ?? null, modelId: model.id, providerId: PHALA_PROVIDER, mode, cost: settled.charged, upstreamCost: cost.upstream, royalty: cost.royalty, margin: cost.margin, tokensIn: (usage ?? bound).prompt, tokensOut: (usage ?? bound).completion, streamed: !!body.stream, cancelled: !complete, finishReason: complete ? finish : "error", latencyMs: Date.now() - t0, generationTimeMs: Date.now() - t0, attestationHash: p.attestationHash, receiptId: id, receipt: payload, receiptSig: signed.sig, receiptKeyId: signed.keyId, receiptLeaf: receiptLeaf(signed.bytes, signed.sigBytes), requestSha256: payload.request_sha256, responseSha256: responseHash });
      if (pass) await confirmToken({ ...ctx, db: tx as unknown as Ctx["db"] }, pass, id);
    });
    if (!complete || !evidence) throw new Error("Encrypted response incomplete or gateway evidence invalid");
  })();
  const source = upstream.body!.getReader();
  const jsonParts: Uint8Array[] = [];
  const responseStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const v = await source.read();
        if (v.done) {
          let complete = false;
          if (body.stream) { complete = observer.complete(); usage = observer.usage; finish = observer.finish; }
          else { const json = JSON.parse(Buffer.concat(jsonParts).toString("utf8")); usage = reportedUsage(json); finish = typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : null; complete = !json.error && !!finish; }
          await finalize(complete); controller.close(); source.releaseLock(); return;
        }
        hash.update(v.value); bytes += v.value.length;
        if (bytes > MAX_WIRE) throw new Error("Encrypted response exceeds size limit");
        if (body.stream) { observer.feed(v.value); usage = observer.usage; } else jsonParts.push(v.value);
        controller.enqueue(v.value);
      } catch {
        abort.abort(); await source.cancel().catch(() => {});
        try { await finalize(false); } catch {}
        controller.error(new Error("Encrypted gateway response could not be completed."));
      }
    },
    async cancel() { abort.abort(); await source.cancel().catch(() => {}); try { await finalize(false); } catch {} },
  });
  return new Response(responseStream, { status: 200, headers: outHeaders });
}
