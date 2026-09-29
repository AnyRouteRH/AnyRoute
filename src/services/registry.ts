import { openProviderHeaders } from "../providers/headers.ts";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { canaries, models, offers, providers } from "../db/schema.ts";
import { usdToPico } from "../lib/money.ts";
import { boundedJson, providerFetch } from "../providers/network.ts";
import { loadTlsPins, type TlsPin } from "../providers/tls-pin.ts";
import { decrypt, log } from "../lib/util.ts";
import { isPerMillionCatalogue, normalizePerMillionCatalogue } from "../providers/per-million.ts";

// provider-registry: pulls each provider's /models (OpenRouter provider-spec shape), validates it,
// diffs it into `offers`, creates unknown models, drives onboarding
// (applied -> operator approval -> shadow (7 days of canaries) -> live) and republishes the catalog.

const price = z.union([z.string(), z.number()]).transform((v) => String(v));
export const providerModelSpec = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  created: z.number().optional(),
  description: z.string().optional(),
  hugging_face_id: z.string().nullable().optional(),
  canonical_slug: z.string().optional(),
  openrouter: z.object({ slug: z.string() }).partial().optional(),
  anyroute: z.object({ slug: z.string() }).partial().optional(),
  input_modalities: z.array(z.string()).optional(),
  output_modalities: z.array(z.string()).optional(),
  quantization: z.string().optional(),
  context_length: z.number().int().positive(),
  max_output_length: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  pricing: z.object({
    prompt: price,
    completion: price,
    request: price.optional(),
    image: price.optional(),
    web_search: price.optional(),
    internal_reasoning: price.optional(),
    input_cache_read: price.optional(),
    input_cache_write: price.optional(),
  }),
  supported_sampling_parameters: z.array(z.string()).optional(),
  supported_parameters: z.array(z.string()).optional(),
  supported_features: z.array(z.string()).optional(),
  is_moderated: z.boolean().optional(),
  datacenters: z.array(z.object({ country_code: z.string() }).or(z.string())).optional(),
});
export type ProviderModel = z.infer<typeof providerModelSpec>;

const FEATURE_PARAMS: Record<string, string[]> = {
  tools: ["tools", "tool_choice", "parallel_tool_calls"],
  json_mode: ["response_format"],
  structured_outputs: ["response_format", "structured_outputs"],
  reasoning: ["reasoning", "include_reasoning"],
  logprobs: ["logprobs", "top_logprobs"],
  web_search: ["web_search_options"],
};

export function slugFor(m: ProviderModel): string {
  const s = m.anyroute?.slug ?? m.openrouter?.slug ?? m.canonical_slug ?? (m.id.includes("/") ? m.id : m.hugging_face_id ?? m.id);
  return s.toLowerCase();
}

export function supportedParams(m: ProviderModel) {
  const set = new Set([...(m.supported_sampling_parameters ?? []), ...(m.supported_parameters ?? [])]);
  for (const f of m.supported_features ?? []) for (const p of FEATURE_PARAMS[f] ?? [f]) set.add(p);
  set.add("max_tokens");
  set.add("stream");
  return [...set].sort();
}

/** Parse a provider /models body. Returns valid models and per-model validation errors. */
export function parseProviderModels(json: unknown) {
  const list = Array.isArray((json as { data?: unknown })?.data) ? ((json as { data: unknown[] }).data) : Array.isArray(json) ? (json as unknown[]) : null;
  if (!list) return { ok: [] as ProviderModel[], errors: ["Response must be {data: [...]} or an array."] };
  const ok: ProviderModel[] = [];
  const errors: string[] = [];
  for (const [i, item] of list.entries()) {
    const r = providerModelSpec.safeParse(item);
    if (r.success) ok.push(r.data);
    else errors.push(`#${i} ${(item as { id?: string })?.id ?? "?"}: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join(", ")}`);
  }
  return { ok, errors };
}

type RegistryConfig = { cfg: Pick<Ctx["cfg"], "appSecret" | "production"> };
type DiscoveryProvider = Pick<typeof providers.$inferSelect, "status" | "staticModels" | "headers" | "apiKeyEnc" | "baseUrl"> & { tlsPin?: TlsPin | null };

export async function fetchProviderModels(ctx: RegistryConfig, p: DiscoveryProvider) {
  if (!["shadow", "live"].includes(p.status)) throw new Error("Provider requires operator approval before discovery.");
  if (p.staticModels) return parseProviderModels({ data: p.staticModels });
  const headers: Record<string, string> = { accept: "application/json", ...openProviderHeaders(ctx.cfg.appSecret, p.headers) };
  if (p.apiKeyEnc) headers.authorization = `Bearer ${decrypt(ctx.cfg.appSecret, p.apiKeyEnc)}`;
  const res = await providerFetch(p.baseUrl.replace(/\/$/, "") + "/models", { headers, redirect: "error", signal: AbortSignal.timeout(20_000) }, { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production, tlsPin: p.tlsPin });
  if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
  const json = await boundedJson(res);
  return parseProviderModels(isPerMillionCatalogue(json) ? normalizePerMillionCatalogue(json) : json);
}

