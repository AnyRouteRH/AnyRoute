import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Catalog } from "../catalog/catalog.ts";
import type { Db, Tx } from "../db/client.ts";
import { savedRoutes } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";

// Saved Routes: a named routing policy an account calls as `model: "@route/<slug>"` (like
// OpenRouter presets). A route holds ordered fallback models, provider preferences and default
// sampling parameters. It never holds prompt or system-prompt text: `params` is a closed whitelist
// of numeric/enum sampling controls (plus short stop sequences), so no message content can be stored.
//
// Resolution precedence, highest first:
//   1. what the request sets explicitly (`models`, each `provider.*` field, each parameter)
//   2. a key's LiteLLM alias (keys.routing.aliases) that points at the route
//   3. the saved route
//   4. the key's default provider preferences (keys.routing.provider)
// The key's allowed_models and guardrails still apply to whatever the route resolves to.

export const ROUTE_PREFIX = "@route/";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const MAX_ROUTES_PER_ACCOUNT = 100;
export const MAX_ROUTE_MODELS = 8;
const NESTED = /^@route\//i;

const slug = z.string().regex(SLUG_RE, "must be 2-48 characters of lowercase letters, digits and hyphens, starting with a letter or digit");
const name = z.string().trim().min(1, "must not be empty").max(80);
const description = z.string().trim().max(280);

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((m) => !NESTED.test(m), "a saved route cannot point to another @route/");
const models = z
  .array(modelId)
  .min(1, "list at least one model")
  .max(MAX_ROUTE_MODELS, `list at most ${MAX_ROUTE_MODELS} models`)
  .refine((list) => new Set(list).size === list.length, "list each model once");

const providerSlug = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "must be a provider slug");
const providerList = z.array(providerSlug).max(32);
const usdPerMillion = z.number().finite().nonnegative().max(1_000_000);

/** OpenRouter provider preferences a route may pin. */
export const routeProviderSchema = z.strictObject({
  order: providerList.optional(),
  only: providerList.optional(),
  ignore: providerList.optional(),
  allow_fallbacks: z.boolean().optional(),
  sort: z.enum(["price", "latency", "throughput"]).optional(),
  data_collection: z.enum(["allow", "deny"]).optional(),
  zdr: z.boolean().optional(),
  require_parameters: z.boolean().optional(),
  // USD per 1M tokens for prompt/completion, USD per request/image (as in `provider.max_price`).
  max_price: z.strictObject({ prompt: usdPerMillion.optional(), completion: usdPerMillion.optional(), request: usdPerMillion.optional(), image: usdPerMillion.optional() }).optional(),
});

const stopSequence = z.string().min(1).max(32);
/** Default request parameters a route may set: sampling controls only, never message content. */
export const routeParamsSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(1000).optional(),
  min_p: z.number().min(0).max(1).optional(),
  top_a: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  repetition_penalty: z.number().gt(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(1_000_000).optional(),
  seed: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  stop: z.union([stopSequence, z.array(stopSequence).min(1).max(4)]).optional(),
  reasoning: z
    .strictObject({ effort: z.enum(["minimal", "low", "medium", "high"]).optional(), max_tokens: z.number().int().min(1).max(1_000_000).optional(), exclude: z.boolean().optional(), enabled: z.boolean().optional() })
    .optional(),
  verbosity: z.enum(["low", "medium", "high"]).optional(),
});

export const routeConfigSchema = z.strictObject({
  models,
  provider: routeProviderSchema.optional(),
  params: routeParamsSchema.optional(),
});
export type RouteConfig = z.infer<typeof routeConfigSchema>;

export const routeCreateSchema = z.object({
  slug,
  name: name.optional(), // defaults to the slug
  description: description.optional(),
  config: routeConfigSchema,
});

/** PATCH: each top-level field is optional; inside `config`, a present section replaces that section and `null` clears it. */
export const routePatchSchema = z.object({
  slug: slug.optional(),
  name: name.optional(),
  description: description.optional(),
  config: z
    .strictObject({
      models: models.optional(),
      provider: routeProviderSchema.nullable().optional(),
      params: routeParamsSchema.nullable().optional(),
    })
    .optional(),
});
export type RoutePatch = z.infer<typeof routePatchSchema>;

