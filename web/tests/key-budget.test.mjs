import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KEY_BUDGET, KEY_BUDGET_WORDS as KB, budgetResetText, keyBudgetFrom, keyBudgetText, keySaveNotice, keySavePlan, limitsFromRulebook, saveKeyLimits } from '../lib/spending-limits.js';

// U104: a key's total budget lives in its spending limits editor, beside the caps.
const source = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const saved = { version: 1, models: {}, caps: { per_day_usd: 4 }, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }], approval: { above_usd: 1 }, on_breach: 'deny' };

test('the total budget reads and writes the key’s own limit; blank means none', () => {
  assert.equal(keyBudgetText(null), ''); assert.equal(keyBudgetText(undefined), ''); assert.equal(keyBudgetText(12.5), '12.5');
  for (const blank of ['', '  ', null]) assert.deepEqual(keyBudgetFrom(blank), { limit: null, errors: [] });
  assert.deepEqual(keyBudgetFrom('25'), { limit: 25, errors: [] }); assert.deepEqual(keyBudgetFrom(String(KEY_BUDGET.max)), { limit: 100_000, errors: [] });
  for (const bad of ['0', '-1', '100000.01', 'abc', 'Infinity']) assert.deepEqual(keyBudgetFrom(bad), { limit: null, errors: [KB.error] }, bad);
  assert.equal(budgetResetText('monthly'), 'It resets each month.'); assert.equal(budgetResetText(null), '');
  assert.equal(KB.label, 'Total budget ($)');
});

test('Save writes only what changed, so a budget-only change leaves the rulebook as it is', () => {
  const none = limitsFromRulebook(null);
  // No rulebook yet and only the budget set: the key's limit alone, without creating an empty rulebook.
  assert.deepEqual(keySavePlan({ form: none, loaded: none, budget: '20', savedBudget: null }), { budget: { limit: 20 }, policy: null, errors: [] });
  // A saved rulebook and a cleared budget: the limit is removed, the rulebook is not rewritten.
  const form = limitsFromRulebook(saved);
  assert.deepEqual(keySavePlan({ form, loaded: limitsFromRulebook(saved), budget: '', savedBudget: 10 }), { budget: { limit: null }, policy: null, errors: [] });
  // Caps changed, budget the same number spelled differently: the rulebook alone, with its other rules kept.
  const edited = { ...form, caps: { ...form.caps, per_hour_usd: '0.5' } };
  assert.deepEqual(keySavePlan({ form: edited, loaded: form, budget: '10.50', savedBudget: 10.5 }), { budget: null, policy: { ...saved, caps: { per_hour_usd: 0.5, per_day_usd: 4 } }, errors: [] });
  // Both changed: both.
  const both = keySavePlan({ form: edited, loaded: form, budget: '30', savedBudget: 10.5 });
  assert.deepEqual(both.budget, { limit: 30 }); assert.deepEqual(both.policy.caps, { per_hour_usd: 0.5, per_day_usd: 4 });
  // Nothing changed: the rulebook saves as before, since Stop and Resume act on saved limits.
  assert.deepEqual(keySavePlan({ form: none, loaded: none, budget: '', savedBudget: null }), { budget: null, policy: { version: 1, models: {}, caps: {}, on_breach: 'deny' }, errors: [] });
  // An error on either side blocks the save, in the editor's words.
  const bad = keySavePlan({ form: { ...none, caps: { ...none.caps, per_day_usd: '-1' } }, loaded: none, budget: '0', savedBudget: null });
  assert.equal(bad.budget, null); assert.ok(bad.errors.includes(KB.error)); assert.ok(bad.errors.some(e => e.startsWith('Cap per day')));
  // Rulebooks switched off (no form): the budget alone.
  assert.deepEqual(keySavePlan({ form: null, loaded: null, budget: '7', savedBudget: null }), { budget: { limit: 7 }, policy: null, errors: [] });
  assert.deepEqual([{ budget: {}, policy: {} }, { budget: {}, policy: null }, { budget: null, policy: {} }].map(keySaveNotice), [KB.saved.both, KB.saved.budget, KB.saved.policy]);
});

