// Saved Routes tab: pure helpers (no React), shared by components/features/SavedRoutes.jsx and its tests.
// A saved route is an account's named routing policy, called as `model: "@route/<slug>"`. It stores
// models, provider preferences and sampling defaults only, never prompt text.

export const ROUTE_PREFIX = "@route/";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const MAX_ROUTES = 100;
export const MAX_MODELS = 8;

export const SORTS = [
  ["", "Balanced: price, uptime and quality"],
  ["price", "Lowest price first"],
  ["latency", "Lowest latency first"],
  ["throughput", "Highest throughput first"],
];
/**
 * Privacy of a route, as one choice. "attested" pins provider.lane (the router serves it only from providers with a
 * fresh, verified attestation and refuses otherwise); "none" and "policy" pin provider.disclosure.
 */
export const PRIVACY = [
  ["", "Standard: any provider"],
  ["policy", "No-retention policy or better"],
  ["none", "Attested retention only"],
  ["attested", "Private (attested lane)"],
];
const PRIVACY_LABEL = { attested: "Private: attested lane", none: "Attested retention only", policy: "No-retention policy or better" };
/** The choices that the model list of GET /api/v1/models?lane=attested can be checked against. */
export const usesAttestedList = (privacy) => privacy === "attested" || privacy === "none";
/** The route's models (as typed) that are missing from `ids`, a Set of catalog ids available on the lane. */
export const modelsOffList = (models, ids) => (models || []).filter((m) => !ids.has(baseModelId(m)));

/** The privacy choice a stored provider section amounts to. */
export function privacyOf(provider) {
  if (provider?.lane === "attested") return "attested";
  return provider?.disclosure === "none" || provider?.disclosure === "policy" ? provider.disclosure : "";
}
const SORT_LABEL = { price: "Cheapest provider first", latency: "Fastest first token", throughput: "Highest throughput" };

/** Default parameters the form edits; any other stored parameter is kept as-is. */
export const PARAM_FIELDS = [
  { key: "temperature", label: "Temperature", short: "temp", min: 0, max: 2, step: 0.1 },
  { key: "top_p", label: "Top p", short: "top_p", min: 0, max: 1, step: 0.05 },
  { key: "max_tokens", label: "Max tokens", short: "max", min: 1, max: 1_000_000, step: 1, int: true },
  { key: "frequency_penalty", label: "Frequency penalty", short: "freq", min: -2, max: 2, step: 0.1 },
  { key: "presence_penalty", label: "Presence penalty", short: "pres", min: -2, max: 2, step: 0.1 },
];
const FORM_PARAMS = new Set([...PARAM_FIELDS.map((f) => f.key), "stop"]);

const SUFFIX = /(:(nitro|floor|free|private))+$/;
/** Catalog id of a route model (`author/model:floor` -> `author/model`). */
export const baseModelId = (id) => String(id).replace(SUFFIX, "");

/** A slug suggestion from a route name. */
export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** Move one list item up (-1) or down (+1); out-of-range moves return the list unchanged. */
export function moveItem(list, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

const escapeStop = (s) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
const unescapeStop = (s) => s.replace(/\\(n|t|\\)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));

/** "END, \n\n" -> ["END", "\n\n"]; commas separate sequences, \n and \t are escapes. */
export function parseStop(text) {
  const parts = String(text ?? "")
    .split(",")
    .map((s) => unescapeStop(s.trim()))
    .filter(Boolean);
  if (!parts.length) return { value: undefined };
  if (parts.length > 4) return { error: "Use at most 4 stop sequences." };
  if (parts.some((s) => s.length > 32)) return { error: "Keep each stop sequence to 32 characters." };
  return { value: parts };
}

export function stopToText(stop) {
  const list = stop == null ? [] : Array.isArray(stop) ? stop : [stop];
  return list.map(escapeStop).join(", ");
}

const emptyParams = () => Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, ""]));

export function emptyDraft() {
  return { slug: "", name: "", description: "", models: [], privacy: "", sort: "", allowFallbacks: true, zdr: false, maxPrompt: "", maxCompletion: "", params: emptyParams(), stop: "", extraProvider: {}, extraParams: {}, extraMaxPrice: {} };
}

