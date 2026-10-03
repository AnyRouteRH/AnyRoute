import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeFacilitator, LISTING_EXAMPLE, SELLER_EXAMPLE, USDG } from '../lib/facilitator.js';
import { TASKS } from '../lib/site-map.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const on = { enabled: true, url: 'https://anyroute.tech/facilitator', networks: ['eip155:4663'], fee_bps: 0, min_settle_units: '10000', gas_floats: false, relay: { above_floor: true }, listings_screened: true };

test('the status line says only what /api/v1/status reports', () => {
  assert.equal(describeFacilitator(undefined).on, false);
  assert.match(describeFacilitator({ facilitator: { enabled: false } }).text, /Not switched on at this router yet/);
  const live = describeFacilitator({ facilitator: on });
  assert.equal(live.on, true);
  assert.equal(live.text, 'Switched on at this router for eip155:4663; no fee during the launch waiver; minimum 0.01 USDG.');
  assert.match(describeFacilitator({ facilitator: { ...on, fee_bps: 25, gas_floats: true } }).text, /a fee of 0.25%; minimum 0.01 USDG unless the seller prepaid a gas float/);
  assert.match(describeFacilitator({ facilitator: { ...on, relay: { above_floor: false } } }).text, /below its gas floor, so settles are refused/);
});

test('the page, its docs section and its search entry exist, with the status read live', () => {
  const page = read('app/facilitator/page.jsx');
  assert.match(page, /<FacilitatorState \/>/);
  for (const anchor of ['use', 'checks', 'costs', 'listing', 'receipts', 'limits']) assert.ok(page.includes(`id="${anchor}"`), anchor);
  assert.match(read('app/facilitator/FacilitatorState.jsx'), /\/api\/v1\/status/);
  const docs = read('app/docs/page.jsx');
  assert.equal(docs.split('<FacilitatorDocs />').length - 1, 1);
  assert.match(docs, /href="#facilitator"/);
  assert.match(read('components/FacilitatorDocs.jsx'), /id="facilitator"[\s\S]*FACILITATOR_ENABLED defaults to false/);
  const task = TASKS.find(t => t.id === 'facilitator');
  assert.equal(task.href, '/facilitator/');
  assert.equal(task.menu, false);
});

test('the copy is honest: no custody claim beyond relaying, no em dashes, and the examples use the facilitator routes', () => {
  const copy = [read('app/facilitator/page.jsx'), read('components/FacilitatorDocs.jsx'), read('lib/facilitator.js'), read('app/facilitator/FacilitatorState.jsx')].join('\n');
  assert.doesNotMatch(copy, /—/);
  assert.doesNotMatch(copy, /\b(?:trustless|decentralized|guaranteed|partner(?:ship)?|demo|mock|placeholder)\b/i);
  assert.match(copy, /never holds/);
  assert.match(SELLER_EXAMPLE, /post\("\/verify"[\s\S]*post\("\/settle"/);
  assert.ok(SELLER_EXAMPLE.includes(USDG));
  assert.match(LISTING_EXAMPLE, /signTypedData\(\{ \.\.\.policy\.listing, message: listing \}\)/);
});
