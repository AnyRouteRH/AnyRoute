import type { Context } from "hono";
import type { Ctx } from "../context.ts";
import type { AgentPolicy } from "../agents/policy.ts";
import { policiesFor } from "../agents/store.ts";
import { profileOf, type Lane } from "../router/disclosure.ts";
import { estimatePromptTokens } from "../router/estimate.ts";
import { selectProviders, type ProviderPrefs } from "../router/select.ts";

// U101: a key's default privacy route, for a request that names no lane.
//
//   standard      today's behaviour and the default: such a request is served on the public lane
//   proven_only   the request is treated exactly as `provider.lane: "attested"`: attested endpoints only, and the same
//                 503 no_attested_endpoint refusal when none can serve it
//   proven_first  lane "attested" when the request's model has an attested endpoint that would take this request right
//                 now; otherwise an ordinary public request, receipted and labelled as one (lane "public"). It is decided
//                 once, before routing: once "attested" is chosen, the attested lane's rules apply unchanged.
//
// The setting lives in the key's rulebook (`route_default`, agents/policy.ts); a session key also follows its parent's,
// and where both set one the stricter applies. It is read only while rulebooks are switched on (AGENT_POLICY_ENABLED).
//
// It applies only when the request names no lane by any existing means: provider.lane, provider.disclosure,
// provider.lane_downgrade, provider.private, a `:private` model, or the X-Anyroute-Lane, X-Anyroute-Disclosure-Max and
// X-Anyroute-Lane-Downgrade headers, including a lane a key alias, saved route, preset or character filled in, and the
// key's own routing defaults (keys.routing.provider) on the endpoints that apply them (chat and rag). It never widens
// access: proven_only only narrows, proven_first picks "attested" only when the rulebook's `lanes` allowlist admits it,
// and the allowlist is still enforced afterwards as before.
//
// Where it runs: one call just before the lane is resolved in chat and text completions (and the routes that run through
// them), embeddings and rerank (applyRouteDefault), and one before POST /api/v1/rag reads its lane (applyRagRouteDefault).
// It only fills in `provider.lane` before the existing lane resolution runs (ohttp/lane.ts requestLane); lane rules,
// refusals, receipts and labels (router/disclosure.ts, router/select.ts, privacy/label.ts) are untouched.

export const ROUTE_DEFAULTS = ["standard", "proven_first", "proven_only"] as const;
export type RouteDefault = (typeof ROUTE_DEFAULTS)[number];
export const ROUTE_DEFAULT_HEADER = "x-anyroute-default-route";

const RANK: Record<RouteDefault, number> = { standard: 0, proven_first: 1, proven_only: 2 };
// Parameters a serving endpoint must support, as the chat path checks after selection (api/chat.ts MUST_SUPPORT).
const MUST_SUPPORT = ["tools", "response_format"];

const set = (v: unknown) => v !== undefined && v !== null && v !== "";

/** Whether the request already says which lane it wants, by any of the existing options. */
export function namesLane(body: Record<string, unknown>, header: (name: string) => string | undefined | null): boolean {
  const p = (body.provider && typeof body.provider === "object" ? body.provider : {}) as Record<string, unknown>;
  if (set(p.lane) || set(p.disclosure) || set(p.lane_downgrade) || p.private === true) return true;
  if (["x-anyroute-lane", "x-anyroute-disclosure-max", "x-anyroute-lane-downgrade"].some((h) => set(header(h)))) return true;
  const models = [body.model, ...(Array.isArray(body.models) ? body.models : [])];
  return models.some((m) => typeof m === "string" && m.includes(":private"));
}

/** The strictest default among the rulebooks that cover a key, and the lanes all of them allow (null: no allowlist). */
export function combineRouteDefaults(specs: Pick<AgentPolicy, "route_default" | "lanes">[]): { route: RouteDefault; lanes: Lane[] | null } {
  let route: RouteDefault = "standard";
  let lanes: Lane[] | null = null;
  for (const s of specs) {
    const r = s.route_default ?? "standard";
    if (RANK[r] > RANK[route]) route = r;
    if (s.lanes) lanes = (lanes ?? s.lanes).filter((l) => s.lanes!.includes(l));
  }
  return { route, lanes };
}

/** The lane a default puts a request on, given the rulebook's allowlist and whether proven hardware can take it now. */
export function routeDefaultLane(route: RouteDefault, lanes: Lane[] | null, provenAvailable: () => boolean): Lane | null {
  if (route === "standard") return null;
  if (route === "proven_only") return "attested";
  return (lanes === null || lanes.includes("attested")) && provenAvailable() ? "attested" : "public";
}

/**
 * Whether the request's model (the first one it names that resolves, and that the key may use) has an endpoint the
 * attested lane would take for this request right now: the same selection the router runs, with lane "attested",
 * read only and with a fixed draw so it consumes no randomness. `need` is what the route checks: the parameters a
 * provider must support (chat) and the estimated prompt tokens (chat by default; embeddings and rerank pass their own).
 */