/** Form state for an existing route. Fields the form does not edit are carried through unchanged. */
export function routeToDraft(route) {
  const c = route?.config || {};
  const { sort, allow_fallbacks, zdr, max_price, lane, disclosure, ...extraProvider } = c.provider || {};
  const { prompt, completion, ...extraMaxPrice } = max_price || {};
  const params = emptyParams();
  const extraParams = {};
  for (const [k, v] of Object.entries(c.params || {})) {
    if (!FORM_PARAMS.has(k)) extraParams[k] = v;
    else if (k !== "stop") params[k] = String(v);
  }
  // A stored stop sequence that contains a comma cannot round-trip through the text field.
  const stopList = c.params?.stop == null ? [] : [].concat(c.params.stop);
  let stop = "";
  if (stopList.some((s) => s.includes(","))) extraParams.stop = c.params.stop;
  else stop = stopToText(stopList);
  return {
    slug: route?.slug || "",
    name: route?.name || "",
    description: route?.description || "",
    models: [...(c.models || [])],
    privacy: privacyOf({ lane, disclosure }),
    sort: typeof sort === "string" ? sort : "",
    allowFallbacks: allow_fallbacks !== false,
    zdr: zdr === true,
    maxPrompt: prompt == null ? "" : String(prompt),
    maxCompletion: completion == null ? "" : String(completion),
    params,
    stop,
    extraProvider,
    extraParams,
    extraMaxPrice,
  };
}

/**
 * Validate a draft and build the route it describes. `catalogIds` (a Set of catalog model ids) is
 * optional; the router checks the catalog again on save.
 */
export function draftToRoute(draft, { catalogIds } = {}) {
  const errors = {};
  const slug = String(draft.slug ?? "").trim();
  if (!SLUG_RE.test(slug)) errors.slug = "Use 2–48 lowercase letters, digits or hyphens, starting with a letter or digit.";
  const name = String(draft.name ?? "").trim() || slug;
  if (name.length > 80) errors.name = "Keep the name to 80 characters.";
  const description = String(draft.description ?? "").trim();
  if (description.length > 280) errors.description = "Keep the description to 280 characters.";

  const models = [...(draft.models || [])];
  if (!models.length) errors.models = "Add at least one model.";
  else if (models.length > MAX_MODELS) errors.models = `Use at most ${MAX_MODELS} models.`;
  else if (new Set(models).size !== models.length) errors.models = "List each model once.";
  else if (models.some((m) => m.toLowerCase().startsWith(ROUTE_PREFIX))) errors.models = "A route cannot point to another route.";
  else if (catalogIds?.size) {
    const missing = models.filter((m) => !catalogIds.has(baseModelId(m)));
    if (missing.length) errors.models = `Not in the live catalog: ${missing.join(", ")}.`;
  }

  const provider = { ...draft.extraProvider };
  if (draft.sort) provider.sort = draft.sort;
  if (draft.privacy === "attested") provider.lane = "attested";
  else if (draft.privacy === "none" || draft.privacy === "policy") provider.disclosure = draft.privacy;
  if (!draft.allowFallbacks) provider.allow_fallbacks = false;
  if (draft.zdr) provider.zdr = true;
  const maxPrice = { ...draft.extraMaxPrice };
  for (const [field, key] of [["maxPrompt", "prompt"], ["maxCompletion", "completion"]]) {
    const raw = String(draft[field] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) errors[field] = "Enter 0 to 1,000,000 USD per 1M tokens, or leave it empty.";
    else maxPrice[key] = n;
  }
  if (Object.keys(maxPrice).length) provider.max_price = maxPrice;

  const params = { ...draft.extraParams };
  for (const f of PARAM_FIELDS) {
    const raw = String(draft.params?.[f.key] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < f.min || n > f.max || (f.int && !Number.isInteger(n))) errors[f.key] = `${f.int ? "A whole number" : "A number"} from ${f.min.toLocaleString("en-US")} to ${f.max.toLocaleString("en-US")}.`;
    else params[f.key] = n;
  }
  const stop = parseStop(draft.stop);
  if (stop.error) errors.stop = stop.error;
  else if (stop.value) params.stop = stop.value;

  const config = { models };
  if (Object.keys(provider).length) config.provider = provider;
  if (Object.keys(params).length) config.params = params;
  return { ok: !Object.keys(errors).length, errors, slug, name, description, config };
}

/**
 * The message for a save the router refused because the route's privacy setting cannot be met (409
 * route_lane_unavailable), or null for any other error.
 */
export function laneRefusal(err) {
  const off = err?.type === "route_lane_unavailable" && Array.isArray(err.metadata?.unavailable_models) ? err.metadata.unavailable_models : null;
  return off?.length ? `Not available under this setting right now: ${off.join(", ")}. Remove ${off.length === 1 ? "it" : "them"} or choose Standard.` : null;
}

