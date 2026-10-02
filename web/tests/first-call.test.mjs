import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { firstCallSteps, firstCallCurl, readFirstCall } from '../lib/first-call.js';
import FirstCallSteps from '../components/account/FirstCallSteps.js';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const snapshot = { me: { hash: 'account' }, credits: { balance: 1 }, receipts: [{ id: 'generation' }] };
test('three steps use authenticated key, current positive balance and a generation', () => {
  assert.deepEqual(firstCallSteps().map(step => step.done), [false, false, false]);
  assert.deepEqual(firstCallSteps(snapshot).map(step => step.done), [true, true, true]);
  for (const balance of [0, -1, NaN, Infinity, undefined]) assert.equal(firstCallSteps({ ...snapshot, credits: { balance, total_credits: 10 } })[1].done, false);
  assert.equal(firstCallSteps({ ...snapshot, credits: { balance: 0.000001 } })[1].done, true);
  assert.equal(firstCallSteps({ ...snapshot, receipts: [], credits: { balance: 1, total_usage: 10 } })[2].done, false);
  assert.deepEqual(firstCallSteps({ ...snapshot, me: null }).map(step => step.done), [false, false, false]);
  assert.equal(firstCallSteps({ me: snapshot.me })[1].unknown, true);
  assert.equal(firstCallSteps({ me: snapshot.me })[2].unknown, true);
});
test('rendered checks have readable status and real step links', () => {
  const html = renderToStaticMarkup(h(FirstCallSteps, { snapshot }));
  assert.equal((html.match(/>Done</g) || []).length, 3);
  assert.equal((html.match(/✓/g) || []).length, 3);
  assert.match(html, /aria-live="polite"/); assert.match(html, /href="\/dashboard\/#payments"/);
  const empty = renderToStaticMarkup(h(FirstCallSteps, {}));
  assert.equal((empty.match(/>Not done</g) || []).length, 3);
  assert.doesNotMatch(html + empty, /\b(?:demo|test|tested|mock|simulated|placeholder)\b|local[ -]build/i);
});
test('public examples never render a connected key; account curl is three lines', () => {
  const key = 'sensitive-key-sentinel';
  const publicHtml = renderToStaticMarkup(h('pre', null, firstCallCurl({ apiKey: key })));
  assert.ok(!publicHtml.includes(key)); assert.match(publicHtml, /\$ANYROUTE_API_KEY/);
  const account = firstCallCurl({ account: true, apiKey: key });
  assert.ok(account.includes(key)); assert.equal(account.split('\n').length, 3);
  assert.match(firstCallCurl({ account: true }), /\$ANYROUTE_API_KEY/);
  const docs = read('components/FirstCallDocs.jsx');
  assert.match(docs, /useAccountKey\(\)/); assert.match(docs, /<FirstCallQuickstart apiKey=\{key\}\/>/); assert.doesNotMatch(docs.match(/<FirstCallQuickstart[^>]*>/)[0], /\baccount[=\s/>]/);
  assert.match(read('components/account/AccountHome.jsx'), /<FirstCallQuickstart apiKey=\{apiKey\} workspace=\{workspace\} account\/>/);
  assert.match(read('app/docs/page.jsx'), /id="quickstart"/);
  assert.match(read('components/account/FirstCallQuickstart.jsx'), /apiKey: connected \? apiKey : ''/);
});
test('existing endpoints are authenticated in headers, and read failures remain unknown', async () => {
  const requests = []; const signal = new AbortController().signal;
  const result = await readFirstCall('credential-sentinel', async (path, options) => {
    requests.push([path, options]);
    if (path.endsWith('/credits')) throw new Error('unavailable');
    return { data: path.endsWith('/key') ? snapshot.me : [] };
  }, signal);
  assert.deepEqual(requests.map(([path]) => path), ['/api/v1/key', '/api/v1/credits', '/api/v1/generations?limit=1']);
  assert.ok(requests.every(([path, options]) => !path.includes('credential-sentinel') && options.key === 'credential-sentinel' && options.signal === signal));
  assert.deepEqual(firstCallSteps(result).map(step => step.done), [true, false, false]); assert.equal(firstCallSteps(result)[1].unknown, true);
  const hook = read('components/account/useFirstCall.js');
  assert.match(hook, /state\?\.key === apiKey/); assert.match(hook, /controller.abort\(\)/);
  assert.match(hook, /15000/); assert.match(hook, /visibilityState === 'hidden'/);
});
