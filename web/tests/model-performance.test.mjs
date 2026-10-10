import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CATALOG_SORTS, filterModels } from "../lib/model-catalog.js";
import { PERFORMANCE_SORTS, performanceLabels, catalogSortFromUrl, catalogSortUrl } from "../lib/model-performance.js";

const model = (id, latency, throughput, uptime) => ({ id, name: id, performance: { latency_p50_ms: latency, throughput_p50_tps: throughput, uptime_percent: uptime, speed_window_seconds: 1800, uptime_window_days: 30, uptime_observations: 100 } });
test("three measured sorts order readings correctly, keep missing last and break ties by name", () => {
  const models = [model("z", 400, 60, 99.2), model("b", 200, 20, 98), { id: "a", name: "a" }, model("c", 400, 60, 99.2), model("d", null, null, null)];
  assert.deepEqual(filterModels(models, { sort: "fastest" }).map(m => m.id), ["b", "c", "z", "a", "d"]);
  assert.deepEqual(filterModels(models, { sort: "throughput" }).map(m => m.id), ["c", "z", "b", "a", "d"]);
  assert.deepEqual(filterModels(models, { sort: "reliable" }).map(m => m.id), ["c", "z", "b", "a", "d"]);
  assert.deepEqual(models.map(m => m.id), ["z", "b", "a", "c", "d"]);
  assert.deepEqual(PERFORMANCE_SORTS.map(option => option.label), ["Fastest right now", "Highest throughput", "Most reliable"]);
  assert.equal(CATALOG_SORTS.length, 7);
});

test("zero is a reading while absent, invalid and unrecognised windows show No recent data", () => {
  assert.deepEqual(filterModels([{ id: "a" }, model("z", 0, 0, 0)], { sort: "reliable" }).map(m => m.id), ["z", "a"]);
  for (const item of [{}, model("bad", NaN, Infinity, 101), model("missing", null, null, null), { performance: { latency_p50_ms: "400", throughput_p50_tps: "60", uptime_percent: "99.2" } }, { ...model("window", 400, 60, 99.2), performance: { speed_window_seconds: 60, uptime_window_days: 1, uptime_observations: 100, latency_p50_ms: 400, throughput_p50_tps: 60, uptime_percent: 99.2 } }]) {
    assert.deepEqual(performanceLabels(item).map(row => row.text), ["No recent data", "No recent data", "No recent data"]);
  }
});

test("card labels use plain words, real values and explicit measurement windows", () => {
  assert.deepEqual(performanceLabels(model("measured", 400, 60, 99.2)).map(row => row.text), ["about 0.4 s latency in the last 30 minutes", "about 60 tokens per second in the last 30 minutes", "99.2% up in the last 30 days"]);
  assert.equal(performanceLabels({ ...model("quiet", 400, 60, 99.2), performance: { ...model("quiet", 400, 60, 99.2).performance, uptime_observations: 0 } })[2].text, "No recent data");
});

test("every chosen sort round trips through the URL, preserving other parameters and the fragment", () => {
  for (const { key } of CATALOG_SORTS) {
    const href = catalogSortUrl("https://anyroute.tech/models/?q=small&sort=name#catalogue", key);
    assert.equal(catalogSortFromUrl(href), key);
    assert.equal(new URL(href, "https://anyroute.tech").searchParams.get("q"), "small");
    assert.ok(href.endsWith("#catalogue"));
  }
  assert.equal(catalogSortFromUrl("/models/"), "name");
  assert.equal(catalogSortFromUrl("/models/?sort=unknown"), "name");
  assert.equal(catalogSortUrl("/models/?q=small&sort=fastest", "unknown"), "/models/?q=small");
});

test("rendered readings are semantic and catalogue wiring restores sort on links and browser navigation", () => {
  const code = `import assert from 'node:assert/strict'; import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import ModelPerformance from './components/ModelPerformance.jsx'; const html = renderToStaticMarkup(React.createElement(ModelPerformance, {model:{}})); assert.ok(html.includes('<dl')); assert.ok(html.includes('<dt')); assert.ok(html.includes('<dd')); assert.equal(html.match(/No recent data/g).length, 3);`;
  const result = spawnSync("bun", ["-e", code], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(new URL("../components/ModelCatalog.jsx", import.meta.url), "utf8");
  assert.match(source, /api\("\/api\/v1\/models\?health=recent"\)/);
  assert.match(source, /catalogSortFromUrl\(window.location.href\)/);
  assert.match(source, /addEventListener\("popstate", restore\)/);
  assert.match(source, /history.pushState\(window.history.state, "", catalogSortUrl/);
  assert.match(source, /<ModelPerformance model=\{raw\} \/>/);
});
