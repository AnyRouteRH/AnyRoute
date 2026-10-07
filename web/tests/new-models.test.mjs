import test from "node:test";
import assert from "node:assert/strict";
import { isNewModel, newModels, newModelRates, NEW_MODELS_FILTER } from "../lib/new-models.js";
import { filterModels } from "../lib/model-catalog.js";
import { normalizeModel } from "../lib/harness.js";
const now = 1790000000;
const model = (id, added_at, capabilities = []) => ({ id, name: id, added_at, capabilities, pricing: { prompt: "0.000001", completion: "0.000002" } });
test("new badges use first observation with an exact seven-day window", () => {
  assert.equal(isNewModel(model("sample/fresh", now), 7, now), true);
  assert.equal(isNewModel(model("sample/last", now - 7 * 86400 + 1), 7, now), true);
  for (const added of [null, undefined, 0, now + 1, now - 7 * 86400, String(now)]) assert.equal(isNewModel(model("sample/old", added), 7, now), false);
  assert.equal(isNewModel({ created: now }, 7, now), false);
});
test("rows hide when empty, order new arrivals first, and include at most six", () => {
  assert.deepEqual(newModels([model("sample/baseline", null)], now), []);
  const models = Array.from({ length: 8 }, (_, i) => model(`sample/${i}`, now - i));
  assert.deepEqual(newModels(models.reverse(), now).map(m => m.id), ["sample/0", "sample/1", "sample/2", "sample/3", "sample/4", "sample/5"]);
});
test("New this week combines with existing search and abilities without changing ordinary filters", () => {
  const time = Math.floor(Date.now() / 1000);
  const models = [model("sample/new", time, ["tools"]), model("sample/old", time - 8 * 86400, ["tools"]), model("other/new", time)];
  assert.deepEqual(filterModels(models, { query: "sample", tags: [NEW_MODELS_FILTER, "tools"] }).map(m => m.id), ["sample/new"]);
  assert.deepEqual(filterModels(models, { tags: ["tools"] }).map(m => m.id), ["sample/new", "sample/old"]);
});
test("Chat retains added_at, abilities and prices through the existing normalizer", () => {
  const raw = model("sample/new", now, ["tools"]);
  const normalized = normalizeModel(raw);
  assert.equal(normalized.added_at, now);
  assert.deepEqual(normalized.capabilities, ["tools"]);
  assert.deepEqual(newModelRates(raw), { input: "$1", output: "$2" });
  assert.deepEqual(newModelRates(normalized), newModelRates(raw));
  assert.equal(newModelRates({}).input, "Not listed");
});

test("rows render abilities and prices, hide empty, and only select on a click", async () => {
  const { spawnSync } = await import("node:child_process");
  const code = `
    import assert from 'node:assert/strict';
    import { NewModelsRow, NewModelBadge, NewModelsFilter } from './components/NewModels.jsx';
    const time = Math.floor(Date.now() / 1000);
    const model = { id: 'sample/new', name: 'Fresh model', added_at: time, capabilities: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } };
    const clicks = [];
    assert.equal(NewModelsRow({ models: [] }), null);
    assert.equal(NewModelsRow({ models: [{...model, added_at:null}] }), null);
    assert.equal(NewModelBadge({ model:{created:time} }), null);
    assert.equal(NewModelBadge({ model }).props.children, 'New');
    const row = NewModelsRow({ models:[model], onChoose:id=>clicks.push(id), dark:true });
    assert.equal(row.props['aria-label'], 'New this week');
    const item = row.props.children[1].props.children[0];
    const [button, chips, rates] = item.props.children;
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.children, 'Fresh model');
    assert.deepEqual(clicks, []);
    assert.equal(chips.props.model, model);
    assert.equal(rates.props.children.join(''), '$1 input · $2 output / 1M tokens');
    button.props.onClick();
    assert.deepEqual(clicks, ['sample/new']);
    const filter = NewModelsFilter({ tags:[], onToggle:key=>clicks.push(key) }).props.children;
    assert.equal(filter.props['aria-pressed'], false);
    filter.props.onClick();
    assert.equal(clicks[1], 'newThisWeek');
    const unavailable = NewModelsRow({ models:[{...model, availability:'temporarily_unavailable'}], onChoose:id=>clicks.push(id) });
    assert.equal(unavailable.props.children[1].props.children[0].props.children[0].type, 'strong');
  `;
  const result = spawnSync("bun", ["-e", code], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
