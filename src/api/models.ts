import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { priceString } from "../lib/money.ts";
import { blendedPrice, attestationFresh } from "../router/select.ts";
import { fail } from "../lib/errors.ts";

export function offerPricing(o: Candidate) {
  return {
    prompt: priceString(o.pricePrompt),
    completion: priceString(o.priceCompletion),
    request: priceString(o.priceRequest),
    image: priceString(o.priceImage),
    web_search: priceString(o.priceWebSearch),
    internal_reasoning: priceString(o.priceReasoning),
    ...(o.priceCacheRead != null ? { input_cache_read: priceString(o.priceCacheRead) } : {}),
    ...(o.priceCacheWrite != null ? { input_cache_write: priceString(o.priceCacheWrite) } : {}),
  };
}

const live = (o: Candidate) => o.status === "live" && o.provider.status === "live";

export function modelJson(ctx: Ctx, m: ModelRow) {
  const offers = ctx.catalog.offers(m.id).filter(live);
  const paid = offers.filter((o) => o.pricePrompt > 0n || o.priceCompletion > 0n);
  const ref = [...(paid.length ? paid : offers)].sort((a, b) => blendedPrice(a) - blendedPrice(b))[0];
  const top = [...offers].sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0))[0];
  const supported = [...new Set(offers.flatMap((o) => o.supportedParameters ?? []))].sort();
  const arch = (m.arch ?? {}) as Record<string, unknown>;
  const policies = offers.map((o) => (o.provider.dataPolicy ?? {}) as { training?: boolean; retains_prompts?: boolean; zdr?: boolean });
  return {
    id: m.id,
    canonical_slug: m.id,
    hugging_face_id: m.hfRepo ?? "",
    name: m.name,
    created: m.createdUnix,
    description: m.description,
    context_length: m.ctx,
    architecture: {
      modality: arch.modality ?? "text->text",
      input_modalities: arch.input_modalities ?? ["text"],
      output_modalities: arch.output_modalities ?? ["text"],
      tokenizer: arch.tokenizer ?? "Other",
      instruct_type: arch.instruct_type ?? null,
    },
    pricing: ref ? offerPricing(ref) : { prompt: "0", completion: "0", request: "0", image: "0", web_search: "0", internal_reasoning: "0" },
    top_provider: { context_length: top?.ctx ?? m.ctx, max_completion_tokens: top?.maxOut ?? m.maxOut ?? null, is_moderated: top?.isModerated ?? false },
    per_request_limits: null,
    supported_parameters: supported,
    data_policy: {
      zdr_available: policies.some((p) => p.zdr),
      no_training_available: policies.some((p) => !p.training),
      providers: offers.length,
    },
    quantization: [...new Set(offers.map((o) => o.quant))],
    attested_available: offers.some((o) => attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production)),
    creator: m.creator ?? null,
    royalty_bps: m.creator ? m.royaltyBps : 0,
  };
}
