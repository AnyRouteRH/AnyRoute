import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KEY_BUDGET_WORDS as KB, TOPUP, TOPUP_FIELDS, TOPUP_WORDS as TW, keySaveNotice, keySavePlan, limitsFromRulebook, saveKeyLimits, topupCardText, topupFrom, topupSummary, topupText } from '../lib/spending-limits.js';
import { ACTIVITY_KINDS, ACTIVITY_LABELS } from '../lib/activity.js';
import { TASKS } from '../lib/site-map.js';
import { searchAll } from '../lib/site-actions.js';

// U113: auto top-up sits under a key's total budget in its spending limits, and saves in the same PATCH.
const source = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const rule = { below_usd: 2, add_usd: 10, max_per_week_usd: 50 };
const text = { below: '2', add: '10', perWeek: '50' };

test('the three amounts read and write the key’s topup rule; all blank turns it off', () => {
  assert.deepEqual(topupText(null), { below: '', add: '', perWeek: '' });
  assert.deepEqual(topupText(rule), text);
  assert.deepEqual(topupFrom(text), { topup: rule, errors: [] });
  assert.deepEqual(topupFrom({ below: ' ', add: '', perWeek: '' }), { topup: null, errors: [] });
  assert.deepEqual(topupFrom(undefined), { topup: null, errors: [] });
  assert.deepEqual(topupFrom({ ...text, perWeek: '' }), { topup: null, errors: [TW.incomplete] });
  for (const bad of [{ ...text, below: '0' }, { ...text, add: '1000.01' }, { ...text, perWeek: '5000.5' }, { ...text, below: 'abc' }, { ...text, add: '-1' }]) assert.deepEqual(topupFrom(bad), { topup: null, errors: [TW.range] }, JSON.stringify(bad));
  assert.deepEqual(topupFrom({ below: '1', add: '60', perWeek: '50' }), { topup: null, errors: [TW.order] });
  assert.deepEqual(topupFrom({ below: '1000', add: '1000', perWeek: '5000' }).errors, []);
  assert.deepEqual(TOPUP, { below: 1000, add: 1000, perWeek: 5000 });
  assert.deepEqual(TOPUP_FIELDS.map(([k]) => k), ['below', 'add', 'perWeek']);
});

test('the summary line says the rule in one sentence, with this week’s top-ups when known', () => {
  assert.equal(topupSummary(text), 'When this key has less than $2 left, add $10 from your account credits, at most $50 per week.');
  assert.equal(topupSummary({ below: '0.5', add: '2.5', perWeek: '20' }, { week: 7.5 }), 'When this key has less than $0.50 left, add $2.50 from your account credits, at most $20 per week. Added this week: $7.50.');
  assert.equal(topupSummary({ below: '', add: '', perWeek: '' }), TW.off);
  assert.equal(topupSummary({ ...text, add: '' }), TW.incomplete);
  assert.equal(topupSummary(text, { reset: 'weekly' }), `${TW.resets} It resets each week.`);
  assert.equal(topupCardText(rule), 'Auto top-up: adds $10 below $2 left, up to $50 a week.');
  assert.equal(topupCardText(null), '');
});

test('Save sends the topup in the budget’s PATCH only when it changed, and blocks rules the router refuses', () => {
  const none = limitsFromRulebook(null);
  const base = { form: none, loaded: none, budget: '20', savedBudget: 20 };
  // Unchanged, or not given: the key is not written, so the rulebook saves as before.
  assert.equal(keySavePlan({ ...base, topup: text, savedTopup: rule }).budget, null);
  assert.equal(keySavePlan(base).budget, null);
  // Turned on, changed, turned off.
  assert.deepEqual(keySavePlan({ ...base, topup: text, savedTopup: null }), { budget: { topup: rule }, policy: null, errors: [] });
  assert.deepEqual(keySavePlan({ ...base, topup: { ...text, add: '5' }, savedTopup: rule }).budget, { topup: { ...rule, add_usd: 5 } });
  assert.deepEqual(keySavePlan({ ...base, topup: { below: '', add: '', perWeek: '' }, savedTopup: rule }).budget, { topup: null });
  // Budget and rule together in one PATCH.
  assert.deepEqual(keySavePlan({ ...base, budget: '30', topup: text, savedTopup: null }).budget, { limit: 30, topup: rule });
  // Without rulebooks (form null): the key alone.
  assert.deepEqual(keySavePlan({ form: null, loaded: null, budget: '7', savedBudget: 7, topup: text, savedTopup: null }), { budget: { topup: rule }, policy: null, errors: [] });
  // A rule needs a total budget that does not reset; incomplete amounts block the save.
  assert.deepEqual(keySavePlan({ ...base, budget: '', topup: text, savedTopup: null }).errors, [TW.needsBudget]);
  assert.deepEqual(keySavePlan({ ...base, topup: text, savedTopup: null, reset: 'daily' }).errors, [TW.resets]);
  assert.deepEqual(keySavePlan({ ...base, topup: { ...text, below: '' }, savedTopup: null }).errors, [TW.incomplete]);
  assert.equal(keySavePlan({ ...base, budget: '', topup: { below: '', add: '', perWeek: '' }, savedTopup: rule }).errors.length, 0);
  // Notices name what was saved.
  assert.deepEqual([{ budget: { topup: rule }, policy: null }, { budget: { limit: 1, topup: rule }, policy: null }, { budget: { topup: null }, policy: {} }, { budget: { limit: 1, topup: rule }, policy: {} }].map(keySaveNotice),
    ['Auto top-up saved.', 'Total budget and auto top-up saved.', 'Auto top-up and spending limits saved.', 'Total budget and auto top-up and spending limits saved.']);
  assert.equal(keySaveNotice({ budget: { limit: 1 }, policy: null }), KB.saved.budget);
});

