import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REPLAY_DAYS, REPLAY_WORDS as W, REPLAY_OUTCOMES, replayActualText, replayBar, replayCompareText, replayExamples, replayHeadline, replayReasonText, replayReasons, replayStale, replayStopText, runReplay } from '../lib/rule-replay.js';

// Replay your rules: the display logic for POST /api/v1/agents/:key_hash/replay in the shared spending limits editor.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const result = {
  window: { from: '2026-09-21T00:00:00.000Z', to: '2026-09-28T00:00:00.000Z', days: 7 },
  evaluated: 7, allowed: 4, denied: 2, asked: 1, stopped_at: '2026-09-22T10:00:20.000Z', stopped_reason: 'breaker:max_requests_per_minute',
  by_reason: { killed: 1, 'breaker:max_requests_per_minute': 1, approval_required: 1 },
  actual: { allowed: 5, denied: 0, asked: 0, not_recorded: 2 }, changed: 3,
  examples: [
    { time: '2026-09-22T10:00:00.000Z', kind: 'call', model: 'alpha/model', lane: 'public', action: null, cost_usd: 0.25, decision: 'allow', reason: null, actual: 'allow' },
    { time: '2026-09-22T10:00:20.000Z', kind: 'call', model: 'alpha/model', lane: null, action: null, cost_usd: 0.25, decision: 'deny', reason: { code: 'breaker:max_requests_per_minute', message: 'The rolling minute request breaker has tripped.' }, actual: 'allow' },
    { time: '2026-09-22T11:00:00.000Z', kind: 'action', model: null, lane: null, action: 'trade.order', cost_usd: 60, decision: 'approval_required', reason: { code: 'approval_action_amount', message: 'This action amount requires owner approval.' }, actual: 'approval_required' },
    { time: '2026-09-22T12:00:00.000Z', kind: 'call', model: 'alpha/model', lane: 'attested', action: null, cost_usd: 1, decision: 'deny', reason: { code: 'killed', message: 'The draft stopped this key earlier in the replay, so every later call is refused.' }, actual: null },
  ],
  truncated: false, notes: ['After the draft stops this key, the replay assumes nobody pressed Resume, so every later call is refused.'],
};

test('the bar has allowed, ask me first and refused, in whole percents that add up to 100', () => {
  assert.deepEqual(REPLAY_OUTCOMES.map(o => [o.key, o.decision, o.label]), [['allowed', 'allow', 'Allowed'], ['asked', 'approval_required', 'Ask me first'], ['denied', 'deny', 'Refused']]);
  assert.deepEqual(replayBar(result).map(s => [s.key, s.count, s.percent]), [['allowed', 4, 57], ['asked', 1, 14], ['denied', 2, 29]]);
  for (const counts of [{ allowed: 1, asked: 1, denied: 1 }, { allowed: 2, asked: 0, denied: 1 }, { allowed: 997, asked: 2, denied: 1 }, { allowed: 0, asked: 0, denied: 5 }]) {
    const bar = replayBar(counts);
    assert.equal(bar.reduce((sum, s) => sum + s.percent, 0), 100, JSON.stringify(counts));
    for (const s of bar) if (!s.count) assert.equal(s.percent, 0); // an empty outcome never takes a remainder
  }
  assert.deepEqual(replayBar({ allowed: 0, asked: 0, denied: 0 }).map(s => s.percent), [0, 0, 0]);
  assert.deepEqual(replayBar(null).map(s => s.count), [0, 0, 0]);
});

