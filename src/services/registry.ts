import { and, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { canaries, models, offers, providers } from "../db/schema.ts";
import { usdToPico } from "../lib/money.ts";
import { decrypt, log } from "../lib/util.ts";

// provider-registry: pulls each provider's /models (OpenRouter provider-spec shape), validates it,
// diffs it into `offers`, creates unknown models, drives onboarding
// (applied -> schema ok + bond -> shadow (7 days of canaries) -> live) and republishes the catalog.

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

export async function fetchProviderModels(ctx: Ctx, p: typeof providers.$inferSelect) {
  if (p.staticModels) return parseProviderModels({ data: p.staticModels });
  const headers: Record<string, string> = { accept: "application/json", ...((p.headers as Record<string, string> | null) ?? {}) };
  if (p.apiKeyEnc) headers.authorization = `Bearer ${decrypt(ctx.cfg.appSecret, p.apiKeyEnc)}`;
  const res = await fetch(p.baseUrl.replace(/\/$/, "") + "/models", { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET /models returned ${res.status}`);
  return parseProviderModels(await res.json());
}
