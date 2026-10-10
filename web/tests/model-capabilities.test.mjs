import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODEL_CAPABILITIES, LONG_CONTEXT_TOKENS, deriveCapabilities, modelCapabilities } from "../lib/model-capabilities.js";
import { CATALOG_SORTS, filterModels, modelTagCounts } from "../lib/model-catalog.js";
import { normalizeModel, filterCatalog, capCounts } from "../lib/harness.js";
import { imageOutput, readsImages } from "../lib/harness-images.js";
const records = JSON.parse(readFileSync(new URL("../../test/fixtures/integrations-models.json", import.meta.url))).data;
const aci = JSON.parse(readFileSync(new URL("../../test/fixtures/aci-models-catalogue.json", import.meta.url))).data;

test("real catalogue shapes derive the shared vocabulary without guessing from names or rates", () => {
  const table = [
    [records[0], ["tools", "longContext", "attested"]],
    [records[2], ["vision", "audio", "tools", "longContext"]],
    [records[4], ["attested"]],
    [records[7], []],
    [{ architecture: { modality: "text+image->text+image" } }, ["vision", "imageOut"]],
    [{ inputs: ["audio"], outputs: ["text"], params: new Set(["tools"]), context: LONG_CONTEXT_TOKENS }, ["audio", "tools", "longContext"]],
    [{ name: "Vision audio encrypted network", pricing: { image: "0.04" }, lanes: ["attested"], attestation: { best: "policy" } }, []],
    [{ attested_available: false, disclosure: { best: "attested" } }, []],
    [{ disclosure: { best: "attested" } }, ["attested"]],
    [{ network_host_available: true, encrypted_chat_available: true }, ["network", "encrypted"]],
  ];
  for (const [record, expected] of table) assert.deepEqual(deriveCapabilities(record), expected);
  assert.deepEqual(deriveCapabilities({ context_length: LONG_CONTEXT_TOKENS - 1 }), []);
  assert.deepEqual(deriveCapabilities({ context_length: LONG_CONTEXT_TOKENS }), ["longContext"]);
  const image = aci.find(model => model.input_modalities.includes("image"));
  assert.ok(image);
  assert.ok(deriveCapabilities(image).includes("vision"));
  assert.equal(MODEL_CAPABILITIES.length, 8);
  for (const tag of MODEL_CAPABILITIES) assert.ok(tag.explanation.length > 20);
  assert.equal(MODEL_CAPABILITIES.find(tag => tag.key === "network").href, "/network/");
});

test("new capabilities are authoritative and old API fields remain a fallback in both views", () => {
  assert.deepEqual(modelCapabilities({ ...records[2], capabilities: [] }), []);
  assert.deepEqual(modelCapabilities({ capabilities: ["network", "network", "unknown"] }), ["network"]);
  for (const record of [...records, ...aci]) {
    const normalized = normalizeModel(record);
    assert.deepEqual(modelCapabilities(normalized), modelCapabilities(record));
    assert.equal(readsImages(normalized), modelCapabilities(record).includes("vision"));
    assert.equal(imageOutput(normalized), modelCapabilities(record).includes("imageOut"));
  }
});

test("search, intersection filters and counts work for one catalogue including network offers", () => {
  const models = [
    { ...records[0], provider_names: ["Confidential gateway"] },
    { ...records[2], capabilities: ["vision", "tools", "network"] },
    { ...records[4], capabilities: ["network", "attested"] },
  ];
  assert.deepEqual(filterModels(models, { query: "CONFIDENTIAL gateway" }).map(m => m.id), [records[0].id]);
  assert.deepEqual(filterModels(models, { tags: ["network", "vision"] }).map(m => m.id), [records[2].id]);
  assert.equal(modelTagCounts(models).network, 2);
  assert.equal(modelTagCounts(models, { tags: ["network"] }).vision, 1);
  assert.equal(modelTagCounts(models, { query: "gateway" }).network, 0);
  const normalized = models.map(normalizeModel);
  assert.deepEqual(filterCatalog(normalized, { caps: ["network", "vision"] }).map(m => m.id), [records[2].id]);
  assert.equal(capCounts(normalized, { caps: ["network"] }).vision, 1);
  assert.equal(filterCatalog(normalized, { query: "confidential gateway" }).length, 1);
});

test("name, input price, output price and context sorts are deterministic without mutating input", () => {
  const models = [
    { id: "b", name: "Beta", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000001" } },
    { id: "a", name: "Alpha", context_length: 4000, pricing: { prompt: "0", completion: "0.000005" } },
    { id: "c", name: "Gamma", context_length: 1000000, pricing: {} },
  ];
  const ids = sort => filterModels(models, { sort }).map(model => model.id);
  assert.deepEqual(ids("name"), ["a", "b", "c"]);
  assert.deepEqual(ids("priceIn"), ["a", "b", "c"]);
  assert.deepEqual(ids("priceOut"), ["b", "a", "c"]);
  assert.deepEqual(ids("context"), ["c", "b", "a"]);
  assert.deepEqual(models.map(model => model.id), ["b", "a", "c"]);
  assert.deepEqual(CATALOG_SORTS.filter(option => ["name", "priceIn", "priceOut", "context"].includes(option.key)).map(option => option.key), ["name", "priceIn", "priceOut", "context"]);
});

test("Harness and models use the same module and chip component; API uses the canonical implementation", () => {
  for (const name of ["Harness", "ModelCatalog"]) {
    const source = readFileSync(new URL(`../components/${name}.jsx`, import.meta.url), "utf8");
    assert.match(source, /from "\.\.\/lib\/model-capabilities\.js"/);
    assert.match(source, /from "\.\/ModelCapabilities"/);
  }
  const adapter = readFileSync(new URL("../../src/api/model-capabilities.ts", import.meta.url), "utf8");
  assert.match(adapter, /from "\.\.\/catalog\/model-capabilities\.js"/);
  assert.equal(readFileSync(new URL("../lib/model-capabilities.js", import.meta.url), "utf8"), readFileSync(new URL("../../src/catalog/model-capabilities.js", import.meta.url), "utf8"));
});

test('the web copy of the capability vocabulary matches the router module exactly', async () => {
  const { readFileSync } = await import('node:fs');
  const router = readFileSync(new URL('../../src/catalog/model-capabilities.js', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../lib/model-capabilities.js', import.meta.url), 'utf8');
  assert.equal(web, router, 'copy src/catalog/model-capabilities.js to web/lib/model-capabilities.js');
});