/** Drop empty sections so stored configs stay minimal and comparable. */
export function normalizeConfig(config: RouteConfig): RouteConfig {
  const out: RouteConfig = { models: [...config.models] };
  if (config.provider && Object.keys(config.provider).length) out.provider = config.provider;
  if (config.params && Object.keys(config.params).length) out.params = config.params;
  return out;
}

/** Apply a PATCH `config` to the stored one (validated again by the caller). */
export function patchConfig(current: RouteConfig, patch: RoutePatch["config"]): RouteConfig {
  if (!patch) return current;
  const next: RouteConfig = { ...current };
  if (patch.models !== undefined) next.models = patch.models;
  if (patch.provider === null) delete next.provider;
  else if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.params === null) delete next.params;
  else if (patch.params !== undefined) next.params = patch.params;
  return normalizeConfig(next);
}

/** Model ids (as given) that the live catalog cannot resolve, including routing suffixes. */
export function unknownModels(catalog: Pick<Catalog, "resolve">, ids: string[]) {
  return ids.filter((id) => !catalog.resolve(id));
}

/** Serialize route creation and renames per account (limit + slug checks are then race-free). */
export async function lockAccountRoutes(tx: Tx, accountId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"saved_routes:" + accountId}, 0))`);
}

/** `@route/<slug>` -> slug; anything else -> null. */
export function routeSlugOf(model: unknown): string | null {
  return typeof model === "string" && model.startsWith(ROUTE_PREFIX) ? model.slice(ROUTE_PREFIX.length) : null;
}

export async function findSavedRoute(db: Db, accountId: string, routeSlug: string) {
  if (!SLUG_RE.test(routeSlug)) return null;
  const [row] = await db.select().from(savedRoutes).where(and(eq(savedRoutes.accountId, accountId), eq(savedRoutes.slug, routeSlug)));
  return row ?? null;
}

/**
 * Fill a request body in place from a route config. Values the request sets explicitly win:
 * `models` (the whole fallback list), each top-level `provider` field, and each parameter.
 * `max_tokens` counts as set when the request sends either `max_tokens` or `max_completion_tokens`.
 */
export function applyRouteConfig(body: Record<string, unknown>, config: RouteConfig) {
  body.model = config.models[0];
  if (body.models == null) body.models = [...config.models];
  if (config.provider) body.provider = { ...structuredClone(config.provider), ...((body.provider as object | undefined) ?? {}) };
  for (const [k, v] of Object.entries(config.params ?? {})) {
    if (v === undefined || body[k] !== undefined) continue;
    if (k === "max_tokens" && body.max_completion_tokens !== undefined) continue;
    body[k] = structuredClone(v);
  }
  return body;
}

/**
 * Chat/completions hook: when `model` is `@route/<slug>`, load the caller's route and merge it into
 * the body. Returns the slug, or null when the request does not name a route.
 */
export async function resolveSavedRoute(db: Db, accountId: string | null, body: Record<string, unknown>): Promise<string | null> {
  if (Array.isArray(body.models) && body.models.some((m) => typeof m === "string" && NESTED.test(m)))
    fail(400, "`models` cannot contain `@route/` entries; pass a saved route as `model`.", "invalid_request");
  const routeSlug = routeSlugOf(body.model);
  if (routeSlug === null) return null;
  const shown = `@route/${routeSlug.slice(0, 60)}`;
  if (!accountId) fail(401, `${shown} is a saved route: call it with an API key of the account that saved it.`, "missing_key");
  const row = await findSavedRoute(db, accountId, routeSlug);
  if (!row) fail(404, `No saved route ${shown} in this account. List yours with GET /api/v1/routes.`, "route_not_found");
  const config = routeConfigSchema.safeParse(row.config);
  if (!config.success) fail(409, `Saved route ${shown} no longer validates; update it with PATCH /api/v1/routes/${row.slug}.`, "route_invalid");
  applyRouteConfig(body, config.data);
  return row.slug;
}
