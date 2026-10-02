import { MODEL_CAPABILITIES, modelCapabilities } from "./model-capabilities.js";

export const CATALOG_SORTS = [
  { key: "name", label: "Name" }, { key: "priceIn", label: "Price in · lowest first" },
  { key: "priceOut", label: "Price out · lowest first" }, { key: "context", label: "Context · largest first" },
];
const nameOrder = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)) || String(a.id).localeCompare(String(b.id));
const price = (model, direction) => {
  const value = model.pricing?.[direction];
  const n = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
};
const context = model => Number(model.context_length ?? model.top_provider?.context_length ?? 0) || 0;
export function searchModels(models, query = "") {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return models.filter(model => {
    const text = [model.id, model.name, model.provider_name, ...(model.provider_names || [])].filter(Boolean).join(" ").toLowerCase();
    return words.every(word => text.includes(word));
  });
}
export function filterModels(models, { query = "", tags = [], sort = "name" } = {}) {
  const compare = {
    priceIn: (a, b) => price(a, "prompt") - price(b, "prompt"),
    priceOut: (a, b) => price(a, "completion") - price(b, "completion"),
    context: (a, b) => context(b) - context(a),
  }[sort];
  return searchModels(models, query).filter(model => tags.every(key => modelCapabilities(model).includes(key)))
    .sort((a, b) => (compare?.(a, b) || 0) || nameOrder(a, b));
}
// Counts reflect the current query and all selected tags, as in the Harness picker.
export function modelTagCounts(models, options = {}) {
  const base = filterModels(models, options);
  return Object.fromEntries(MODEL_CAPABILITIES.map(tag => [tag.key, base.filter(model => modelCapabilities(model).includes(tag.key)).length]));
}
