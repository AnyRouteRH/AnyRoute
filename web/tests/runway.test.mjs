import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runwayText, alertAmount } from '../lib/runway.js';
import { BalanceLink } from '../components/nav/AccountTrigger.js';
import { sectionFromHash } from '../components/account/account-state.js';
test('runway wording hides absent or invalid estimates and explains zero and singular days', () => {
  for (const days_left of [null, undefined, -1, '12', Infinity, 1.1]) assert.equal(runwayText({ days_left }), '');
  assert.equal(runwayText({ days_left: 12 }), 'Lasts about 12 days at your 7-day pace');
  assert.equal(runwayText({ days_left: 1 }), 'Lasts about 1 day at your 7-day pace');
  assert.equal(runwayText({ days_left: 0 }), 'Less than a day at your 7-day pace');
});
test('header keeps the balance link and exposes full pace wording to keyboard and assistive users', () => {
  const markup = renderToStaticMarkup(createElement(BalanceLink, { snapshot: { balance: 12, runway: { days_left: 12 } } }));
  assert.match(markup, /href="\/dashboard\/#payments"/);
  assert.match(markup, /aria-label="Balance \$12.00. Add funds. Lasts about 12 days at your 7-day pace./);
  assert.match(markup, /title="Lasts about 12 days at your 7-day pace"/);
  assert.match(markup, /<small aria-hidden="true">About 12 days<\/small>/);
});
test('without spending the header has no runway caption', () => {
  assert.doesNotMatch(renderToStaticMarkup(createElement(BalanceLink, { snapshot: { balance: 0, runway: { days_left: null } } })), /small|pace|days/);
});
test('balance alert amounts allow blank disable, zero and currency precision', () => {
  assert.equal(alertAmount(''), null); assert.equal(alertAmount('  '), null);
  assert.equal(alertAmount('0'), 0); assert.equal(alertAmount('5.10'), 5.1);
  for (const bad of ['-1', '5e1', '1.001', '1000001', 'money']) assert.throws(() => alertAmount(bad));
});
test('the Telegram money link opens the existing Payments section', () => {
  assert.equal(sectionFromHash('#money'), 'Payments'); assert.equal(sectionFromHash('#payments'), 'Payments');
});
