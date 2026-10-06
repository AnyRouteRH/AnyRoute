// B121: suggestions are response metadata only; they never call a provider or reserve funds.
import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow, Modifier } from "../catalog/catalog.ts";
import { modelCapabilities, modelModalities } from "../catalog/model-capabilities.js";
import type { PriceModel } from "../insights/suggest.ts";
import { ApiError, isApiError } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";
import { OUTAGE_REASON, profileOf } from "../router/disclosure.ts";
import type { Attempt } from "../router/execute.ts";
import { estimatePromptTokens } from "../router/pricing.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";

export type SuggestedModel = { id: string; name: string; prompt_price: string; completion_price: string; why: string };
export type SuggestionInput = {
  resolved: { model: ModelRow; modifiers: Set<Modifier> }[];
  prefs: ProviderPrefs; params: string[]; promptTokens: number; byok: Map<string, string>;
  body: Record<string, unknown>; allowed: Set<string>;
};
const down = (reason: string) => reason === OUTAGE_REASON || /^provider (?!live\b)/.test(reason) || /^offer (?!live\b)/.test(reason);
const failedAvailability = new Set(["http_5xx", "timeout", "connection", "insufficient_credits", "empty200", "unreadable", "interrupted"]);
const abs = (n: bigint) => n < 0n ? -n : n;

/** Inspect content-part types in router memory; do not retain text, image URLs or audio. */
export function requiredAbilities(body: Record<string, unknown>) {
  const tags = new Set<string>();
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "tool" || message?.tool_calls?.length) tags.add("tools");
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (["image_url", "image", "input_image"].includes(part?.type)) tags.add("vision");
      if (["input_audio", "audio"].includes(part?.type)) tags.add("audio");
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) tags.add("tools");
  if (Array.isArray(body.modalities) && body.modalities.includes("image")) tags.add("imageOut");
  if (Array.isArray(body.modalities) && body.modalities.includes("audio")) tags.add("audio");
  return [...tags];
}

function select(ctx: Ctx, model: ModelRow, input: SuggestionInput, modifiers = input.resolved[0].modifiers, ignoreAvailability = false) {
  return selectProviders({ modelId: model.id, offers: ctx.catalog.offers(model.id).map(o => ignoreAvailability ? { ...o, status: "live", provider: { ...o.provider, status: "live" } } : o), prefs: input.prefs, modifiers,
    requestParams: input.params, estimatedTokens: input.promptTokens, byokProviders: new Set(input.byok.keys()),
    health: ignoreAvailability ? { outage: () => false, uptime30d: (m, p) => ctx.health.uptime30d(m, p), quality: (m, p) => ctx.health.quality(m, p), stats: (m, p) => ctx.health.stats(m, p) } : ctx.health, production: ctx.cfg.production, attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
    disclosure: id => profileOf(ctx.catalog.disclosure.get(id)), modelLane: ctx.catalog.laneOf(model), rand: () => 0.5 });
}

