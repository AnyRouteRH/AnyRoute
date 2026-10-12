import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { COMPARE_STORE, compareHref, comparisonDifferences, comparisonModels, loadModelComparison, parseCompareIds, readComparePicks, toggleCompareId, writeComparePicks } from "../lib/model-compare.js";

const a = { id: "sample/a", name: "Model A", context_length: 64000, pricing: { prompt: "0.000002", completion: "0.000004" }, capabilities: ["tools"], provider_names: ["Sample provider"], added_at: 1791586800 };
const b = { ...a, id: "sample/b", name: "Model B", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000006" }, capabilities: ["tools", "vision"] };
const read = file => readFileSync(new URL("../" + file, import.meta.url), "utf8");

test("IDs parse, deduplicate, trim and cap at three; share links round-trip", () => {
  assert.deepEqual(parseCompareIds("?ids=sample%2Fa,%20sample%2Fb%20,sample%2Fa,,sample%2Fc,sample%2Fd"), ["sample/a", "sample/b", "sample/c"]);
  assert.deepEqual(parseCompareIds(""), []);
  const ids = ["sample/name + suffix", "sample/quote'&?#"];
  assert.deepEqual(parseCompareIds(compareHref(ids).split("?")[1]), ids);
  assert.deepEqual(parseCompareIds("?ids=unknown,other"), ["unknown", "other"]);
});
test("tray starts empty, toggles, removes and refuses a fourth pick; blocked storage works", () => {
  let ids = [];
  for (const id of ["a", "b", "c", "d"]) ids = toggleCompareId(ids, id);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.deepEqual(toggleCompareId(ids, "b"), ["a", "c"]);
  assert.deepEqual(toggleCompareId(toggleCompareId(ids, "b"), "d"), ["a", "c", "d"]);
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(readComparePicks(storage), []);
  writeComparePicks(storage, ids); assert.deepEqual(readComparePicks(storage), ids);
  data.set(COMPARE_STORE, '{'); assert.deepEqual(readComparePicks(storage), []);
  data.set(COMPARE_STORE, '"bad"'); assert.deepEqual(readComparePicks(storage), []);
  const denied = { getItem() { throw Error(); }, setItem() { throw Error(); } };
  assert.deepEqual(readComparePicks(denied), []); assert.doesNotThrow(() => writeComparePicks(denied, ids));
});
test("difference wording preserves units, zero prices, missing readings and exact context ratios", () => {
  assert.deepEqual(comparisonDifferences(b, a), ["2x the context", "Cheaper input", "Pricier output"]);
  assert.deepEqual(comparisonDifferences(a, b), ["Less context", "Pricier input", "Cheaper output"]);
  assert.deepEqual(comparisonDifferences(a, a), []);
  assert.deepEqual(comparisonDifferences({ id: "missing" }, a), []);
  assert.deepEqual(comparisonDifferences(null, a), []);
  assert.deepEqual(comparisonDifferences({ ...b, context_length: 96000, pricing: { prompt: "0" } }, a), ["More context", "Cheaper input"]);
  assert.deepEqual(comparisonDifferences({ ...b, context_length: -1, pricing: { prompt: "bad" } }, a), []);
});
test("unknown IDs retain their columns; public loading needs no key and handles partial health failures", async () => {
  assert.deepEqual(comparisonModels([a, b], [b.id, "missing", a.id]).map(({ id, model }) => [id, !!model]), [[b.id, true], ["missing", false], [a.id, true]]);
  const calls = [], controller = new AbortController();
  const result = await loadModelComparison([a.id, "missing", b.id], async (path, options) => {
    calls.push([path, options]);
    if (path === "/api/v1/models") return { data: [a, b] };
    if (path === "/api/v1/providers") return { data: [{ name: "Sample provider", slug: "sample-provider" }] };
    if (path.includes("/b/")) throw Error("offline");
    return { data: { endpoints: [{ provider_slug: "sample-provider", uptime_last_30d: 99 }] } };
  }, controller.signal);
  assert.equal(result.columns[1].model, null); assert.equal(result.healthError, true);
  assert.equal(result.endpoints[a.id][0].uptime_last_30d, 99); assert.equal(result.endpoints[b.id], null);
  assert.equal(calls.length, 4);
  for (const [, options] of calls) assert.deepEqual(options, { signal: controller.signal });
  assert(!calls.some(([path]) => path.includes("missing")));
  await assert.rejects(loadModelComparison([a.id, b.id], async () => ({})), /could not be loaded/);
  const unknown = await loadModelComparison(["missing", "other"], async path => { assert.equal(path, "/api/v1/models"); return { data: [] }; });
  assert.equal(unknown.healthError, false); assert(unknown.columns.every(column => column.model === null));
});
test("rendering compares abilities, prices, providers, proof badges, uptime, first listed and unknown IDs", () => {
  const result = spawnSync("bun", ["-e", `
    import assert from 'node:assert/strict';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ModelCompareView } from './components/ModelCompare.jsx';
    import { ModelCompareButton, ModelCompareTray } from './components/ModelComparePicks.jsx';
    const a = ${JSON.stringify(a)}, b = ${JSON.stringify(b)};
    const providers = [{name:'Sample provider',slug:'sample-provider',uptime_30d:98,attestation:{status:'attested'}}];
    const props = {columns:[{id:a.id,model:a},{id:b.id,model:b},{id:'missing',model:null}],providers,endpoints:{[a.id]:[{provider_slug:'sample-provider',uptime_last_30d:99.5}]},shareUrl:'https://anyroute.tech/models/compare/?ids=sample/a,sample/b'};
    const html = renderToStaticMarkup(<ModelCompareView {...props}/>);
    for (const text of ['Model A','Model B','missing','Model not found','Reads images','Listed','Not listed','$2.00','$1.00','$4.00','$6.00','64,000 tokens','128,000 tokens','2x the context','Cheaper input','Pricier output','Sample provider','Proven hardware','99.5%','98%','For this model','Across this provider','2026-10-09','Copy comparison link','Try in Chat','router reads in memory']) assert(html.includes(text), text);
    assert(html.includes('href="/harness/?model=sample%2Fb"'));
    assert(html.includes('Comparison link<input')); assert(html.includes('readOnly=""'));
    assert(html.includes('data-different="true"')); assert(html.includes('role="region"')); assert(html.includes('tabindex="0"')); assert(html.includes('scope="row"'));
    const missing = renderToStaticMarkup(<ModelCompareView columns={[{id:'missing',model:null},{id:'other',model:null}]}/>);
    assert(!missing.includes('Try in Chat')); assert(missing.includes('Model not found'));
    const bare = renderToStaticMarkup(<ModelCompareView columns={[{id:a.id,model:a},{id:'sample/bare',model:{id:'sample/bare'}}]} providers={[]}/>);
    assert(bare.includes('Date not known')); assert(bare.includes('No data yet'));
    const stale = renderToStaticMarkup(<ModelCompareView {...props} providers={[{...providers[0],attestation:{status:'attested',stale:true}}]}/>);
    assert(stale.includes('Standard provider')); assert(!stale.includes('How to check: Proven hardware'));
    assert(renderToStaticMarkup(<ModelCompareButton model={a}/>).includes('aria-pressed="false"'));
    assert.equal(renderToStaticMarkup(<ModelCompareTray/>), '');
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
test("375px layout contains table scrolling and wrapping tray; entry points and docs use additive components", async () => {
  const css = read("components/ModelCompare.module.css");
  assert.match(css, /\.scroll\s*\{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow-x: auto/);
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /\.picks\s*\{ flex-direction: column/);
  assert.match(css, /\.tray\s*\{ position: fixed;[^}]*calc\(100% - 32px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /focus-visible/);
  for (const file of ["components/ModelCatalog.jsx", "components/ModelPage.jsx"]) {
    assert.match(read(file), /<ModelCompareButton model=/); assert.match(read(file), /<ModelCompareTray models=/);
  }
  assert.match(read("app/models/compare/page.jsx"), /<ModelCompare \/>/);
  assert.match(read("app/docs/page.jsx"), /<ModelCompareDocs \/>/);
  assert.match(read("components/DocsFeatureIndex.jsx"), /\["compare-models"/);
  const { TASKS } = await import("../lib/site-map.js");
  assert.equal(TASKS.find(task => task.id === "compare-models").href, "/models/compare/");
  assert.equal(TASKS.find(task => task.id === "compare-models").menu, false);
});
