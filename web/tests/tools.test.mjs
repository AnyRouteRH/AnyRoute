import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS_PATH, callBody, describeTools, filterTools } from '../lib/tools.js';

const LIST = [
  { id: 'tl_a', name: 'Quotes', summary: 'Delayed stock quotes', resource: 'https://tool.example/quote', method: 'GET', price_usd: 0.01, pay_to: '0xabc', source: 'listing', skill_id: null, quality: { state: 'passing', consecutive_failures: 0, checked_at: '2026-10-02T00:00:00Z' } },
  { id: 'tl_b', name: 'Rates', summary: 'FX rates', resource: 'https://fx.example/rate', method: 'POST', price_usd: 0.25, pay_to: '0xdef', source: 'skill', skill_id: 'sk_1', quality: { state: 'failing', consecutive_failures: 2 } },
  { id: 'tl_c', name: 'New', resource: 'https://new.example/x', quality: { state: 'weird' } },
  { name: 'broken, no address' },
];

test('the catalog is read from the public tools endpoint', () => {
  assert.equal(TOOLS_PATH, '/api/v1/tools');
});

test('every listing is described in words, never by colour alone', () => {
  const rows = describeTools(LIST);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.stateLabel), ['Canary passing', 'Canary failing (2 of 3)', 'Not probed yet']);
  assert.equal(rows[0].price, '$0.01');
  assert.equal(rows[1].skill, 'sk_1');
  assert.equal(rows[2].price, 'Price on request');
  assert.deepEqual(describeTools(null), []);
});

test('search matches name, summary and address; the call body covers the take', () => {
  const rows = describeTools(LIST);
  assert.deepEqual(filterTools(rows, 'fx').map((r) => r.id), ['tl_b']);
  assert.deepEqual(filterTools(rows, 'STOCK quotes').map((r) => r.id), ['tl_a']);
  const body = JSON.parse(callBody(rows[0]));
  assert.deepEqual(body, { resource: 'https://tool.example/quote', method: 'GET', max_price: 0.0105 });
  assert.ok(body.max_price >= 0.01 * 1.03);
});

test('the OpenAPI document describes the paid tool routes and their refusals', () => {
  const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
  const call = spec.paths['/api/v1/tools/call'].post;
  assert.deepEqual(call.tags, ['Paid tools']);
  assert.deepEqual(call.security, [{ BearerAuth: [] }]);
  assert.match(call.description, /defaults to false and is not switched on/);
  for (const code of ['409', '422', '502', '503']) assert.equal(call.responses[code].content['application/json'].schema.$ref, '#/components/schemas/ApiError');
  assert.deepEqual(spec.components.schemas.ToolCallRequest.required, ['resource', 'max_price']);
  for (const path of ['/api/v1/tools', '/api/v1/tools/search', '/api/v1/tools/listings', '/api/v1/tools/{id}', '/api/v1/tools/calls']) assert.ok(spec.paths[path], path);
});

test('the page says when the market is off and keeps the switch honest', () => {
  const page = readFileSync(new URL('../components/ToolsCatalog.jsx', import.meta.url), 'utf8');
  assert.match(page, /not switched on at this router/);
  const docs = readFileSync(new URL('../components/ToolsMarketDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /TOOLS_MARKET_ENABLED<\/code> defaults to false and is not switched on at anyroute\.tech yet/);
  const dash = String.fromCharCode(0x2014);
  for (const text of [page, docs]) assert.ok(!text.includes(dash));
});
