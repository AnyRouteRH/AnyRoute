import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LOADING, NO_DATA, ROUTE_KEYS, formatLatency, formatPerMillion, perMillion, routeCard, servingProviders } from "../lib/route-card.js";
import { PROOF_STATES } from "../lib/proof-badge.js";
import { PROVIDERS_PATH } from "../lib/providers.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const attested = { status: "attested", tee: "tdx", verifiers: ["dcap"], last_verified_at: ago(5), last_attempt_at: ago(5), last_attempt_ok: true };
const unverified = { status: "unverified", reason: "no_attestation", tee: null, verifiers: [], last_verified_at: null, last_attempt_at: null, last_attempt_ok: null };
// Shapes as GET /api/v1/providers and GET /api/v1/models return them.
const PROVIDERS = [
  { name: "Sample relay", slug: "relay", status: "live", uptime_30d: 99.99, health_events_30d: 7000, latency_p50_ms: 820, attestation: unverified },
  { name: "Sample enclave", slug: "enclave", status: "live", uptime_30d: 100, health_events_30d: 300, latency_p50_ms: 1450, attestation: attested },
  { name: "Sample network host", slug: "nh_sample", status: "probation", uptime_30d: null, health_events_30d: 0, latency_p50_ms: null, attestation: attested },
  { name: "Unrelated", slug: "unrelated", status: "live", uptime_30d: 100, latency_p50_ms: 10, attestation: attested },
];
const MODEL = {
  id: "sample/attested-model", name: "Attested model", context_length: 1048576,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000014", completion: "0.0000044", request: "0", image: "0" },
  supported_parameters: ["tools", "max_tokens"], attested_available: true, disclosure: { best: "attested", endpoints: { attested: 1, policy: 0, "vendor-forwarded": 1 } },
  lanes: ["public", "attested", "unlinkable"], provider_names: ["Sample enclave", "Sample relay"],
  capabilities: ["vision", "tools", "longContext", "attested", "encrypted"],
};
const PUBLIC = { id: "sample/public-model", name: "Public model", context_length: 32768, pricing: { prompt: "0.0000002", completion: "0" }, lanes: ["public"], provider_names: ["Sample relay"], capabilities: ["tools"], attested_available: false };

test("a full card: price, context, tags, every route in order, best health and proof links", () => {
  const card = routeCard(MODEL, PROVIDERS, NOW);
  assert.equal(card.id, MODEL.id);
  assert.equal(card.name, "Attested model");
  assert.deepEqual([card.price.input, card.price.output], ["$1.40", "$4.40"]);
  assert.equal(card.context, "1,048,576 tokens");
  // Tags reuse the shared vocabulary; the two privacy tags are shown as routes instead of twice.
  assert.deepEqual(card.tags.map((t) => [t.key, t.label]), [["vision", "Reads images"], ["tools", "Tools"], ["longContext", "Long context"]]);
  assert.deepEqual(card.routes.map((r) => r.label), ["Standard provider", "Proven hardware", "Unlinkable route", "Encrypted end to end"]);
  for (const route of card.routes) assert.equal(route.explanation, PROOF_STATES[route.key].explanation);
  assert.deepEqual(ROUTE_KEYS, ["standard", "hardware", "unlinkable", "encrypted"]);
  // Best uptime is the highest, best latency the lowest, each from a provider that serves this model.
  assert.equal(card.health.uptime, "100% · Sample enclave");
  assert.equal(card.health.latency, "820 ms · Sample relay");
  assert.equal(card.health.providers, 2);
  assert.deepEqual(card.proof, { providers: [{ id: "enclave", name: "Sample enclave", href: "/verify/?p=enclave" }], href: "" });
});

test("missing data reads No data yet and is never filled in", () => {
  const card = routeCard({ id: "sample/bare" }, [], NOW);
  assert.deepEqual([card.price.input, card.price.output, card.context, card.health.uptime, card.health.latency], [NO_DATA, NO_DATA, NO_DATA, NO_DATA, NO_DATA]);
  assert.deepEqual([card.price.inputPerM, card.health.uptimePercent, card.health.latencyMs], [null, null, null]);
  assert.equal(card.proof, null);
  assert.deepEqual(card.tags, []);
  // Providers that serve the model but report no figures yet.
  const quiet = routeCard({ ...PUBLIC, provider_names: ["Sample network host"] }, PROVIDERS, NOW);
  assert.deepEqual([quiet.health.uptime, quiet.health.latency], [NO_DATA, NO_DATA]);
  // Out-of-range and non-numeric readings are ignored, not clamped.
  const odd = [{ name: "Sample relay", slug: "relay", uptime_30d: 140, latency_p50_ms: "90" }];
  assert.deepEqual([routeCard(PUBLIC, odd, NOW).health.uptime, routeCard(PUBLIC, odd, NOW).health.latency], [NO_DATA, NO_DATA]);
  // While the provider list loads, health says so rather than claiming there is none.
  const loading = routeCard(PUBLIC, null, NOW);
  assert.deepEqual([loading.health.uptime, loading.health.latency], [LOADING, LOADING]);
  assert.equal(loading.price.input, "$0.20");
  for (const bad of [null, undefined, "", " ", "-1", "abc", true, [], {}]) assert.equal(perMillion(bad), null, String(bad));
  assert.equal(routeCard(null, PROVIDERS), null);
  assert.equal(routeCard({ name: "no id" }, PROVIDERS), null);
});