export async function syncProvider(ctx: RegistryConfig & { db: Db | Tx }, p: typeof providers.$inferSelect & { tlsPin?: TlsPin | null }) {
  const { ok, errors } = await fetchProviderModels(ctx, p);
  const now = new Date();
  const seen: string[] = [];
  for (const m of ok) {
    const slug = slugFor(m);
    const [author] = slug.split("/");
    await ctx.db
      .insert(models)
      .values({
        id: slug,
        author: author ?? "unknown",
        name: m.name ?? slug,
        description: m.description ?? "",
        ctx: m.context_length,
        maxOut: m.max_completion_tokens ?? m.max_output_length ?? null,
        arch: {
          modality: `${(m.input_modalities ?? ["text"]).join("+")}->${(m.output_modalities ?? ["text"]).join("+")}`,
          input_modalities: m.input_modalities ?? ["text"],
          output_modalities: m.output_modalities ?? ["text"],
          tokenizer: "Other",
        },
        hfRepo: m.hugging_face_id ?? null,
        createdUnix: m.created ?? Math.floor(Date.now() / 1000),
      })
      .onConflictDoNothing();
    const offerStatus = p.status === "live" ? "live" : "shadow";
    const values = {
      providerModelId: m.id,
      pricePrompt: usdToPico(m.pricing.prompt),
      priceCompletion: usdToPico(m.pricing.completion),
      priceRequest: usdToPico(m.pricing.request ?? "0"),
      priceImage: usdToPico(m.pricing.image ?? "0"),
      priceWebSearch: usdToPico(m.pricing.web_search ?? "0"),
      priceReasoning: usdToPico(m.pricing.internal_reasoning ?? "0"),
      priceCacheRead: m.pricing.input_cache_read != null ? usdToPico(m.pricing.input_cache_read) : null,
      priceCacheWrite: m.pricing.input_cache_write != null ? usdToPico(m.pricing.input_cache_write) : null,
      quant: (m.quantization ?? "unknown").toLowerCase(),
      ctx: m.context_length,
      maxOut: m.max_completion_tokens ?? m.max_output_length ?? null,
      supportedParameters: supportedParams(m),
      features: { supported_features: m.supported_features ?? [] },
      isModerated: !!m.is_moderated,
      updatedAt: now,
    };
    await ctx.db
      .insert(offers)
      .values({ modelId: slug, providerId: p.id, status: offerStatus, ...values })
      .onConflictDoUpdate({ target: [offers.modelId, offers.providerId], set: values });
    seen.push(slug);
  }
  // Offers the provider no longer lists are disabled (never deleted: generations reference them).
  if (seen.length) await ctx.db.update(offers).set({ status: "disabled", updatedAt: now }).where(and(eq(offers.providerId, p.id), notInArray(offers.modelId, seen)));
  return { models: ok.length, errors };
}

async function advanceOnboarding(ctx: Ctx, p: typeof providers.$inferSelect, _schemaOk: boolean) {
  if (p.status === "shadow" && p.shadowUntil && p.shadowUntil.getTime() <= Date.now()) {
    // Promote only with canary data and no quantization mismatch in the shadow window.
    const rows = await ctx.db.select().from(canaries).where(eq(canaries.providerId, p.id));
    const recent = rows.filter((r) => r.ts.getTime() >= p.shadowUntil!.getTime() - ctx.cfg.canaries.shadowDays * 86_400_000);
    const mismatch = recent.some((r) => r.quantMatch === false);
    if (recent.length && !mismatch) {
      await ctx.db.update(providers).set({ status: "live", updatedAt: new Date() }).where(eq(providers.id, p.id));
      await ctx.db.update(offers).set({ status: "live" }).where(and(eq(offers.providerId, p.id), eq(offers.status, "shadow")));
      log.info("provider promoted to live", { provider: p.id });
    }
  }
}

export async function runRegistry(ctx: Ctx) {
  const rows = await ctx.db.select().from(providers).where(inArray(providers.status, ["shadow", "live"]));
  const pins = await loadTlsPins(ctx.db);
  const results: Record<string, unknown> = {};
  for (const p of rows) {
    try {
      const r = await syncProvider(ctx, { ...p, tlsPin: pins.get(p.id) ?? null });
      results[p.id] = r;
      await advanceOnboarding(ctx, p, r.models > 0);
    } catch (e) {
      results[p.id] = { error: (e as Error).message };
      log.warn("provider sync failed", { provider: p.id, error: (e as Error).message });
    }
  }
  await ctx.catalog.refresh();
  return results;
}