export function suggestions(ctx: Ctx, input: SuggestionInput): SuggestedModel[] {
  const source = input.resolved[0]?.model;
  if (!source) return [];
  const needs = requiredAbilities(input.body);
  const sourceOffers = ctx.catalog.offers(source.id);
  const metadata = (model: ModelRow, offer: Candidate) => ({ architecture: model.arch, context_length: offer.ctx ?? model.ctx, supported_parameters: offer.supportedParameters });
  if (!sourceOffers.some(o => needs.every(tag => modelCapabilities(metadata(source, o)).includes(tag as never)))) return [];
  // Reuse the insights endpoint's per-offer PriceModel representation and token-weighted cost approach.
  // Outages need the closest price in either direction, rather than insights' cheaper-only ranking.
  const inputTokens = BigInt(Math.max(1, estimatePromptTokens(input.body)));
  const outputTokens = BigInt(Number(input.body.max_completion_tokens ?? input.body.max_tokens ?? 4096));
  const cost = (o: Pick<PriceModel, "prompt" | "completion" | "request">) => o.prompt * inputTokens + o.completion * outputTokens + o.request;
  const rates = (o: Candidate) => ({ prompt: o.pricePrompt, completion: o.priceCompletion, request: o.priceRequest });
  const baseline = sourceOffers.map(o => cost(rates(o))).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[0];
  if (baseline == null) return [];
  const sourceIds = new Set(input.resolved.map(r => r.model.id));
  const requestedOutputs = Array.isArray(input.body.modalities) && input.body.modalities.length ? input.body.modalities : ["text"];
  const labels: Record<string, string> = { vision: "reads images", tools: "uses tools", imageOut: "makes images", audio: "handles audio" };
  const matches: (SuggestedModel & { distance: bigint })[] = [];
  for (const model of ctx.catalog.models.values()) {
    if (model.hidden || sourceIds.has(model.id) || (input.allowed.size && !input.allowed.has(model.id))) continue;
    const eligible = select(ctx, model, input).ordered.filter(o => {
      const meta = metadata(model, o);
      const inputs = modelModalities(meta, "input"), outputs = modelModalities(meta, "output");
      const needsAudioInput = (Array.isArray(input.body.messages) ? input.body.messages : []).some(message => Array.isArray(message?.content) && message.content.some((part: { type?: string }) => ["input_audio", "audio"].includes(part?.type ?? "")));
      const needsAudioOutput = Array.isArray(input.body.modalities) && input.body.modalities.includes("audio");
      return (!needsAudioInput || inputs.includes("audio")) && (!needsAudioOutput || outputs.includes("audio")) && inputs.includes("text") && requestedOutputs.every(output => outputs.includes(output)) && needs.every(tag => modelCapabilities(meta).includes(tag as never))
        && ["tools", "response_format"].filter(p => input.params.includes(p)).every(p => o.supportedParameters?.includes(p))
        && (o.ctx ?? model.ctx) >= input.promptTokens + Number(outputTokens);
    });
    eligible.sort((a, b) => { const x = abs(cost(rates(a)) - baseline), y = abs(cost(rates(b)) - baseline); return x < y ? -1 : x > y ? 1 : a.providerId.localeCompare(b.providerId); });
    const offer = eligible[0];
    if (!offer) continue;
    matches.push({ id: model.id, name: model.name, prompt_price: picoToUsdString(offer.pricePrompt), completion_price: picoToUsdString(offer.priceCompletion),
      why: `Same abilities: ${needs.length ? needs.map(tag => labels[tag]).join(", ") : "reads and writes text"}`, distance: abs(cost(rates(offer)) - baseline) });
  }
  return matches.sort((a, b) => a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : a.id.localeCompare(b.id)).slice(0, 3).map(({ distance, ...item }) => item);
}

/** Keep the exact error fields and status; add suggestions only for an availability failure. */
export function addSuggestions(error: ApiError, ctx: Ctx, input: SuggestionInput, attempts?: Attempt[]) {
  if (!["no_providers", "providers_unavailable"].includes(error.type) || input.body.verify != null) return error;
  // Proven-only / disclosure refusals never invite a model switch, even when endpoints are down.
  if ((input.prefs.disclosure ?? "any") !== "any" || (input.prefs.lane ?? "public") !== "public" || input.prefs.private || input.resolved.some(r => r.modifiers.has("private"))) return error;
  if (attempts && (!attempts.length || attempts.some(a => !failedAvailability.has(a.error_kind ?? "")))) return error;
  for (const { model, modifiers } of input.resolved) {
    if (ctx.catalog.offers(model.id).length && !select(ctx, model, input, modifiers, true).ordered.length) return error;
    if (ctx.catalog.offers(model.id).some(o => ctx.health.outage(model.id, o.providerId) && ["rate_limited", "rejected", "provider_auth"].includes(ctx.health.lastFailureKind(model.id, o.providerId) ?? ""))) return error;
    const selected = select(ctx, model, input, modifiers);
    if (selected.excluded.some(e => !down(e.reason))) return error;
    if (selected.ordered.some(o => !attempts?.some(a => a.model === model.id && a.provider === o.providerId && failedAvailability.has(a.error_kind ?? "")))) return error;
  }
  error.body = { ...error.toJSON(), suggested_models: suggestions(ctx, input) };
  return error;
}

/** Also preserves availability errors thrown by the existing credit-exhaustion guard. */
export function availabilityFailure(makeError: () => ApiError, ctx: Ctx, input: SuggestionInput, attempts?: Attempt[]) {
  try { return addSuggestions(makeError(), ctx, input, attempts); }
  catch (error) { if (isApiError(error)) return addSuggestions(error, ctx, input, attempts); throw error; }
}

export function selectWithSuggestions<T>(plan: () => T, ctx: Ctx, input: SuggestionInput): T {
  try { return plan(); }
  catch (error) { if (isApiError(error)) throw addSuggestions(error, ctx, input); throw error; }
}