/** POST /api/v1/routes body. */
export const createBody = (r) => ({ slug: r.slug, name: r.name, description: r.description, config: r.config });

/** PATCH /api/v1/routes/:slug body: the whole editable state, clearing sections the form emptied. */
export function patchBody(r, previousSlug) {
  return {
    ...(r.slug !== previousSlug ? { slug: r.slug } : {}),
    name: r.name,
    description: r.description,
    config: { models: r.config.models, provider: r.config.provider ?? null, params: r.config.params ?? null },
  };
}

const usd = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const list = (xs) => [].concat(xs).join(", ");

/** Provider policy as short labels. */
export function policySummary(config) {
  const p = config?.provider || {};
  const out = [];
  out.push(SORT_LABEL[typeof p.sort === "string" ? p.sort : p.sort?.by] || "Balanced provider choice");
  if (PRIVACY_LABEL[privacyOf(p)]) out.push(PRIVACY_LABEL[privacyOf(p)]);
  if (p.allow_fallbacks === false) out.push("No provider fallback");
  if (p.zdr) out.push("Zero data retention");
  if (p.data_collection === "deny") out.push("No data collection");
  if (p.order?.length) out.push("Order: " + p.order.join(" → "));
  if (p.only?.length) out.push("Only: " + list(p.only));
  if (p.ignore?.length) out.push("Skip: " + list(p.ignore));
  if (p.require_parameters) out.push("Providers must support every parameter");
  const mp = p.max_price || {};
  const caps = [mp.prompt != null && `${usd(mp.prompt)} in`, mp.completion != null && `${usd(mp.completion)} out`].filter(Boolean);
  if (caps.length) out.push(`≤ ${caps.join(" · ")} /1M`);
  if (mp.request != null) out.push(`≤ ${usd(mp.request)} /request`);
  return out;
}

/** Default parameters as short labels (empty: requests use their own values). */
export function paramSummary(config) {
  const out = [];
  for (const [k, v] of Object.entries(config?.params || {})) {
    const f = PARAM_FIELDS.find((x) => x.key === k);
    if (f) out.push(`${f.short} ${f.int ? Number(v).toLocaleString("en-US") : v}`);
    else if (k === "stop") out.push(`stop ×${[].concat(v).length}`);
    else if (k === "reasoning") out.push("reasoning " + (v?.effort || "on"));
    else out.push(`${k} ${typeof v === "object" ? "set" : v}`);
  }
  return out;
}

/** A copyable OpenAI SDK call for a route. */
export function snippet(slug, base, lang = "js") {
  const url = (base || "https://your-router.example").replace(/\/$/, "") + "/api/v1";
  const model = ROUTE_PREFIX + (slug || "your-route");
  if (lang === "python")
    return `import os
from openai import OpenAI

client = OpenAI(base_url="${url}", api_key=os.environ["ANYROUTE_API_KEY"])

completion = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(completion.model)  # the model that served this call`;
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${url}",
  apiKey: process.env.ANYROUTE_API_KEY,
});

const completion = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(completion.model, completion.route); // served model, route slug`;
}

/** Fixed examples for the sample workspace. They are never sent to, or returned by, a router. */
export const sampleRoutes = [
  {
    slug: "cheap-chat",
    name: "Cheap chat",
    description: "Sample route: the cheapest provider first, with Llama as the fallback model.",
    config: { models: ["mistralai/mistral-small", "meta-llama/llama-3.3-70b-instruct"], provider: { sort: "price", max_price: { prompt: 1, completion: 2 } }, params: { temperature: 0.3, max_tokens: 512 } },
    sample: true,
  },
  {
    slug: "zdr-reasoning",
    name: "Zero-retention reasoning",
    description: "Sample route: zero-data-retention providers only, no provider fallback.",
    config: { models: ["qwen/qwen3-32b", "deepseek/deepseek-r1"], provider: { zdr: true, allow_fallbacks: false, data_collection: "deny" }, params: { temperature: 0.6 } },
    sample: true,
  },
  {
    slug: "private-chat",
    name: "Private chat",
    description: "Sample route: the attested lane only. A request cannot loosen it, and the router refuses rather than use a provider that is not attested.",
    config: { models: ["meta-llama/llama-3.3-70b-instruct"], provider: { lane: "attested" }, params: { temperature: 0.3 } },
    sample: true,
  },
];
