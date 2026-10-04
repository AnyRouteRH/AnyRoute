// Route cards: what a model offers before you pick it, built only from what the public API already returns.
// GET /api/v1/models gives price, context, tags, lanes and the names of the providers serving the model;
// GET /api/v1/providers gives each provider's own uptime, latency and the router's attestation status.
// Pure (no React, no fetch). Nothing missing is filled in: it reads "No data yet".

import { MODEL_CAPABILITIES, modelCapabilities } from "./model-capabilities.js";
import { PROOF_STATES, proofBadges, proofHref } from "./proof-badge.js";
import { attestationOf } from "./providers.js";
import { verifyHref } from "./verify.js";

export const NO_DATA = "No data yet";
export const LOADING = "Loading…";
/** The privacy routes a card can list, in this order, with the site's badge terms. */
export const ROUTE_KEYS = ["standard", "hardware", "unlinkable", "encrypted"];
// These two tags are shown as routes, so they are not repeated among the tags.
const ROUTE_TAGS = new Set(["attested", "encrypted"]);

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const byName = (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);

/** A per-token price string from the API as USD per 1M tokens; null when absent or not a price. */
export function perMillion(value) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toPrecision(12)) : null;
}

export function formatPerMillion(n) {
  if (n == null) return NO_DATA;
  if (n === 0) return "Free";
  if (n >= 100) return "$" + Math.round(n).toLocaleString("en-US");
  if (n >= 0.01) return "$" + n.toFixed(2);
  return n < 0.0001 ? "Under $0.0001" : "$" + Number(n.toPrecision(2));
}

export const formatUptime = (n) => `${Number(n.toFixed(2))}%`;
export function formatLatency(ms) {
  const n = Math.round(ms);
  return n < 1000 ? `${n} ms` : n < 10_000 ? `${(Math.round(n / 100) / 10).toFixed(1)} s` : `${Math.round(n / 1000)} s`;
}

/**
 * The listed providers serving a model, matched by the names the model lists. Provider names are not unique, so a
 * name shared by two listed providers is left out rather than guessed.
 */
export function servingProviders(model, providers) {
  const names = new Set([model?.provider_name, ...(Array.isArray(model?.provider_names) ? model.provider_names : [])].filter((n) => typeof n === "string" && n));
  const rows = (Array.isArray(providers) ? providers : []).filter((p) => p && typeof p.slug === "string" && p.slug && typeof p.name === "string" && names.has(p.name));
  return rows.filter((p) => rows.filter((q) => q.name === p.name).length === 1).sort(byName);
}

// The provider with the best reading, first by name on a tie; null when none reports one.
function best(rows, read, better) {
  let out = null;
  for (const p of rows) {
    const value = read(p);
    if (value != null && (!out || better(value, out.value))) out = { value, provider: p.name };
  }
  return out;
}
const uptimeOf = (p) => { const v = finite(p.uptime_30d); return v != null && v >= 0 && v <= 100 ? v : null; };
const latencyOf = (p) => { const v = finite(p.latency_p50_ms); return v != null && v >= 0 ? v : null; };

/**
 * The card for one model record of GET /api/v1/models. `providers` is the `data` list of GET /api/v1/providers:
 * null while it loads, [] when it could not be loaded. Returns null for anything that is not a model record.
 */
export function routeCard(model, providers, now = Date.now()) {
  if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id) return null;
  const caps = modelCapabilities(model);
  const lanes = Array.isArray(model.lanes) ? model.lanes : null;
  // Proven hardware uses the same rule as the model's badge: a fresh attestation the router checked, never a lane alone.
  const hardware = proofBadges({ source: "model", data: model }, now).some((mark) => mark.hardware);
  const available = {
    standard: lanes ? lanes.includes("public") : true, // routers before lanes served the standard route only
    hardware,
    unlinkable: !!lanes?.includes("unlinkable"),
    encrypted: caps.includes("encrypted"),
  };
  const pending = providers == null;
  const serving = servingProviders(model, providers);
  const uptime = best(serving, uptimeOf, (a, b) => a > b);
  const latency = best(serving, latencyOf, (a, b) => a < b);
  const proven = hardware ? serving.filter((p) => attestationOf(p).status === "attested").map((p) => ({ id: p.slug, name: p.name, href: verifyHref(p.slug) })) : [];
  const context = Number(model.context_length ?? model.top_provider?.context_length);
  const input = perMillion(model.pricing?.prompt), output = perMillion(model.pricing?.completion);
  return {
    id: model.id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
    price: { input: formatPerMillion(input), output: formatPerMillion(output), inputPerM: input, outputPerM: output },
    context: Number.isSafeInteger(context) && context > 0 ? `${context.toLocaleString("en-US")} tokens` : NO_DATA,
    tags: MODEL_CAPABILITIES.filter((tag) => caps.includes(tag.key) && !ROUTE_TAGS.has(tag.key)).map(({ key, label, explanation }) => ({ key, label, explanation })),
    routes: ROUTE_KEYS.filter((key) => available[key]).map((key) => ({ key, label: PROOF_STATES[key].label, explanation: PROOF_STATES[key].explanation, tone: PROOF_STATES[key].tone })),
    health: {
      uptime: pending ? LOADING : uptime ? `${formatUptime(uptime.value)} · ${uptime.provider}` : NO_DATA,
      latency: pending ? LOADING : latency ? `${formatLatency(latency.value)} · ${latency.provider}` : NO_DATA,
      uptimePercent: uptime?.value ?? null,
      latencyMs: latency?.value ?? null,
      providers: serving.length,
    },
    // Only for a model with proven hardware: links to each attested serving provider's record, else the general guide.
    proof: hardware ? { providers: proven, href: proven.length ? "" : proofHref("hardware") } : null,
  };
}
