import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as review from '../lib/rulebook-review.js';
import { rulebookParts } from '../lib/rulebook-words.js';
import { limitsFromRulebook, rulebookFromLimits } from '../lib/spending-limits.js';
import { TASKS } from '../lib/site-map.js';

const base = { version: 1, caps: {}, models: {}, on_breach: 'deny' };
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('each cap and token limit has an exact, readable before and after, including removal', () => {
  for (const [key, label] of [['per_request_usd', 'Cap per request'], ['per_hour_usd', 'Hourly cap'], ['per_day_usd', 'Daily cap'], ['per_week_usd', 'Weekly cap']]) {
    const before = { ...base, caps: { [key]: 5 } }, after = { ...base, caps: { [key]: 10 } };
    assert.deepEqual(review.rulebookReviewLines(before, after), [`${label}: $5 → $10`]);
    assert.deepEqual(review.rulebookReviewLines(before, base), [`${label}: $5 → No cap`]);
    assert.deepEqual(review.rulebookReviewLines(base, after), [`${label}: No cap → $10`]);
  }
  assert.deepEqual(review.rulebookReviewLines(base, { ...base, caps: { per_request_usd: 1e-7 } }), ['Cap per request: No cap → $0.0000001']);
  assert.deepEqual(review.rulebookReviewLines({ ...base, caps: { max_output_tokens: 10 } }, { ...base, caps: { max_output_tokens: 20 } }), ['Maximum output tokens: 10 tokens → 20 tokens']);
});

test('every other rule type reuses history sentences, including additions and removals', () => {
  const fields = {
    models: { allow: ['author/model'], deny: ['author/other'] }, lanes: ['attested'], route_default: 'proven_only',
    tools: { allow: ['lookup'], deny: ['remove'], max_price_per_call: 2, daily_budget: 5, pass_to_models: false },
    approval: { above_usd: 1, above_calls_per_hour: 3 },
    work_hours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', time_zone: 'UTC', outside: 'ask_first' },
    windows: [{ days: [0], start: '01:00', end: '02:00' }],
    actions: { allow: ['payment.send'], deny: ['trade.order'], targets: { allow: ['sample-target'], deny: ['other-target'] }, per_action_usd: 5, per_day_usd: 10, approval_above_usd: 3, max_per_hour: 2 },
    breakers: { max_spend_usd_per_minute: 1, max_requests_per_minute: 3, max_denials_per_10min: 2, max_distinct_models_per_hour: 4 },
    alerts: { at_percent: [80], denials_in_10min: 4, channels: ['telegram'] },
    agreements: { max_escrow_usd: 5, counterparties_allow: ['sample-counterparty'] },
    autonomy: { rungs: [{ caps_multiplier: 2, after_days: 1, clean_requests: 5 }], demote_on: ['deny', 'kill', 'breaker'] },
    on_breach: 'kill',
  };
  for (const [key, value] of Object.entries(fields)) {
    const after = { ...base, [key]: value }, lines = review.rulebookReviewLines(base, after);
    assert.ok(lines.length, key);
    for (const sentence of rulebookParts(after).filter(line => !['caps', 'breach'].includes(line.part))) {
      assert.ok(lines.some(line => line.includes(sentence.text)), `${key}: ${sentence.text}`);
    }
    assert.ok(review.rulebookReviewLines(after, base).every(line => line.startsWith('Removes ') || line.includes(' → ')), key);
    assert.doesNotMatch(lines.join(' '), /[{}]|"\w+":|\bkill\b/);
  }
  assert.match(review.rulebookReviewLines(base, { ...base, work_hours: fields.work_hours })[0], /^Adds work hours: Works Monday to Friday, 9:00 to 18:00 UTC/);
  assert.deepEqual(review.rulebookReviewLines(base, { ...base, actions: {} }), ['Adds Actions (Agent Guard): Action rules set with no action limits']);
});

test('work hours changes cover zone, days, times and outside-hours decision separately from UTC windows', () => {
  const before = { ...base, work_hours: { days: [1], start: '09:00', end: '18:00', time_zone: 'UTC', outside: 'refuse' }, windows: [] };
  for (const patch of [{ days: [2] }, { start: '10:00' }, { end: '19:00' }, { time_zone: 'Europe/London' }, { outside: 'ask_first' }]) {
    const lines = review.rulebookReviewLines(before, { ...before, work_hours: { ...before.work_hours, ...patch } });
    assert.equal(lines.length, 1); assert.match(lines[0], /^work hours: Works .* → Works /);
    assert.doesNotMatch(lines[0], /No allowed hours/);
  }
});