test('saving uses the existing calls, budget first, and says when only the budget was saved', async () => {
  let refuse = '';
  const calls = [];
  const request = async (url, opts) => { calls.push([url, opts.method, opts.body]); if (refuse && url.includes(refuse)) throw new Error('Refused.'); return { data: {} }; };
  const heard = [];
  const policy = { version: 1, models: {}, caps: { per_day_usd: 2 }, on_breach: 'deny' };
  await saveKeyLimits(request, 'key/hash', { budget: { limit: 20 }, policy }, limit => heard.push(limit));
  assert.deepEqual(calls, [['/api/v1/keys/key%2Fhash', 'PATCH', { limit: 20 }], ['/api/v1/agents/key%2Fhash/policy', 'PUT', policy]]);
  assert.deepEqual(heard, [20]);
  calls.length = 0; await saveKeyLimits(request, 'k', { budget: { limit: null }, policy: null }, limit => heard.push(limit));
  assert.deepEqual(calls, [['/api/v1/keys/k', 'PATCH', { limit: null }]]); assert.deepEqual(heard, [20, null]);
  calls.length = 0; await saveKeyLimits(request, 'k', { budget: null, policy }, limit => heard.push(limit));
  assert.deepEqual(calls, [['/api/v1/agents/k/policy', 'PUT', policy]]); assert.equal(heard.length, 2);
  // The rulebook is refused after the budget saved: the error says so, and the saved limit was still reported.
  refuse = '/policy'; calls.length = 0;
  await assert.rejects(saveKeyLimits(request, 'k', { budget: { limit: 5 }, policy }, limit => heard.push(limit)), { message: `${KB.partial} Refused.` });
  assert.equal(calls.length, 2); assert.equal(heard.at(-1), 5);
  await assert.rejects(saveKeyLimits(request, 'k', { budget: null, policy }), { message: 'Refused.' });
  // The budget is refused: nothing else is written.
  refuse = '/api/v1/keys/'; calls.length = 0;
  await assert.rejects(saveKeyLimits(request, 'k', { budget: { limit: 5 }, policy }, limit => heard.push(limit)), { message: 'Refused.' });
  assert.deepEqual(calls.map(([, method]) => method), ['PATCH']); assert.equal(heard.at(-1), 5);
});

test('the editor shows the total budget beside the caps, and the keys list has no separate budget control', () => {
  const editor = source('../components/limits/SpendingLimits.jsx');
  const at = mark => editor.indexOf(mark);
  assert.ok(at('{W.caps}') > 0 && at('{W.caps}') < at('{budget && <KeyBudgetField') && at('{budget && <KeyBudgetField') < at('{LIMIT_CAPS.map') && at('{LIMIT_CAPS.map') < at('{W.ask}'));
  assert.match(editor, /max=\{KEY_BUDGET\.max\}/);
  const limits = source('../components/limits/KeyLimits.jsx');
  assert.match(limits, /<SpendingLimits key=\{revision\} id="key-limits"[^>]* budget=\{budgetField\} stop=\{stop\}\/>/);
  assert.match(limits, /saveKeyLimits\(request, keyHash, plan, limit => \{ setSavedBudget\(limit\); onSaved\?\.\(\); \}\)/);
  assert.match(limits, /\{!form && view\.off && <form onSubmit=\{save\}>/); // rulebooks switched off: the budget alone
  assert.doesNotMatch(limits, /budget still applies/);
  const dashboard = source('../components/Dashboard.jsx');
  assert.match(dashboard, /<KeyLimits apiKey=\{apiKey\} keyHash=\{modal\.data\.id\}[^>]* budget=\{modal\.data\.budget\} reset=\{modal\.data\.reset\} spent=\{modal\.data\.spent\} onSaved=\{/);
  assert.match(dashboard, /reset: k\.limit_reset \?\? null,/);
  // A live key is renamed, not re-budgeted, outside its spending limits; only creation takes a starting budget.
  assert.match(dashboard, /method: "PATCH", body: \{ name: values\.name \} \}\);/);
  assert.doesNotMatch(dashboard, /limit: values\.budget \} \}\);\s*setNotice\("Key updated/);
  assert.match(dashboard, /\{live \? "Rename" : "Edit budget"\}/);
  assert.match(dashboard, /const withBudget = !existing \|\| !live;/);
  const docs = source('../components/SpendingLimitsDocs.jsx');
  assert.match(docs, /the editor also sets the key’s total budget, beside the caps/); assert.doesNotMatch(docs, /Edit budget/);
});