export function provenAvailable(ctx: Ctx, body: Record<string, unknown>, need: Need, allowedModels: string[] | null | undefined): boolean {
  const params = need.params ?? [];
  const allowed = new Set(allowedModels ?? []);
  const ids = [body.model, ...(Array.isArray(body.models) ? body.models : [])].filter((m): m is string => typeof m === "string");
  const r = ids.map((id) => ctx.catalog.resolve(id)).find((x) => x && (!allowed.size || allowed.has(x.model.id)));
  if (!r) return false;
  const { lane: _lane, disclosure: _disclosure, lane_downgrade: _downgrade, ...base } = (body.provider ?? {}) as ProviderPrefs & { lane_downgrade?: unknown };
  const sel = selectProviders({
    modelId: r.model.id,
    offers: ctx.catalog.offers(r.model.id),
    prefs: { ...base, lane: "attested", disclosure: "none" },
    modifiers: r.modifiers,
    requestParams: params,
    estimatedTokens: need.tokens ?? estimatePromptTokens(body),
    health: ctx.health,
    production: ctx.cfg.production,
    attestationMaxAgeMs: ctx.cfg.attestation.intervalMs * 3,
    disclosure: (id) => profileOf(ctx.catalog.disclosure.get(id)),
    modelLane: ctx.catalog.laneOf(r.model),
    attestedBonus: ctx.cfg.routing.attestedBonus,
    rand: () => 0.5,
  });
  const must = MUST_SUPPORT.filter((q) => params.includes(q));
  return sel.ordered.some((cand) => !must.length || !cand.supportedParameters?.length || must.every((q) => cand.supportedParameters!.includes(q)));
}

type Need = { params?: string[]; tokens?: number };
type KeyLike = { keyHash: string; allowedModels?: string[] | null; routing?: unknown };

const routeDefaultOf = async (ctx: Ctx, key: KeyLike) => combineRouteDefaults((await policiesFor(ctx.db, key.keyHash)).map((row) => row.spec));

/**
 * The pre-routing step, one call just before the lane is resolved in api/chat.ts, api/embeddings.ts and api/rerank.ts:
 * when the key's rulebook sets a default route and the request names no lane, set `provider.lane` to the lane the
 * default chooses. Returns what was applied, or null when nothing was. The response says so in X-Anyroute-Default-Route
 * (`<setting>; lane=<lane>`); the receipt and the privacy label record the lane the request was actually served on, as
 * for any request.
 */
export async function applyRouteDefault(ctx: Ctx, c: Context, body: Record<string, unknown>, key: KeyLike | null, need: Need = {}): Promise<{ route: RouteDefault; lane: Lane } | null> {
  if (!key || !ctx.cfg.agentPolicyEnabled || namesLane(body, (h) => c.req.header(h))) return null;
  const { route, lanes } = await routeDefaultOf(ctx, key);
  if (route === "standard") return null;
  if (route === "proven_first") await ctx.catalog.ensureFresh();
  const lane = routeDefaultLane(route, lanes, () => provenAvailable(ctx, body, need, key.allowedModels));
  if (!lane) return null;
  if (lane === "attested") body.provider = { ...((body.provider as object) ?? {}), lane };
  c.header(ROUTE_DEFAULT_HEADER, `${route}; lane=${lane}`);
  return { route, lane };
}

/**
 * The same step for POST /api/v1/rag, one call before it reads the lane (api/rag.ts). Proven hardware only makes the
 * request exactly one that states lane "attested": an attested embedding model is picked, every call it makes is held to
 * attested endpoints, and it is refused before anything is sent when no embedding model qualifies, so no chunk reaches a
 * standard provider. Proven hardware first adds nothing at this level: the endpoint already uses lane "attested" when its
 * chat and embedding models both have attested endpoints, and otherwise its calls name no lane, so each embeddings and
 * chat call applies the default to its own model (applyRouteDefault) and is receipted with the lane it was served on.
 * The key's routing defaults (keys.routing.provider), which the endpoint reads itself, count as naming a lane.
 */
export async function applyRagRouteDefault(ctx: Ctx, c: Context, req: { model: string; embedding_model?: string; provider?: { lane?: string; disclosure?: string } }, key: KeyLike): Promise<{ route: RouteDefault; lane: Lane } | null> {
  const pinned = ((key.routing as { provider?: Record<string, unknown> } | null)?.provider ?? {}) as Record<string, unknown>;
  const view = { model: req.model, models: req.embedding_model ? [req.embedding_model] : [], provider: { ...pinned, ...(req.provider ?? {}) } };
  if (!ctx.cfg.agentPolicyEnabled || namesLane(view, (h) => c.req.header(h))) return null;
  if ((await routeDefaultOf(ctx, key)).route !== "proven_only") return null;
  req.provider = { ...(req.provider ?? {}), lane: "attested" };
  c.header(ROUTE_DEFAULT_HEADER, "proven_only; lane=attested");
  return { route: "proven_only", lane: "attested" };
}