test('approver review uses existing mode labels and member names, never member identifiers', () => {
  const members = [{ id: 'one', name: 'Sample reviewer' }, { id: 'two', name: 'Other reviewer' }];
  const before = { mode: 'owners', member_ids: [] };
  assert.deepEqual(review.approverReviewLines(before, { mode: 'specific_members', member_ids: ['one'] }, members), ['Who can approve: Owners only → Specific members', 'Adds approver: Sample reviewer']);
  assert.deepEqual(review.approverReviewLines({ mode: 'specific_members', member_ids: ['one'] }, { mode: 'specific_members', member_ids: ['two'] }, members), ['Removes approver: Sample reviewer', 'Adds approver: Other reviewer']);
  assert.deepEqual(review.approverReviewLines(before, { mode: 'owners_and_admins', member_ids: [] }), ['Who can approve: Owners only → Owners and admins']);
  assert.deepEqual(review.approverReviewLines(before, { mode: 'owners', member_ids: ['one'] }, members), []);
});

test('unchanged policies, numeric round trips and reordered approvers leave Save disabled', () => {
  const saved = { ...base, caps: { per_day_usd: 5 }, route_default: 'standard' };
  const form = limitsFromRulebook(saved); form.caps.per_day_usd = '5.00';
  assert.deepEqual(review.rulebookReviewLines(saved, rulebookFromLimits(form).policy), []);
  assert.deepEqual(review.rulebookReviewLines(base, structuredClone(base)), []);
  assert.deepEqual(review.approverReviewLines({ mode: 'specific_members', member_ids: ['one', 'two'] }, { mode: 'specific_members', member_ids: ['two', 'one'] }), []);
  assert.deepEqual(review.reviewState([]), { changed: false, disabled: true, label: 'Save', notice: 'Nothing to save', canReview: false });
  assert.equal(review.reviewState(['Daily cap changed'], ['Invalid amount']).canReview, false);
  assert.equal(review.reviewState(['Daily cap changed'], [], true).canReview, false);
  assert.equal(review.rulebookReviewLines(null, base)[0], 'Adds a rulebook');
  assert.equal(review.reviewSignature({ b: 2, a: 1 }), review.reviewSignature({ a: 1, b: 2 }));
});

test('replay summary is honest about mixed records, empty, unavailable, stale and truncated activity', () => {
  const data = { evaluated: 10, denied: 3, asked: 2, truncated: false };
  assert.equal(review.reviewReplaySummary(data), 'Would have refused 3 recorded calls and actions in the last 7 days and asked first for 2.');
  assert.match(review.reviewReplaySummary({ ...data, truncated: true }), /Only part of the recorded activity/);
  assert.match(review.reviewReplaySummary({ evaluated: 0 }), /No calls or actions were recorded/);
  assert.match(review.reviewReplaySummary(null), /unavailable.*still review and save/);
  assert.equal(review.currentReviewReplay({ data, policy: base }, base), true);
  assert.equal(review.currentReviewReplay({ data, policy: base }, { ...base, caps: { per_day_usd: 5 } }), false);
});

// Exercise the actual capture/Save/Back handlers with persistent hook slots. No DOM package is needed.
function reviewHarness() {
  const slots = []; let cursor = 0;
  const useState = initial => { const at = cursor++; if (!(at in slots)) slots[at] = initial; return [slots[at], value => { slots[at] = value; }]; };
  const useRef = initial => { const at = cursor++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; };
  const source = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: read('components/limits/RulebookReview.jsx'), encoding: 'utf8' });
  const bindings = { React, ...review, createContext: React.createContext, useContext: () => review.reviewState([]), useId: () => 'review', useRef, useState, useEffect: () => {}, Button: 'button', ReplayResult: 'replay-result', ReplayButton: 'replay-button', s: {} };
  const components = new Function(...Object.keys(bindings), source.replace(/^import .*;\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '') + '\nreturn {ChangeReview, ReviewButton};')(...Object.values(bindings));
  return { ...components, render(props) { cursor = 0; return components.ChangeReview({ errors: [], children: () => React.createElement('form'), ...props }); } };
}
const childrenOf = element => React.Children.toArray(element.props.children);