test('the counts, the stop and the comparison with what happened read as sentences', () => {
  assert.equal(replayHeadline(result), 'Of 7 recorded calls and actions, 4 would have been allowed, 1 sent to ask me first and 2 refused.');
  assert.equal(replayHeadline({ ...result, evaluated: 1, allowed: 1, denied: 0, asked: 0 }), 'Of 1 recorded call or action, 1 would have been allowed, 0 sent to ask me first and 0 refused.');
  assert.equal(replayHeadline({ evaluated: 0, allowed: 0, denied: 0, asked: 0 }), W.empty);
  assert.equal(replayStopText(result), 'These rules would have stopped this key at 2026-09-22 10:00:20 UTC: Requests per minute breaker reached; the key stops. Every later call is refused until you press Resume.');
  assert.equal(replayStopText({ ...result, stopped_at: undefined }), '');
  assert.match(replayStopText({ ...result, stopped_reason: 'model_not_allowed,lane_not_allowed' }), /: The model is outside the rules\. Every later/);
  assert.equal(replayCompareText(result), '3 calls and actions would have gone differently from what happened. 2 calls ran with no rulebook decision recorded.');
  assert.equal(replayCompareText({ ...result, changed: 0, actual: { not_recorded: 0 } }), 'Every call and action with a recorded decision would have gone the same way.');
  assert.equal(replayCompareText({ ...result, evaluated: 2, changed: 0, actual: { not_recorded: 2 } }), '2 calls ran with no rulebook decision recorded.');
  assert.equal(replayCompareText({ evaluated: 0 }), '');
});

test('reasons are counted most first and named in the editor’s words; Stop never says kill', () => {
  assert.deepEqual(replayReasons({ by_reason: { over_per_hour: 2, model_not_allowed: 5, lane_not_allowed: 2 } }).map(r => [r.code, r.count]), [['model_not_allowed', 5], ['lane_not_allowed', 2], ['over_per_hour', 2]]);
  assert.equal(replayReasonText('over_per_week'), 'Over the cap per week.');
  assert.equal(replayReasonText({ code: 'outside_window', message: 'router words' }), 'Outside the allowed UTC times.');
  assert.equal(replayReasonText('breaker:max_spend_usd_per_minute'), 'Spend per minute (USD) breaker reached; the key stops.');
  assert.equal(replayReasonText({ code: 'something_new', message: 'A new reason from the router.' }), 'A new reason from the router.');
  assert.equal(replayReasonText(null), 'No reason given.');
  for (const code of ['killed', ...Object.keys(result.by_reason), 'actions_not_configured', 'approval_calls_per_hour']) assert.doesNotMatch(replayReasonText(code), /kill/i, code);
});

test('examples show what, where, cost, the replay’s decision and reason, and what happened at the time', () => {
  const rows = replayExamples(result);
  assert.deepEqual(rows.map(r => [r.decision, r.tone, r.changed]), [['Allowed', 'allowed', false], ['Refused', 'denied', true], ['Ask me first', 'asked', false], ['Refused', 'denied', false]]);
  assert.deepEqual(rows[0], { id: '2026-09-22T10:00:00.000Z-0', time: '2026-09-22 10:00:00 UTC', what: 'alpha/model', lane: 'public', cost: '$0.25', decision: 'Allowed', tone: 'allowed', reason: '', actual: 'Allowed at the time', changed: false });
  assert.equal(rows[1].lane, 'Lane not recorded'); assert.equal(rows[1].reason, 'Requests per minute breaker reached; the key stops.');
  assert.deepEqual([rows[2].what, rows[2].lane, rows[2].cost, rows[2].actual], ['Action trade.order', '', '$60.00', 'Sent to ask me first at the time']);
  assert.equal(rows[3].reason, 'Stopped earlier in this replay, so it is refused.'); assert.equal(rows[3].actual, 'No rulebook decision recorded');
  assert.equal(replayActualText({ kind: 'call', actual: 'approval_required' }), 'Ran after an approval');
  assert.equal(replayActualText({ kind: 'action', actual: 'deny' }), 'Refused at the time');
  assert.deepEqual(replayExamples(null), []);
});

test('a replay goes stale when the editor’s rules change after it', () => {
  const policy = { version: 1, models: {}, caps: { per_day_usd: 4 }, on_breach: 'deny' };
  assert.equal(replayStale(null, policy), false);
  assert.equal(replayStale(policy, structuredClone(policy)), false);
  assert.equal(replayStale(policy, { ...policy, caps: { per_day_usd: 5 } }), true);
});

