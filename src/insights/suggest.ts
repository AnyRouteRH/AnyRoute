import type { Ctx } from "../context.ts";
import { servable, offerLanes } from "../api/models.ts";
import { servedDisclosure } from "../api/disclosure.ts";
import { capabilityJson } from "../api/model-capabilities.ts";
import { modelCapabilities, modelModalities } from "../catalog/model-capabilities.js";
import { picoToUsdString } from "../lib/money.ts";
import type { readInsights } from "./read.ts";
export type PriceModel = { id: string; name: string; capabilities: string[]; lanes: string[]; context: number; inputs: string[]; outputs: string[]; live: boolean; disclosure: string; prompt: bigint; completion: bigint; request: bigint };
export type Mix = { id: string | null; tokens_in: string; tokens_out: string; calls: string; lanes: string[]; disclosures: string[] };
const disclosureRank: Record<string, number> = { "vendor-forwarded": 0, policy: 1, attested: 2 };
export function preservesDisclosure(candidate: PriceModel, mix: Mix) {
  return mix.disclosures.length > 0 && mix.disclosures.every(value => disclosureRank[value] !== undefined && (disclosureRank[candidate.disclosure] ?? -1) >= disclosureRank[value]);
}
export function suggestPrices(source: PriceModel, mix: Mix, candidates: PriceModel[]) {
  const input = BigInt(mix.tokens_in), output = BigInt(mix.tokens_out), calls = BigInt(mix.calls);
  if (!source.live || !preservesDisclosure(source,mix) || input + output === 0n || !mix.lanes.length || mix.lanes.some(lane => !source.lanes.includes(lane))) return [];
  const cost = (m: PriceModel) => m.prompt * input + m.completion * output + m.request * calls;
  const baseline = cost(source);
  return candidates.filter(m => m.live && preservesDisclosure(m,mix) && m.id !== source.id && m.context >= source.context
    && source.capabilities.every(tag => m.capabilities.includes(tag)) && mix.lanes.every(lane => m.lanes.includes(lane))
    && source.inputs.every(tag => m.inputs.includes(tag)) && source.outputs.every(tag => m.outputs.includes(tag))
    && cost(m) < baseline)
    .map(m => ({ model: m.id, name: m.name, baseline_usd: picoToUsdString(baseline), estimated_cost_usd: picoToUsdString(cost(m)), estimated_saving_usd: picoToUsdString(baseline-cost(m)),
      blended_price_ratio: { numerator_usd: picoToUsdString(cost(m)), denominator_tokens: String(input+output) }, saving: baseline-cost(m) }))
    .sort((a,b) => a.saving === b.saving ? a.model.localeCompare(b.model) : a.saving > b.saving ? -1 : 1)
    .filter((m,i,all) => all.findIndex(other => other.model === m.model) === i).slice(0,3).map(({ saving, ...m }) => m);
}
export async function insightSuggestions(ctx: Ctx, report: Awaited<ReturnType<typeof readInsights>>) {
  await ctx.catalog.ensureFresh();
  const candidates: PriceModel[] = [];
  const sources = new Map<string, PriceModel>();
  for (const m of ctx.catalog.models.values()) {
    if (m.hidden) continue;
    const offers = servable(ctx,m);
    const capabilities = capabilityJson(ctx,m,offers).capabilities;
    for (const o of offers) {
      // Match capabilities and lane on the SAME priced endpoint, rather than unioning separate endpoints.
      const metadata = { architecture: m.arch, context_length: o.ctx ?? m.ctx, supported_parameters: o.supportedParameters };
      const endpoint = { id:m.id, name:m.name, live:true, disclosure:servedDisclosure(ctx,o).class, capabilities: capabilityJson(ctx,m,[o]).capabilities.filter(tag => modelCapabilities(metadata).includes(tag) || ['attested','network','encrypted'].includes(tag)),
        context:o.ctx ?? m.ctx, inputs:modelModalities(metadata,'input'), outputs:modelModalities(metadata,'output'), lanes:offerLanes(ctx,o), prompt:o.pricePrompt, completion:o.priceCompletion, request:o.priceRequest };
      candidates.push(endpoint);
    }
    if (offers.length) sources.set(m.id, { ...candidates.find(c => c.id === m.id)!, capabilities, context:m.ctx });
  }
  return report.top_models_by_cost.flatMap(mix => {
    if (!mix.id) return [];
    const source = sources.get(mix.id); if (!source) return [];
    const eligible = candidates.filter(c => c.id === mix.id && preservesDisclosure(c,mix) && source.capabilities.every(tag => c.capabilities.includes(tag)) && mix.lanes.every(lane => c.lanes.includes(lane)) && c.context >= source.context);
    const total = (c:PriceModel) => c.prompt*BigInt(mix.tokens_in)+c.completion*BigInt(mix.tokens_out)+c.request*BigInt(mix.calls);
    eligible.sort((a,b) => total(a) === total(b) ? 0 : total(a)<total(b) ? -1 : 1);
    if (!eligible.length) return [];
    const alternatives = suggestPrices({ ...eligible[0], capabilities:source.capabilities },mix,candidates);
    return alternatives.length ? [{ model:mix.id, tokens_in:mix.tokens_in, tokens_out:mix.tokens_out, alternatives }] : [];
  });
}