test('review stops submit, Back keeps edits, and only final Save reaches the original submit handler once', () => {
  const harness = reviewHarness(); let saves = 0, replays = 0, capture;
  const value = { ...base, caps: { per_day_usd: 10 } };
  const props = { lines: ['Daily cap: $5 → $10'], value, replay: { data: null, run: () => replays++ } };
  const form = { requestSubmit() { const event = submit(); capture(event); if (!event.prevented) saves++; } };
  const submit = () => ({ target: form, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  const render = () => { const tree = harness.render(props); capture = childrenOf(tree)[0].props.onSubmitCapture; return tree; };
  let tree = render(), event = submit(); capture(event);
  assert.equal(event.prevented, true); assert.equal(saves, 0); assert.equal(replays, 1);
  tree = render(); assert.equal(childrenOf(tree)[0].props.hidden, true);
  const section = childrenOf(tree)[1], row = childrenOf(section).at(-1), [save, back] = childrenOf(row);
  back.props.onClick(); tree = render(); assert.equal(childrenOf(tree)[0].props.hidden, false); assert.equal(saves, 0);
  capture(submit()); tree = render(); childrenOf(childrenOf(childrenOf(tree)[1]).at(-1))[0].props.onClick();
  assert.equal(saves, 1);
  assert.equal(save.props.children, 'Save');
});

test('unchanged, locked and busy submits cannot save; invalid drafts reach existing validation only', () => {
  for (const props of [{ lines: [] }, { lines: ['A change'], busy: true }, { lines: ['A change'], locked: true }]) {
    const tree = reviewHarness().render({ value: base, ...props }); let prevented = false;
    childrenOf(tree)[0].props.onSubmitCapture({ preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true); assert.equal(childrenOf(tree).length, 1);
  }
  const harness = reviewHarness(), props = { lines: ['A change'], value: base };
  let tree = harness.render(props);
  childrenOf(tree)[0].props.onSubmitCapture({ target: {}, preventDefault() {}, stopPropagation() {} });
  tree = harness.render({ ...props, value: { ...base, caps: { per_day_usd: 3 } } });
  assert.equal(childrenOf(tree).length, 1, 'an edit after review invalidates that review');
  tree = harness.render({ ...props, errors: ['Invalid cap'] });
  childrenOf(tree)[0].props.onSubmitCapture({ preventDefault() { assert.fail('validation was intercepted'); } });
  const html = renderToStaticMarkup(React.createElement(harness.ReviewButton, { type: 'submit' }, 'Save spending limits'));
  assert.match(html, /disabled="".*Save/); assert.match(html, /Nothing to save/);
});

test('save errors stay visible during review and counts from another draft are hidden', () => {
  const harness = reviewHarness(), props = { lines: ['A change'], value: base, saveError: 'Permission denied', replay: { data: { evaluated: 10 }, policy: { ...base, caps: { per_day_usd: 5 } }, run() {} } };
  const tree = harness.render(props);
  childrenOf(tree)[0].props.onSubmitCapture({ target: {}, preventDefault() {}, stopPropagation() {} });
  const section = childrenOf(harness.render(props))[1];
  assert.ok(childrenOf(section).some(element => element.props?.role === 'alert' && element.props.children === 'Permission denied'));
  const result = childrenOf(section).flatMap(element => element.type === React.Fragment ? childrenOf(element) : [element]).find(element => element.type === 'replay-result');
  assert.equal(result.props.replay.data, null);
});

test('review connects the existing editors, replay, docs and search using theme tokens and wrapping', () => {
  assert.match(read('app/agents/Agents.jsx'), /<RulebookReview saved=\{policy\} draft=\{built\} replay=\{replay\}/);
  assert.match(read('components/AgentApprovers.jsx'), /<ApproverReview before=\{data\}/);
  assert.match(read('components/limits/RulebookReview.jsx'), /<ReplayResult/);
  assert.match(read('components/limits/RulebookReview.module.css'), /overflow-wrap: anywhere/);
  assert.doesNotMatch(read('components/limits/RulebookReview.module.css'), /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(read('app/docs/page.jsx'), /<RulebookReviewDocs \/>/);
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["rulebook-review", "Review rulebook changes"\]/);
  assert.equal(TASKS.find(task => task.id === 'rulebook-review').href, '/docs/#rulebook-review');
});
