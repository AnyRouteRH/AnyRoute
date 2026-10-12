import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { modelCapabilities, modelModalities } from "../catalog/model-capabilities.js";
import { offerLanes } from "../api/models.ts";
import { servedDisclosure } from "../api/disclosure.ts";
import { preservesDisclosure, type PriceModel } from "../insights/suggest.ts";
import { requiredAbilities, selectAlternativeProviders, type SuggestionInput } from "../model-alternatives/suggest.ts";
import { picoToUsdString } from "../lib/money.ts";
import { maxOutputTokens } from "../router/pricing.ts";

export type SavingsMix = {
  model: string; calls: string; tokens_in: string; tokens_out: string; charged_pico: string;
  max_tokens: number; max_output: number; safe: boolean; lanes: string[]; disclosures: string[];
};
export const sameTokenCost = (offer: Candidate, mix: SavingsMix) =>
  offer.pricePrompt * BigInt(mix.tokens_in) + offer.priceCompletion * BigInt(mix.tokens_out) + offer.priceRequest * BigInt(mix.calls);
const metadata = (model: ModelRow, offer: Candidate) => ({ architecture: model.arch, context_length: offer.ctx ?? model.ctx, supported_parameters: offer.supportedParameters });
function declaredModalities(model: ModelRow) {
  const arch = model.arch as { input_modalities?: unknown; output_modalities?: unknown; modality?: unknown };
  return arch && ((Array.isArray(arch.input_modalities) && arch.input_modalities.length > 0 && Array.isArray(arch.output_modalities) && arch.output_modalities.length > 0)
    || (typeof arch.modality === "string" && /^[a-z]+(?:\+[a-z]+)*->[a-z]+(?:\+[a-z]+)*$/.test(arch.modality)));
}
const priced = (o: Candidate) => [o.pricePrompt, o.priceCompletion, o.priceRequest, o.priceImage, o.priceWebSearch, o.priceReasoning].every(p => typeof p === "bigint" && p >= 0n);

/** Records do not retain used abilities. Preserve ALL declared source abilities, not guessed text-only use. */
export function savingsSuggestion(ctx: Ctx, mix: SavingsMix, allowed = new Set<string>()) {
  const source = ctx.catalog.models.get(mix.model);
  const sourceOffers = ctx.catalog.offers(mix.model);
  if (!mix.safe || !source || source.hidden || !declaredModalities(source) || !sourceOffers.length
    || BigInt(mix.tokens_in) + BigInt(mix.tokens_out) <= 0n || !mix.lanes.length || !mix.disclosures.length
    || sourceOffers.some(o => !Array.isArray(o.supportedParameters) || !Number.isSafeInteger(o.ctx ?? source.ctx) || (o.ctx ?? source.ctx) <= 0)) return null;
  const inputs = modelModalities(metadata(source, sourceOffers[0]), "input");
  const outputs = modelModalities(metadata(source, sourceOffers[0]), "output");
  // Audio and non-chat calls cannot be reconstructed from retained token counts.
  if (!inputs.includes("text") || inputs.some(x => !["text", "image"].includes(x)) || outputs.some(x => !["text", "image"].includes(x))) return null;
  const params = [...new Set(sourceOffers.flatMap(o => o.supportedParameters))];
  const body = { messages: [{ role: "user", content: inputs.includes("image") ? [{ type: "image_url" }] : "" }],
    ...(params.includes("tools") ? { tools: [{}] } : {}), modalities: outputs, max_tokens: 0 };
  const needs = requiredAbilities(body);
  const context = Math.max(source.ctx, mix.max_tokens, ...sourceOffers.map(o => o.ctx ?? source.ctx));
  const input: SuggestionInput = { resolved: [{ model: source, modifiers: new Set() }], prefs: {}, params,
    promptTokens: context, byok: new Map(), body, allowed };
  const compatible = (model: ModelRow, offer: Candidate) => {
    const meta = metadata(model, offer);
    return priced(offer) && offer.priceImage === 0n && offer.priceWebSearch === 0n
      && declaredModalities(model) && inputs.every(x => modelModalities(meta, "input").includes(x))
      && outputs.every(x => modelModalities(meta, "output").includes(x))
      && needs.every(x => modelCapabilities(meta).includes(x as never))
      && params.every(x => offer.supportedParameters.includes(x))
      && (offer.ctx ?? model.ctx) >= context && maxOutputTokens({ max_tokens: mix.max_output }, offer, model, 0) >= mix.max_output
      && mix.lanes.every(lane => offerLanes(ctx, offer).includes(lane as never))
      && preservesDisclosure({ disclosure: servedDisclosure(ctx, offer).class } as PriceModel, { ...mix, id: mix.model });
  };
  const eligible = (model: ModelRow) => selectAlternativeProviders(ctx, model, input).ordered.filter(o => compatible(model, o));
  const baselines = eligible(source).map(o => sameTokenCost(o, mix));
  if (!baselines.length) return null;
  const baseline = baselines.reduce((a, b) => a < b ? a : b);
  const charged = BigInt(mix.charged_pico);
  const matches: { model: ModelRow; cost: bigint }[] = [];
  for (const model of ctx.catalog.models.values()) {
    if (model.hidden || model.id === source.id || (allowed.size && !allowed.has(model.id))) continue;
    for (const offer of eligible(model)) {
      const cost = sameTokenCost(offer, mix);
      if (cost < baseline && cost < charged) matches.push({ model, cost });
    }
  }
  // B121's closest token-weighted price, restricted to cheaper matches. A single endpoint supports every ability.
  matches.sort((a, b) => a.cost === b.cost ? a.model.id.localeCompare(b.model.id) : a.cost > b.cost ? -1 : 1);
  const best = matches[0];
  return best ? { model: source.id, name: source.name, calls: mix.calls, tokens_in: mix.tokens_in, tokens_out: mix.tokens_out,
    charged_usd: picoToUsdString(charged), alternative: { model: best.model.id, name: best.model.name,
      estimated_cost_usd: picoToUsdString(best.cost), estimated_saving_usd: picoToUsdString(charged - best.cost) } } : null;
}