test("prices and readings are formatted per 1M tokens without rounding to zero", () => {
  assert.equal(routeCard(PUBLIC, PROVIDERS, NOW).price.output, "Free");
  assert.deepEqual([0, 0.0035, 0.00009, 0.25, 1.4, 250.4, 1234].map(formatPerMillion), ["Free", "$0.0035", "Under $0.0001", "$0.25", "$1.40", "$250", "$1,234"]);
  assert.equal(perMillion("0.000000062773"), 0.062773);
  assert.deepEqual([12.4, 999.6, 1450, 12_345].map(formatLatency), ["12 ms", "1.0 s", "1.5 s", "12 s"]);
});

test("routes come only from the router's own fields, never from a lane, name or price alone", () => {
  const routes = (model) => routeCard(model, PROVIDERS, NOW).routes.map((r) => r.key);
  assert.deepEqual(routes(PUBLIC), ["standard"]);
  // A router that predates lanes served the standard route only.
  assert.deepEqual(routes({ id: "sample/old", pricing: { prompt: "0.000001" } }), ["standard"]);
  // An attested lane without the router's fresh-attestation tag is not proven hardware, and has no proof row.
  const laneOnly = { ...PUBLIC, lanes: ["public", "attested"], capabilities: ["tools"], attested_available: false };
  assert.deepEqual(routes(laneOnly), ["standard"]);
  assert.equal(routeCard(laneOnly, PROVIDERS, NOW).proof, null);
  assert.deepEqual(routes({ ...MODEL, attested_available: false }), ["standard", "unlinkable", "encrypted"]);
  // Encryption is read only from the encrypted tag; unlinkable only from the model's lanes.
  assert.deepEqual(routes({ ...MODEL, capabilities: ["attested"] }), ["standard", "hardware", "unlinkable"]);
  assert.deepEqual(routes({ ...MODEL, lanes: ["public", "attested"] }), ["standard", "hardware", "encrypted"]);
  assert.deepEqual(routes({ ...PUBLIC, id: "sample/encrypted-name", name: "Encrypted unlinkable attested" }), ["standard"]);
  // A model with no servable lane lists no route.
  assert.deepEqual(routes({ ...PUBLIC, lanes: [] }), []);
  // Stale or failed attestation records on the model fall back, as the shared badge does.
  assert.deepEqual(routes({ ...MODEL, attestation: { stale: true } }), ["standard", "unlinkable", "encrypted"]);
});

test("serving providers are matched by the names the model lists; ambiguous names are left out", () => {
  assert.deepEqual(servingProviders(MODEL, PROVIDERS).map((p) => p.slug), ["enclave", "relay"]);
  assert.deepEqual(servingProviders({ provider_names: ["Missing"] }, PROVIDERS), []);
  assert.deepEqual(servingProviders(MODEL, null), []);
  const twin = [...PROVIDERS, { name: "Sample enclave", slug: "enclave-2", status: "live", uptime_30d: 50, attestation: attested }];
  const card = routeCard(MODEL, twin, NOW);
  assert.deepEqual(servingProviders(MODEL, twin).map((p) => p.slug), ["relay"]);
  assert.equal(card.health.uptime, "99.99% · Sample relay");
  // Proven hardware without a matched attested provider points to the general guide instead of a provider.
  assert.deepEqual(card.proof, { providers: [], href: "/verify/#proof-hardware" });
  // Network hosts in probation still count when the model lists them; unverified providers get no proof link.
  const host = routeCard({ ...MODEL, provider_names: ["Sample network host", "Sample relay"] }, PROVIDERS, NOW);
  assert.deepEqual(host.proof.providers.map((p) => p.href), ["/verify/?p=nh_sample"]);
});

test("the Harness picker and the models page render the card from the public endpoints only", () => {
  const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const component = read("components/RouteCard.jsx"), harness = read("components/Harness.jsx"), catalog = read("components/ModelCatalog.jsx");
  assert.equal(PROVIDERS_PATH, "/api/v1/providers");
  assert.match(component, /api\(PROVIDERS_PATH\)/);
  assert.doesNotMatch(component + read("lib/route-card.js"), /fetch\(|localStorage|sessionStorage/);
  assert.match(component, /aria-label=\{`Route card for \$\{card\.name\}`\}/);
  assert.match(component, /<summary>Route card<\/summary>/);
  // Rail: the selected model; palette: the highlighted option, described for screen readers.
  assert.match(harness, /m\.id === activeId && g\.maker === cardGroup && <li><RouteCard model=\{activeRaw\}/);
  assert.match(harness, /aria-describedby=\{i === active && activeRaw \? "palette-route-card" : undefined\}/);
  assert.match(harness, /<RouteCard id="palette-route-card"/);
  assert.match(harness, /<\/button>\s*<CapTags/);
  assert.match(catalog, /<RouteCardDetails model=\{raw\} providers=\{providers\} \/>/);
  // Public copy stays within the site's wording rules.
  const copy = [...(component + read("lib/route-card.js")).matchAll(/"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)].map((m) => m[1] ?? m[2] ?? m[3]).join(" ");
  assert.doesNotMatch(copy, /\b(?:demo|test|tested|mock|simulated|placeholder|fixture|local|anonymous|trustless|decentralized|earn|yield|APY|returns|private)\b|no logs|can't read/i);
});
