import { parse } from "yaml";
import type { Catalog } from "../catalog/catalog.ts";
import type { ProviderPrefs } from "../router/select.ts";

// LiteLLM-config import: turns a LiteLLM proxy config (model_list / router_settings) into per-key
// routing presets, so `model: "<model_name>"` keeps working after switching base URL to Anyroute.
//   model_list: [{ model_name, litellm_params: { model: "openrouter/meta-llama/..." | "<provider>/<model>", ... } }]
//   router_settings: { routing_strategy, num_retries, fallbacks: [{ alias: [other aliases] }] }

export type Presets = { aliases: Record<string, { model: string; models?: string[]; provider?: ProviderPrefs }>; provider?: ProviderPrefs; unresolved: string[]; source: "litellm" };

const STRATEGY: Record<string, ProviderPrefs["sort"] | undefined> = {
  "latency-based-routing": "latency",
  "cost-based-routing": "price",
  "usage-based-routing": undefined,
  "usage-based-routing-v2": undefined,
  "simple-shuffle": undefined,
  "least-busy": "throughput",
};

function resolveModel(catalog: Catalog, raw: string): string | null {
  const s = raw.replace(/^openrouter\//, "").replace(/^anyroute\//, "").toLowerCase();
  if (catalog.resolve(s)) return catalog.resolve(s)!.model.id;
  // "<litellm-provider>/<model>" -> find a catalog model whose slug ends with the model part.
  const tail = s.split("/").slice(1).join("/") || s;
  const hit = [...catalog.models.keys()].find((id) => id === tail || id.endsWith("/" + tail) || id.split("/")[1] === tail);
  return hit ?? null;
}

export function importLiteLLM(yamlText: string, catalog: Catalog): Presets {
  const doc = parse(yamlText) as { model_list?: any[]; router_settings?: any; litellm_settings?: any } | null;
  if (!doc || !Array.isArray(doc.model_list)) throw new Error("LiteLLM config must contain a model_list array.");
  const aliases: Presets["aliases"] = {};
  const unresolved: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const entry of doc.model_list) {
    const name = String(entry?.model_name ?? "");
    const target = String(entry?.litellm_params?.model ?? "");
    if (!name || !target) continue;
    const id = resolveModel(catalog, target);
    if (!id) {
      unresolved.push(`${name} -> ${target}`);
      continue;
    }
    // Several deployments under one model_name = load balancing across them: keep all as fallbacks.
    grouped.set(name, [...(grouped.get(name) ?? []), id]);
  }
  for (const [name, ids] of grouped) {
    const unique = [...new Set(ids)];
    aliases[name] = { model: unique[0], ...(unique.length > 1 ? { models: unique } : {}) };
  }
  const rs = doc.router_settings ?? {};
  for (const f of Array.isArray(rs.fallbacks) ? rs.fallbacks : []) {
    for (const [alias, list] of Object.entries(f ?? {})) {
      if (!aliases[alias] || !Array.isArray(list)) continue;
      const extra = (list as string[]).flatMap((a) => (aliases[a] ? [aliases[a].model] : []));
      aliases[alias].models = [...new Set([aliases[alias].model, ...(aliases[alias].models ?? []), ...extra])];
    }
  }
  const sort = STRATEGY[String(rs.routing_strategy ?? "")];
  const provider: ProviderPrefs | undefined = sort ? { sort } : undefined;
  return { aliases, provider, unresolved, source: "litellm" };
}