test('saving writes the rule with the budget’s PATCH and reports what was saved', async () => {
  const calls = [], heard = [];
  let refuse = '';
  const request = async (url, opts) => { calls.push([url, opts.method, opts.body]); if (refuse && url.includes(refuse)) throw new Error('Refused.'); return { data: {} }; };
  const policy = { version: 1, models: {}, caps: {}, on_breach: 'deny' };
  await saveKeyLimits(request, 'k', { budget: { topup: rule }, policy: null }, (limit, body) => heard.push([limit, body]));
  assert.deepEqual(calls, [['/api/v1/keys/k', 'PATCH', { topup: rule }]]);
  assert.deepEqual(heard, [[undefined, { topup: rule }]]);
  refuse = '/policy'; calls.length = 0;
  await assert.rejects(saveKeyLimits(request, 'k', { budget: { topup: null }, policy }), { message: 'Auto top-up saved. The spending limits were not saved: Refused.' });
  await assert.rejects(saveKeyLimits(request, 'k', { budget: { limit: 3, topup: rule }, policy }), { message: 'Total budget and auto top-up saved. The spending limits were not saved: Refused.' });
  await assert.rejects(saveKeyLimits(request, 'k', { budget: { limit: 3 }, policy }), { message: `${KB.partial} Refused.` });
});

test('the editor shows Auto top-up under the total budget and saves it with the key', () => {
  const editor = source('../components/limits/SpendingLimits.jsx');
  assert.ok(editor.indexOf('{budget.topup && <AutoTopupRow') > editor.indexOf('id={`${id}-budget`}'));
  assert.match(editor, /TOPUP_FIELDS\.map\(\(\[k, label, max\]\)/);
  assert.match(editor, /aria-live="polite">\{topup\.summary\}/);
  const limits = source('../components/limits/KeyLimits.jsx');
  assert.match(limits, /keySavePlan\(\{ form, loaded, budget: budgetValue, savedBudget, topup: topupValue, savedTopup, reset \}\)/);
  assert.match(limits, /topup: \{ value: topupValue, onChange: setTopupValue, summary: topupSummary\(topupValue, \{ week, reset \}\) \}/);
  assert.match(limits, /request\('\/api\/v1\/keys\/' \+ encodeURIComponent\(keyHash\)/);
  assert.match(limits, /setWeek\(r\.data\.topups_this_week_usd \?\? null\)/);
  const dashboard = source('../components/Dashboard.jsx');
  assert.match(dashboard, /topup: k\.topup \?\? null,/);
  assert.match(dashboard, /<KeyLimits [^>]*topup=\{modal\.data\.topup\}/);
  assert.match(dashboard, /\{k\.topup && <p className="help-text">\{topupCardText\(k\.topup\)\}<\/p>\}/);
  assert.match(source('../components/limits/SpendingLimits.module.css'), /@media \(max-width: 560px\) \{ \.grid3 \{ grid-template-columns: 1fr; \} \}/);
});

test('top-ups have an Activity filter, a docs section after Spending limits, an index link and a site-map task', () => {
  assert.ok(ACTIVITY_KINDS.includes('topup')); assert.equal(ACTIVITY_LABELS.topup, 'Top-ups');
  const page = source('../app/docs/page.jsx');
  assert.ok(page.includes('<SpendingLimitsDocs /><DefaultRouteDocs /><StarterSetupsDocs /><AutoTopupDocs />')); // after spending limits and its setups
  assert.equal(page.split('<AutoTopupDocs />').length - 1, 1);
  const docs = source('../components/AutoTopupDocs.jsx');
  assert.match(docs, /<section id="auto-topup">/);
  for (const phrase of ['No money moves.', 'Monday 00:00 to Sunday 24:00 UTC', 'Auto top-up is not a cap.', 'topups_this_week_usd', '“Topped up Research agent by $10; $40 left this week”']) assert.ok(docs.includes(phrase), phrase);
  assert.match(source('../components/DocsFeatureIndex.jsx'), /\["auto-topup", "Auto top-up"\]/);
  assert.match(source('../components/SpendingLimitsDocs.jsx'), /<a href="#auto-topup">Auto top-up<\/a>/);
  const task = TASKS.find(item => item.id === 'auto-topup');
  assert.deepEqual([task.title, task.href, task.group, task.menu], ['Refill a key’s budget from your credits', '/dashboard/#api-keys', 'agents', false]);
  assert.ok(task.description.startsWith('Top up a key automatically from your credits'));
  // “top up” alone still means Add funds; the key's refill is found by its own words.
  assert.equal(searchAll('top up')[0].id, 'add-funds'); assert.equal(searchAll('refill budget')[0].id, 'auto-topup'); assert.equal(searchAll('auto top-up')[0].id, 'auto-topup');
  // Wording: plain benefit copy, none of the words kept off public pages.
  const copy = [docs, JSON.stringify(TW), task.title, task.description].join(' ');
  assert.doesNotMatch(copy, /\b(?:demo|test|tested|local|mock|simulated|placeholder|fixture|earn|yield|APY|returns|kill|x402)\b/i);
});
