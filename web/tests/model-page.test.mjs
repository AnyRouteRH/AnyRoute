import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { firstListed, findModel, loadModelPage, modelChatHref, modelCurl, modelEndpointsPath, modelMetadata, modelPageHref, modelPrices, modelProviderRows, setModelMetadata } from "../lib/model-page.js";
const model = { id: "sample/model", name: "Sample model", description: "Reads words and pictures.", added_at: 1791586800, created: 1700000000, context_length: 128000, capabilities: ["tools", "vision"], pricing: { prompt: "0.0000014", completion: "0.0000044", image: "0.0035" }, provider_names: ["Sample provider"] };
const providers = [{ slug: "sample-provider", name: "Sample provider", uptime_30d: 99, latency_p50_ms: 820, attestation: { status: "unverified" } }];
const endpoints = [{ provider_slug: "sample-provider", uptime_last_30d: 98.5, latency_last_30m: { p50: 1450 }, throughput_last_30m: { p50: 32.25 } }];

test("exact model lookup uses the public catalogue without a key and distinguishes failures", async () => {
  assert.equal(findModel([model], model.id), model);
  assert.equal(findModel([model], "unknown"), null);
  assert.equal(findModel([model], "sample/model:nitro"), null);
  const calls = [], controller = new AbortController();
  assert.equal(await loadModelPage(model.id, async (...args) => { calls.push(args); return { data: [model] }; }, controller.signal), model);
  assert.deepEqual(calls, [["/api/v1/models", { signal: controller.signal }]]);
  assert.equal(await loadModelPage("unknown", async () => ({ data: [model] })), null);
  await assert.rejects(loadModelPage(model.id, async () => ({})), /could not be loaded/);
  await assert.rejects(loadModelPage(model.id, async () => { throw Error("offline"); }), /offline/);
});
test("prices retain their units and first-listed never substitutes the release date", () => {
  assert.deepEqual(modelPrices(model), { input: "$1.40", output: "$4.40", image: "$0.0035" });
  assert.equal(firstListed(model), "2026-10-09");
  for (const added_at of [null, undefined, 0, -1, "1791586800", Infinity]) assert.equal(firstListed({ ...model, added_at }), null);
  assert.deepEqual(modelPrices({}), { input: "No data yet", output: "No data yet", image: null });
  assert.equal(modelPrices({ pricing: { prompt: "0", completion: "0", image: "0" } }).input, "Free");
});
test("health uses model-specific medians, names provider-wide fallback and preserves unknowns", () => {
  assert.deepEqual(modelProviderRows(model, providers, endpoints)[0], { provider: providers[0], modelSpecific: true, uptime: "98.5%", latency: "1.5 s", speed: "32.25 tokens / second" });
  assert.deepEqual(modelProviderRows(model, providers, null)[0], { provider: providers[0], modelSpecific: false, uptime: "99%", latency: "820 ms", speed: "No data yet" });
  const odd = [{ ...endpoints[0], uptime_last_30d: 101, latency_last_30m: { p50: -1 }, throughput_last_30m: { p50: "30" } }];
  assert.deepEqual(Object.values(modelProviderRows(model, providers, odd)[0]).slice(2), ["No data yet", "No data yet", "No data yet"]);
  assert.deepEqual(modelProviderRows(model, [...providers, { ...providers[0], slug: "twin" }], endpoints), []);
});
test("metadata is model-specific and updates the document description safely", () => {
  assert.deepEqual(modelMetadata(model), { title: "Sample model — Anyroute", description: model.description });
  const attrs = {}; const tag = { setAttribute: (key, value) => { attrs[key] = value; } };
  const document = { querySelector: () => tag };
  setModelMetadata(document, model);
  assert.equal(document.title, "Sample model — Anyroute"); assert.equal(attrs.content, model.description);
  setModelMetadata(document, null);
  assert.equal(document.title, "Model not found — Anyroute");
  assert.match(modelMetadata({ id: "sample/bare" }).description, /sample\/bare/);
});
test("share and Chat links encode model IDs; curl contains only the environment variable", () => {
  assert.equal(modelPageHref("sample/name + suffix"), "/models/model/?id=sample%2Fname%20%2B%20suffix");
  assert.equal(modelChatHref(model.id), "/harness/?model=sample%2Fmodel");
  assert.equal(modelEndpointsPath(model.id), "/api/v1/models/sample/model/endpoints");
  assert.equal(modelEndpointsPath("bare"), null);
  const snippet = modelCurl(model.id);
  assert.match(snippet, /Bearer \$ANYROUTE_API_KEY/);
  assert.doesNotMatch(snippet, /sk-|sessionStorage|localStorage/);
  assert.match(snippet, /"model":"sample\/model"/);
  // A catalogue ID must remain one data argument even with shell metacharacters.
  const hostile = "sample/quote'$(printf unsafe)";
  const result = spawnSync("sh", ["-c", 'curl() { printf "%s\\n" "$@"; }; ' + modelCurl(hostile)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)).model, hostile);
});
test("fixture rendering covers prices, abilities, provider proofs, windows and unknown IDs", () => {
  const code = `
    import assert from 'node:assert/strict';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ModelPageView } from './components/ModelPage.jsx';
    import ModelPageLink from './components/ModelPageLink.jsx';
    import RouteCard from './components/RouteCard.jsx';
    const model = ${JSON.stringify(model)}, providers = ${JSON.stringify(providers)}, endpoints = ${JSON.stringify(endpoints)};
    const render = props => renderToStaticMarkup(<ModelPageView {...props} />);
    const html = render({model,providers,endpoints});
    for (const text of ['Sample model', 'sample/model', 'Reads words and pictures.', 'Reads images', 'Tools', '$1.40', '$4.40', '$0.0035', 'Per image', '128,000 tokens', '2026-10-09', 'Sample provider', 'Standard provider', '98.5%', '1.5 s', '32.25 tokens / second', '30 days', 'up to an hour', 'Copy curl request', '$ANYROUTE_API_KEY']) assert(html.includes(text), text);
    assert(html.includes('href="/harness/?model=sample%2Fmodel"'));
    assert(!html.includes('sk-ar-'));
    const unknown = render({model:null});
    assert(unknown.includes('Model not found')); assert(unknown.includes('href="/models/"')); assert(!unknown.includes('curl'));
    const bare = render({model:{id:'sample/bare',created:1700000000},providers:[]});
    assert(bare.includes('Date not known')); assert(bare.includes('No tags declared')); assert(bare.includes('Not listed'));
    const loading = render({model}); assert(loading.includes('Loading providers'));
    const unavailable = render({model:{...model,availability:'temporarily_unavailable'},providers:[]}); assert(unavailable.includes('Temporarily unavailable'));
    const proven = render({model, providers:[{...providers[0],attestation:{status:'attested'}}],endpoints}); assert(proven.includes('Proven hardware'));
    const stale = render({model, providers:[{...providers[0],attestation:{status:'attested',stale:true}}],endpoints}); assert(stale.includes('Standard provider'));
    const fallback = render({model,providers}); assert(fallback.includes('Provider-wide')); assert(fallback.includes('No data yet'));
    assert(renderToStaticMarkup(<ModelPageLink model={model}/>).includes('href="/models/model/?id=sample%2Fmodel"'));
    assert(renderToStaticMarkup(<RouteCard model={model} providers={providers}/>).includes('href="/models/model/?id=sample%2Fmodel"'));
  `;
  const result = spawnSync("bun", ["-e", code], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
test("catalogue and route cards link to the page; route stays one static shell and search-only", async () => {
  const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  assert.match(read("components/ModelCatalog.jsx"), /<ModelPageLink model=\{raw\}/);
  assert.match(read("components/RouteCard.jsx"), /<ModelPageLink model=\{model\}/);
  assert.match(read("app/models/model/page.jsx"), /<ModelPage \/>/);
  assert.doesNotMatch(read("components/ModelPage.jsx"), /loadKey|saveKey|sessionStorage|localStorage/);
  const { TASKS } = await import("../lib/site-map.js");
  assert.equal(TASKS.find(task => task.href === "/models/model/").menu, false);
});