test('runReplay posts the draft for the last 7 days to the key’s replay endpoint and checks the answer', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const policy = { version: 1, models: {}, caps: {}, on_breach: 'deny' };
  const request = async (path, options) => { calls.push([path, options]); return { data: result }; };
  assert.equal(await runReplay(request, 'hash/with space', policy, { signal }), result);
  assert.deepEqual(calls, [['/api/v1/agents/hash%2Fwith%20space/replay', { method: 'POST', body: { policy, days: REPLAY_DAYS }, signal }]]);
  assert.equal(REPLAY_DAYS, 7);
  await runReplay(request, 'h', policy, { days: 2 }); assert.equal(calls[1][1].body.days, 2);
  await assert.rejects(runReplay(request, '', policy), /Choose a key/);
  for (const bad of [{}, { data: null }, { data: { ...result, examples: undefined } }, { data: { ...result, allowed: '4' } }, { data: { ...result, notes: null } }]) {
    await assert.rejects(runReplay(async () => bad, 'h', policy), /could not be read/);
  }
  await assert.rejects(runReplay(async () => { throw new Error('Too many replays from this key. Try again within a minute.'); }, 'h', policy), /Too many replays/);
});

test('Replay last 7 days sits beside Save wherever the editor edits a saved key or agent, and a picked setup offers Replay it first', () => {
  assert.equal(W.button, 'Replay last 7 days'); assert.equal(W.setup, 'Replay it first');
  assert.equal(W.done, 'Replayed against your last 7 days. Nothing was saved.');
  const agents = read('app/agents/Agents.jsx');
  assert.match(agents, /<Button type="submit" disabled=\{busy\}>\{W\.save\}<\/Button><ReplayButton replay=\{replay\}/);
  assert.match(agents, /<SpendingLimits id="rulebook"[^>]* onReplay=\{replaySetup\}>/);
  assert.match(agents, /<ReplayResult id="replay-rules" replay=\{replay\} current=\{built\.policy\}\/>/);
  const key = read('components/limits/KeyLimits.jsx');
  assert.match(key, /<Button type="submit" disabled=\{view\.busy\}>\{W\.save\}<\/Button><ReplayButton replay=\{replay\}/);
  assert.match(key, /<SpendingLimits key=\{revision\}[^>]* onReplay=\{replaySetup\}/);
  assert.match(key, /<ReplayResult id="key-limits-replay"/);
  assert.doesNotMatch(read('components/harness/Limits.jsx'), /Replay|onReplay/); // a chat key is made per tab, not saved
  const setups = read('components/limits/StarterSetups.jsx');
  assert.match(setups, /\{before && onReplay && <ReplayFirst onReplay=\{onReplay\}\/>\}/);
  assert.match(read('components/limits/SpendingLimits.jsx'), /<StarterSetups [^>]*onReplay=\{onReplay\}\/>/);
  const component = read('components/limits/ReplayRules.jsx');
  assert.match(component, /<strong>\{W\.done\}<\/strong>/); assert.match(component, /<details className=\{st\.replayExamples\}>/);
  assert.match(component, /aria-live="polite"/); assert.doesNotMatch(component, /method:|fetch\(/); // only runReplay calls the router
});

test('public wording: replay, Stop, nothing that sounds unreal or like a return', () => {
  const banned = new RegExp(String.raw`\b(?:${['de' + 'mo', 'te' + 'st', 'te' + 'sted', 'mo' + 'ck', 'simu' + 'lated', 'simu' + 'lation', 'place' + 'holder', 'fix' + 'ture', 'lo' + 'cal', 'ki' + 'll', 'ki' + 'lled', 'ea' + 'rn', 'yi' + 'eld', 'A' + 'PY', 'ret' + 'urns', 'pri' + 'vate', 'x4' + '02'].join('|')})\b|no lo` + 'gs', 'i');
  for (const file of ['lib/rule-replay.js', 'components/limits/ReplayRules.jsx']) {
    const copy = read(file).replace(/import[^\n]*\n/g, '').replace(/'killed'|killed:/g, ''); // the router's reason code, shown in words
    assert.doesNotMatch(copy, banned, file);
  }
});
