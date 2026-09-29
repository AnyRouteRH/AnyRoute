import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { priceString } from "../lib/money.ts";
import { blendedPrice, attestationFresh } from "../router/select.ts";
import { fail } from "../lib/errors.ts";
import { parseLane } from "../router/disclosure.ts";
import { VARIANTS, isVariant, type Variant } from "../router/lane.ts";
import { servedDisclosure } from "./disclosure.ts";
import { laneJson, offerEligible } from "./lane.ts";

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

/** Live offers that may serve the model now: a restricted variant lists only attested, classifier-enabled endpoints. */
const servable = (ctx: Ctx, m: ModelRow) => {
  const lane = ctx.catalog.laneOf(m);
  return ctx.catalog.offers(m.id).filter(live).filter((o) => offerEligible(ctx, lane, o));
};

/** ?variant=abliterated,native_low_refusal: null when unset, 400 for anything that is not a variant. */
export function parseVariants(raw: unknown): Set<Variant> | null {
  if (raw == null || raw === "") return null;
  const parts = String(raw).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!parts.length || !parts.every(isVariant)) return fail(400, `\`variant\` must be one or more of: ${VARIANTS.join(", ")}.`, "invalid_request");
  return new Set(parts as Variant[]);
}

export function modelJson(ctx: Ctx, m: ModelRow) {
  const offers = servable(ctx, m);
  const paid = offers.filter((o) => o.pricePrompt > 0n || o.priceCompletion > 0n);
  const ref = [...(paid.length ? paid : offers)].sort((a, b) => blendedPrice(a) - blendedPrice(b))[0];
  const top = [...offers].sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0))[0];
  const supported = [...new Set(offers.flatMap((o) => o.supportedParameters ?? []))].sort();
  const arch = (m.arch ?? {}) as Record<string, unknown>;
  // How many live endpoints serve a prompt under each disclosure class (see GET /api/v1/disclosure/{providerId}).
  const classes = { attested: 0, policy: 0, "vendor-forwarded": 0 };
  for (const o of offers) classes[servedDisclosure(ctx, o).class]++;
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
    disclosure: { best: classes.attested ? "attested" : classes.policy ? "policy" : classes["vendor-forwarded"] ? "vendor-forwarded" : null, endpoints: classes },
    creator: m.creator ?? null,
    royalty_bps: m.creator ? m.royaltyBps : 0,
    ...laneJson(ctx, m),
  };
}

export function modelsRoutes(app: Hono, ctx: Ctx) {
  const list = async (c: import("hono").Context) => {
    await ctx.catalog.ensureFresh();
    const need = (c.req.query("supported_parameters") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    // ?lane=attested keeps only models with at least one endpoint served under attested retention; public (or unset) keeps all.
    const lane = parseLane(c.req.query("lane"), "`lane`");
    // ?variant= keeps models of those variants (mainstream, native_low_refusal, abliterated). A restricted variant is
    // listed only while an attested provider that reports the classifier serves it.
    const variants = parseVariants(c.req.query("variant"));
    const data = [...ctx.catalog.models.values()]
      .filter((m) => !m.hidden && servable(ctx, m).length > 0)
      .map((m) => modelJson(ctx, m))
      .filter((m) => need.every((p) => m.supported_parameters.includes(p)))
      .filter((m) => lane !== "attested" || m.disclosure.endpoints.attested > 0)
      .filter((m) => !variants || variants.has(m.variant))
      .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
    return c.json({ data });
  };
  app.get("/api/v1/models", list);
  app.get("/v1/models", list);

  app.get("/api/v1/models/:author/:slug/endpoints", async (c) => {
    await ctx.catalog.ensureFresh();
    const id = `${c.req.param("author")}/${c.req.param("slug")}`;
    const r = ctx.catalog.resolve(id);
    if (!r) fail(404, `Model ${id} not found.`, "model_not_found");
    const m = r.model;
    const endpoints = servable(ctx, m).map((o) => {
      const h = ctx.health.snapshot(m.id, o.providerId);
      const observed = ctx.health.observedUptime(m.id, o.providerId);
      return {
        name: `${o.provider.name} | ${m.id}`,
        provider_name: o.provider.name,
        provider_slug: o.providerId,
        tag: o.providerId,
        context_length: o.ctx ?? m.ctx,
        max_completion_tokens: o.maxOut ?? m.maxOut ?? null,
        max_prompt_tokens: null,
        pricing: offerPricing(o),
        quantization: o.quant,
        supported_parameters: o.supportedParameters ?? [],
        status: h.outage ? -1 : 0,
        uptime_last_30d: observed ? Number((observed.rate * 100).toFixed(2)) : null,
        quality_score: Number(h.quality.toFixed(3)),
        latency_last_30m: h.stats?.latency ?? null,
        throughput_last_30m: h.stats?.throughput ?? null,
        data_policy: o.provider.dataPolicy,
        attested: attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production),
        attestation_hash: o.provider.attestationHash ?? null,
        // True only while the attestation is fresh and it reported the in-enclave classifier as enabled.
        classifier_enabled: o.provider.classifierEnabled && attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production),
        disclosure: servedDisclosure(ctx, o).class,
        bond_usdg: o.provider.bondUsdg.toString(),
        is_moderated: o.isModerated,
      };
    });
    const mj = modelJson(ctx, m);
    return c.json({ data: { id: m.id, name: m.name, created: m.createdUnix, description: m.description, architecture: mj.architecture, endpoints } });
  });

  app.get("/api/v1/providers", async (c) => {
    await ctx.catalog.ensureFresh();
    const data = [...ctx.catalog.providers.values()]
      .filter((p) => p.status !== "applied")
      .map((p) => {
        const live = [...ctx.catalog.offersByModel.values()].flat().filter((o) => o.providerId === p.id && o.status === "live");
        const snaps = live.map((o) => ctx.health.snapshot(o.modelId, o.providerId));
        const lat = snaps.map((h) => h.stats?.latency.p50).filter((x): x is number => x != null).sort((a, b) => a - b);
        const fresh = live.some((o) => attestationFresh(o, ctx.cfg.attestation.intervalMs * 3, ctx.cfg.production));
        // Measured success rate across this provider's models (the routing weight uses a smoothed prior instead).
        const obs = live.map((o) => ctx.health.observedUptime(o.modelId, o.providerId)).filter((x): x is { rate: number; events: number } => !!x);
        const events = obs.reduce((a, x) => a + x.events, 0);
        return {
        name: p.name,
        slug: p.id,
        status: p.status,
        uptime_30d: events ? Number(((obs.reduce((a, x) => a + x.rate * x.events, 0) / events) * 100).toFixed(2)) : null,
        health_events_30d: events,
        latency_p50_ms: lat.length ? lat[Math.floor(lat.length / 2)] : null,
        outage: snaps.some((h) => h.outage),
        quantizations: [...new Set(live.map((o) => o.quant))],
        attestation_fresh: fresh,
        attestation_hash: p.attestationHash ?? null,
        classifier_enabled: p.classifierEnabled && fresh,
        data_policy: p.dataPolicy,
        datacenters: p.datacenter ?? [],
        attested: p.attested,
        tee: p.teeKind,
        attested_at: p.attestedAt?.toISOString() ?? null,
        bond_usdg: p.bondUsdg.toString(),
        anyr_stake: p.anyrStake.toString(),
        models: live.length,
        };
      });
    return c.json({ data });
  });
}
