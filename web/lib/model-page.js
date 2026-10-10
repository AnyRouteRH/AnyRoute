// E151: public model details; no account key or browser storage is read.
import { formatLatency, formatPerMillion, formatUptime, NO_DATA, perMillion, servingProviders } from "./route-card.js";

export const modelPageHref = id => "/models/model/?id=" + encodeURIComponent(id);
export const modelChatHref = id => "/harness/?model=" + encodeURIComponent(id);
export function modelEndpointsPath(id) {
  const parts = String(id).split("/");
  return parts.length === 2 && parts.every(Boolean) ? "/api/v1/models/" + parts.map(encodeURIComponent).join("/") + "/endpoints" : null;
}
export const findModel = (models, id) => (Array.isArray(models) ? models : []).find(model => model?.id === id) || null;
export function modelMetadata(model) {
  return {
    title: model ? `${model.name || model.id} — Anyroute` : "Model not found — Anyroute",
    description: model ? (typeof model.description === "string" && model.description.trim() ? model.description.trim() : `See ${model.name || model.id} abilities, prices, providers and health on Anyroute.`) : "Find a model in the Anyroute catalogue.",
  };
}
export function setModelMetadata(document, model) {
  const metadata = modelMetadata(model);
  document.title = metadata.title;
  let tag = document.querySelector('meta[name="description"]');
  if (!tag) { tag = document.createElement("meta"); tag.setAttribute("name", "description"); document.head.appendChild(tag); }
  tag.setAttribute("content", metadata.description);
}
export function firstListed(model) {
  const value = model?.added_at;
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
export function modelPrices(model) {
  const image = model?.pricing?.image;
  const imagePrice = (typeof image === "number" || typeof image === "string") && String(image).trim() !== "" ? Number(image) : NaN;
  return {
    input: formatPerMillion(perMillion(model?.pricing?.prompt)),
    output: formatPerMillion(perMillion(model?.pricing?.completion)),
    // The router meters priceImage per image, not per million image tokens.
    image: Number.isFinite(imagePrice) && imagePrice > 0 ? "$" + Number(imagePrice.toPrecision(8)).toLocaleString("en-US", { maximumSignificantDigits: 8 }) : null,
  };
}
const reading = (value, maximum = Infinity) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
export function modelProviderRows(model, providers, endpoints) {
  return servingProviders(model, providers).map(provider => {
    const endpoint = Array.isArray(endpoints) ? endpoints.find(row => row.provider_slug === provider.slug) : null;
    const uptime = reading(endpoint ? endpoint.uptime_last_30d : provider.uptime_30d, 100);
    const latency = reading(endpoint ? endpoint.latency_last_30m?.p50 : provider.latency_p50_ms);
    const speed = reading(endpoint?.throughput_last_30m?.p50);
    return { provider, modelSpecific: !!endpoint, uptime: uptime == null ? NO_DATA : formatUptime(uptime), latency: latency == null ? NO_DATA : formatLatency(latency), speed: speed == null ? NO_DATA : `${Number(speed.toFixed(2))} tokens / second` };
  });
}
// Single-quote shell escaping also handles catalogue IDs containing quotes or shell syntax.
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function modelCurl(id) {
  return `curl https://anyroute.tech/api/v1/chat/completions \\\n  -H "Authorization: Bearer $ANYROUTE_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d ${shellQuote(JSON.stringify({ model: id, messages: [{ role: "user", content: "Hello" }] }))}`;
}
export async function loadModelPage(id, request, signal) {
  const response = await request("/api/v1/models", { signal });
  if (!Array.isArray(response?.data)) throw new Error("The model catalogue could not be loaded.");
  return findModel(response.data, id);
}
