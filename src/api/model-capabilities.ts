import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { deriveCapabilities } from "../catalog/model-capabilities.js";
import { attestationFresh, selectProviders } from "../router/select.ts";
import { profileOf } from "../router/disclosure.ts";
import { networkSelectionInput } from "../network/routing.ts";
import { PHALA_PROVIDER } from "../e2ee/config.ts";
import { configuredGateway } from "../e2ee/gateway.ts";

/** Public catalogue metadata only: no request content, addresses, new storage or logs. */
export function capabilityJson(ctx: Ctx, model: ModelRow, offers: Candidate[]) {
  const fresh = (offer: Candidate) => attestationFresh(offer, ctx.cfg.attestation.intervalMs * 3, true);
  let encrypted = false;
  if (ctx.cfg.e2ee.enabled) {
    try {
      const gateway = configuredGateway(ctx);
      encrypted = !!gateway.aci && Date.now() / 1000 < Math.min(gateway.aci.notAfter, gateway.aci.staleAfter ?? Infinity)
        && (!ctx.cfg.production || !!gateway.tlsPin)
        && selectProviders({ modelId: model.id, offers, prefs: { only: [PHALA_PROVIDER], allow_fallbacks: false, lane: "attested", disclosure: "none" }, modifiers: new Set(), requestParams: ["max_tokens", "stream"], estimatedTokens: 1, health: ctx.health, production: ctx.cfg.production, attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3, disclosure: id => profileOf(ctx.catalog.disclosure.get(id)), modelLane: ctx.catalog.laneOf(model), attestedBonus: ctx.cfg.routing.attestedBonus }).ordered.some(o => o.providerModelId === model.id && fresh(o));
    } catch { /* An unavailable gateway must not advertise encrypted chat. */ }
  }
  return { provider_names: [...new Set(offers.map(o => o.provider.name))].sort(), capabilities: deriveCapabilities({
    architecture: { input_modalities: (model.arch as { input_modalities?: string[] } | null)?.input_modalities ?? ["text"], output_modalities: (model.arch as { output_modalities?: string[] } | null)?.output_modalities ?? ["text"] }, context_length: model.ctx,
    supported_parameters: [...new Set(offers.flatMap(o => o.supportedParameters ?? []))],
    attested_available: offers.some(fresh),
    network_host_available: offers.some(o => o.provider.networkHost === true && o.provider.networkModels.includes(o.providerModelId) && !o.provider.networkReasons.length && fresh(o)),
    encrypted_chat_available: encrypted,
  }) };
}

/** Apply the existing network eligibility hook so admitted probation offers can join the same catalogue. */
export function catalogOffers(ctx: Ctx, model: ModelRow): Candidate[] {
  const input = networkSelectionInput({ modelId: model.id, offers: ctx.catalog.offers(model.id), modelLane: ctx.catalog.laneOf(model), prefs: {}, modifiers: new Set(), requestParams: [], estimatedTokens: 0, health: ctx.health, production: ctx.cfg.production, attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3 });
  return input.offers.filter(o => !o.provider.networkHost || !input.health.outage(model.id, o.providerId));
}
