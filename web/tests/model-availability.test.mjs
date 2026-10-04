import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { availabilityFields, balanceDisplay, modelUnavailable, selectableModels } from "../lib/model-availability.js";
import { normalizeModel } from "../lib/harness.js";
import { toCatalogModel } from "../lib/api.js";
import { chatModels } from "../lib/arena.js";

test("unavailable catalogue models retain their label and are excluded from selectable entries", () => {
  const healthy = { id: "sample/healthy", name: "Healthy" };
  const exhausted = { id: "sample/exhausted", name: "Exhausted", availability: "temporarily_unavailable" };
  assert.deepEqual(availabilityFields(healthy), {});
  assert.deepEqual(selectableModels([healthy, exhausted]), [healthy]);
  assert.equal(modelUnavailable(normalizeModel(exhausted)), true);
  assert.equal(modelUnavailable(normalizeModel(healthy)), false);
  assert.equal(modelUnavailable(toCatalogModel(exhausted)), true);
  assert.deepEqual(chatModels([toCatalogModel(healthy), toCatalogModel(exhausted)]).map(m => m.id), [healthy.id]);
  assert.deepEqual(selectableModels([healthy]), [healthy]);
});

test("operator readings retain negative fractional USD values", () => {
  assert.equal(balanceDisplay(-0.0039), "-0.0039");
  assert.equal(balanceDisplay(0), "0");
  assert.equal(balanceDisplay(null), "Unknown");
});

test("Harness and catalogue wire availability labels, selection guards and refresh", () => {
  const harness = readFileSync(new URL("../components/Harness.jsx", import.meta.url), "utf8");
  assert.match(harness, /disabled=\{modelUnavailable\(m\)\}/);
  assert.match(harness, /Temporarily unavailable/);
  assert.match(harness, /if \(modelUnavailable\(find\(id\)\)\) return/);
  assert.match(harness, /useCatalogRefresh\(loadCatalog\)/);
  const catalog = readFileSync(new URL("../components/ModelCatalog.jsx", import.meta.url), "utf8");
  assert.match(catalog, /modelUnavailable\(raw\) \? <span role="status">Temporarily unavailable/);
  const dashboard = readFileSync(new URL("../components/Dashboard.jsx", import.meta.url), "utf8");
  assert.match(dashboard, /disabled=\{modelUnavailable\(m\)\}/);
});
