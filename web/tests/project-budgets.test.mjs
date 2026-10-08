import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TASKS } from '../lib/site-map.js';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
test('project budgets use existing account views and native labelled keyboard controls', () => {
  const editor = read('../components/account/ProjectBudget.jsx');
  assert.match(editor, /<label>Project<input/); assert.match(editor, /<label>Monthly budget in USD<input type="number"/);
  assert.match(editor, /required value=\{amount\}/); assert.match(editor, /type="button"[^>]*onClick=\{\(\) => change\('DELETE'\)\}/);
  assert.match(editor, /api\('\/api\/v1\/projects/); assert.match(editor, /signal: controller.signal/);
  assert.match(read('../components/account/AccountActivity.jsx'), /<ProjectBudget apiKey=\{apiKey\} project=\{project\}/);
  assert.match(read('../components/account/AccountInsights.jsx'), /<ProjectBudget apiKey=\{apiKey\} project=\{query.project/);
  assert.match(read('../components/account/ProjectBudget.module.css'), /overflow-wrap: anywhere/);
});
test('budget API documentation and search cover all four owner-only operations', () => {
  const spec = JSON.parse(read('../public/openapi.json'));
  for (const method of ['get', 'put', 'delete']) {
    const op = spec.paths['/api/v1/projects/{name}/budget'][method]; assert.ok(op.security.length); assert.ok(op.responses['403']);
  }
  assert.ok(spec.paths['/api/v1/projects'].get.security.length);
  assert.equal(spec.paths['/api/v1/projects/{name}/budget'].put.requestBody.content['application/json'].schema.properties.budget_usd.minimum, 0);
  assert.ok(TASKS.some(task => task.href === '/docs/#project-budgets'));
  const docs = read('../components/ProjectBudgetsDocs.jsx'); assert.match(docs, /PROJECT_BUDGET_TELEGRAM_ENABLED/); assert.match(docs, /default false/); assert.match(docs, /ordinary request text in memory/);
});
