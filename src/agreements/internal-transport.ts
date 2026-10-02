import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { selectProviders, attestationFresh } from "../router/select.ts";
import { profileOf } from "../router/disclosure.ts";
import { attestationRefOf } from "../router/council.ts";
import { estimatePromptTokens, maxOutputTokens, readUsage, upstreamCost } from "../router/pricing.ts";
import { callUpstream, providerKey, upstreamBody } from "../providers/upstream.ts";
import { compactUpstream, verifyAciExchange } from "../providers/aci.ts";
import { JURY_RUBRIC, verdictSchema } from "./verdict.ts";
import type { Vote } from "./jury.ts";

const juryBody = (model: string, bundle: unknown) => ({ model, stream: false, temperature: 0, max_tokens: 768,
  messages: [{ role: "system", content: JURY_RUBRIC }, { role: "user", content: canonicalJson(bundle) }] });

/** The router's attested-lane filters, including disclosure, model policy, network admission and outages. */
export function juryCandidates(ctx: Ctx, model: string, bundle: unknown) {
  const resolved = ctx.catalog.resolve(model);
  if (!resolved) return [];
  return selectProviders({ modelId: resolved.model.id, offers: ctx.catalog.offers(resolved.model.id),
    prefs: { lane: "attested", disclosure: "none" }, modifiers: resolved.modifiers,
    requestParams: ["temperature", "max_tokens"], estimatedTokens: estimatePromptTokens(juryBody(model, bundle)),
    health: ctx.health, production: ctx.cfg.production, attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
    disclosure: id => profileOf(ctx.catalog.disclosure.get(id)), modelLane: ctx.catalog.laneOf(resolved.model),
    attestedBonus: ctx.cfg.routing.attestedBonus, rand: ctx.rand,
  }).ordered.filter(c => attestationFresh(c, ctx.cfg.attestation.intervalMs * 3, true));
}

/** Deterministic model order; provider ordering retains normal router weighting. */
export function selectableJuryModels(ctx: Ctx, bundle: unknown): string[] {
  return [...ctx.catalog.models.keys()].sort().filter(model => juryCandidates(ctx, model, bundle).length > 0);
}

/** Operator inference: stored provider credentials and quote-pinned TLS, without customer holds or billing. */
export async function callInternalJuryModel(ctx: Ctx, model: string, bundle: unknown): Promise<Vote> {
  const vote: Vote = { model, verdict: null, receipt_id: null, receipt_url: null, policy_hash: null, failure: null };
  if (!ctx.cfg.agreements.internal) return { ...vote, failure: "internal_jury_disabled" };
  try {
    await ctx.catalog.ensureFresh();
    const candidate = juryCandidates(ctx, model, bundle)[0];
    if (!candidate) return { ...vote, failure: "no_fresh_attested_candidate" };
    const body = juryBody(candidate.modelId, bundle);
    const prompt = estimatePromptTokens(body);
    body.max_tokens = maxOutputTokens(body, candidate, ctx.catalog.models.get(candidate.modelId)!, prompt);
    const upstream = upstreamBody(candidate, body, false).body;
    const apiKey = providerKey(candidate, ctx.cfg.appSecret);
    const result = await callUpstream({ health: ctx.health, // ON3
 appSecret: ctx.cfg.appSecret, candidate, path: "/chat/completions", body: upstream,
      stream: false, apiKey, signal: AbortSignal.timeout(60000), timeoutMs: 60000, firstTokenTimeoutMs: 30000, production: ctx.cfg.production });
    vote.attestation_ref = attestationRefOf(candidate.provider);
    vote.policy_hash = candidate.provider.attestedPolicy?.policyHash ?? null;
    if (!result.ok || result.kind !== "json") return { ...vote, failure: "call_failed" };
    const text = result.json?.choices?.[0]?.message?.content;
    const usage = readUsage(result.json?.usage, { prompt, completion: typeof text === "string" ? Math.ceil(text.length / 4) : 0 });
    // Canaries have no operational-cost ledger. Keep list-price estimates in the existing jury statement.
    vote.operator_cost = { pico_usd: upstreamCost(candidate, usage).cost.toString(), usage, basis: "provider list price; not an invoice; failed calls may still incur unmeasured cost" };
    if (candidate.provider.aci) {
      if (!result.exchange) return { ...vote, failure: "missing_attested_receipt" };
      const checked = await verifyAciExchange({ baseUrl: candidate.provider.baseUrl, gateway: candidate.provider.aci,
        exchange: result.exchange, apiKey, tlsPin: candidate.provider.tlsPin, production: ctx.cfg.production });
      vote.upstream_attestation = compactUpstream(checked);
      if (!checked.attested) return { ...vote, failure: "invalid_upstream_attestation" };
    }
    if (!attestationFresh(candidate, ctx.cfg.attestation.intervalMs * 3, true)) return { ...vote, failure: "attestation_expired" };
    // This is a router-signed operational receipt stored with the vote, not a customer generation or public receipt URL.
    const payload = { format: "anyroute.agreement-jury-call/1", id: `jury-${randomUUID()}`, model,
      provider: candidate.providerId, lane: "attested", request_sha256: sha256(JSON.stringify(upstream)),
      response_sha256: sha256(typeof text === "string" ? text : ""), attestation_ref: vote.attestation_ref,
      upstream_attestation: vote.upstream_attestation ?? null, operator_cost: vote.operator_cost };
    const signed = ctx.signer.sign(payload);
    vote.receipt_id = payload.id;
    vote.internal_receipt = { payload, key_id: signed.keyId, sig: signed.sig };
    const verdict = verdictSchema.safeParse(JSON.parse(typeof text === "string" ? text : ""));
    if (!verdict.success) return { ...vote, failure: "invalid_verdict" };
    vote.verdict = verdict.data;
  } catch { vote.failure = "call_or_verdict_failed"; }
  return vote;
}
