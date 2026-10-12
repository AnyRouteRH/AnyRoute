// G165: public catalogue comparisons; all amounts keep the model-page units.
import { findModel, modelEndpointsPath } from "./model-page.js";
import { perMillion } from "./route-card.js";

export const COMPARE_LIMIT = 3;
export const COMPARE_STORE = "anyroute-model-compare-v1";
export function normalizeCompareIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === "string").map(id => id.trim()).filter(Boolean))].slice(0, COMPARE_LIMIT);
}
export const parseCompareIds = search => normalizeCompareIds((new URLSearchParams(search).get("ids") || "").split(","));
export const compareHref = ids => "/models/compare/?ids=" + normalizeCompareIds(ids).map(encodeURIComponent).join(",");
export function toggleCompareId(ids, id) {
  const current = normalizeCompareIds(ids);
  if (current.includes(id)) return current.filter(value => value !== id);
  return normalizeCompareIds([...current, id]);
}
export function readComparePicks(storage) {
  try { return normalizeCompareIds(JSON.parse(storage.getItem(COMPARE_STORE) || "[]")); } catch { return []; }
}
export function writeComparePicks(storage, ids) {
  try { storage.setItem(COMPARE_STORE, JSON.stringify(normalizeCompareIds(ids))); } catch { /* Page memory still works. */ }
}
export const comparisonModels = (models, ids) => normalizeCompareIds(ids).map(id => ({ id, model: findModel(models, id) }));
export function compareContext(model) {
  const value = model?.context_length ?? model?.top_provider?.context_length;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
// Wording compares each column with the first found model, never with a missing reading.
export function comparisonDifferences(model, reference) {
  if (!model || !reference || model.id === reference.id) return [];
  const differences = [], context = compareContext(model), baseline = compareContext(reference);
  if (context !== null && baseline !== null && context !== baseline) {
    const ratio = context / baseline;
    differences.push(ratio > 1 && Number.isInteger(ratio) ? `${ratio}x the context` : context > baseline ? "More context" : "Less context");
  }
  for (const [field, label] of [["prompt", "input"], ["completion", "output"]]) {
    const price = perMillion(model.pricing?.[field]), base = perMillion(reference.pricing?.[field]);
    if (price !== null && base !== null && price !== base) differences.push(price < base ? `Cheaper ${label}` : `Pricier ${label}`);
  }
  return differences;
}
export async function loadModelComparison(ids, request, signal) {
  const response = await request("/api/v1/models", { signal });
  if (!Array.isArray(response?.data)) throw new Error("The model catalogue could not be loaded.");
  const columns = comparisonModels(response.data, ids);
  const found = columns.filter(column => column.model);
  if (!found.length) return { columns, providers: [], endpoints: {}, healthError: false };
  const paths = found.map(({ id }) => modelEndpointsPath(id));
  const results = await Promise.allSettled([
    request("/api/v1/providers", { signal }),
    ...paths.map(path => path ? request(path, { signal }) : Promise.resolve(null)),
  ]);
  const providers = results[0].status === "fulfilled" ? results[0].value?.data : null;
  const endpoints = {};
  let healthError = !Array.isArray(providers);
  found.forEach(({ id }, index) => {
    const result = results[index + 1];
    const rows = result.status === "fulfilled" ? result.value?.data?.endpoints : null;
    endpoints[id] = Array.isArray(rows) ? rows : null;
    if (paths[index] && !Array.isArray(rows)) healthError = true;
  });
  return { columns, providers: Array.isArray(providers) ? providers : [], endpoints, healthError };
}
