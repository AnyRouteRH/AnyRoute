import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyChunk, blankReply, buildRequest, defaultSettings, normalizeModel, replyFacts } from '../lib/harness.js';
import { canContinue, continueAnswer, continuationJob, continuationPatcher, CONTINUE_PROMPT, joinContinuation } from '../lib/harness-continue.js';
import { continuationFields } from '../lib/harness-continue-history.js';
import { capDecision, createCapGuard } from '../lib/chat-cap.js';
import { chatCost } from '../lib/chat-cost.js';
import { contextMeter } from '../lib/context-meter.js';
import { folderSystems } from '../lib/folder-instructions.js';
import { snapshotLanes, restoreLanes } from '../lib/harness-image-history.js';
import { currentChat, exportJson, parseImport } from '../lib/harness-history.js';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { regenerateBranch, switchVersion } from '../lib/harness-branches.js';
import { receiptHref } from '../lib/arena.js';

const model = normalizeModel({ id: 'sample/model', context_length: 8192, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['stream', 'max_tokens'], pricing: { prompt: '0.000001', completion: '0.000002' } });
const original = () => ({ id: 'lane', modelId: model.id, messages: [
  { id: 'user', role: 'user', text: 'Explain this', attachments: [] },
  { id: 'answer', role: 'assistant', model: model.id, servedModel: model.id, text: 'First ', finish: 'length', status: 'done', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01 }, receipt: { id: 'receipt-one' } },
] });
const second = (extra = {}) => ({ ...blankReply(), text: 'second.', finish: 'stop', status: 'done', usage: { prompt_tokens: 20, completion_tokens: 3, cost: 0.02 }, receipt: { id: 'receipt-two' }, ...extra });
const options = (overrides = {}) => {
  const calls = [], errors = [];
  const lane = original();
  let lanes = [lane];
  return { lane, messageId: 'answer', busy: false, find: id => id === model.id ? model : null, system: '', settings: defaultSettings(), needKey: () => false, cap: { check: () => true }, setLanes: change => { lanes = change(lanes); }, runLane: (...args) => calls.push(args), onError: error => errors.push(error), onStart() {}, resume() {}, calls, errors, getLanes: () => lanes, ...overrides };
};

test('only length-limited text offers continuation, and the wire requests the same model without internal metadata', () => {
  const lane = original(), reply = lane.messages.at(-1);
  assert.equal(canContinue(reply), true);
  for (const finish of ['stop', 'tool_calls', 'content_filter', null, undefined]) assert.equal(canContinue({ ...reply, finish }), false);
  assert.equal(canContinue({ ...reply, text: '' }), false);
  assert.equal(canContinue({ ...reply, status: 'streaming' }), false);
  const job = continuationJob(lane, reply.id);
  const request = buildRequest({ model, messages: job.history, system: folderSystems('Chat instructions', 'Folder instructions') });
  assert.equal(request.body.model, model.id);
  assert.deepEqual(request.body.messages.map(message => message.content), ['Folder instructions', 'Chat instructions', 'Explain this', 'First ', CONTINUE_PROMPT]);
  assert.equal(request.body.messages.at(-1).continuationOf, undefined);
  assert.deepEqual(lane, original());
  assert.equal(continuationJob({ ...lane, messages: [...lane.messages, { id: 'later', role: 'user', text: 'later' }] }, reply.id), null);
});

test('stream updates join exactly once in the same bubble and add both call costs and usages', () => {
  const lane = original(), base = lane.messages.at(-1), patches = [];
  const patch = continuationPatcher((id, messageId, value) => patches.push({ id, messageId, ...value }), lane, continuationJob(lane, base.id).history, base.id);
  let streamed = applyChunk(blankReply(), { choices: [{ delta: { content: 'sec' } }] });
  patch(lane.id, base.id, { ...streamed, status: 'streaming' });
  streamed = applyChunk(streamed, { choices: [{ delta: { content: 'ond.' }, finish_reason: 'stop' }], usage: second().usage, receipt: second().receipt });
  patch(lane.id, base.id, { ...streamed, status: 'done' });
  const done = { ...base, ...patches.at(-1) };
  assert.equal(patches[0].text, 'First sec');
  assert.equal(done.text, 'First second.');
  assert.equal(done.messageId, base.id);
  assert.equal(replyFacts(done).tokensIn, 30);
  assert.equal(replyFacts(done).tokensOut, 5);
  assert.equal(replyFacts(done).cost, 0.03);
  assert.deepEqual(done.continuationCalls.map(call => call.receiptId), ['receipt-one', 'receipt-two']);
  assert.deepEqual(chatCost([{ ...lane, messages: [lane.messages[0], done] }]), { microUsd: '30000', replies: 1 });
  assert.equal(canContinue(done), false);
});

test('a second length limit can continue again without duplicating earlier text or charges', () => {
  const base = original().messages.at(-1);
  const joined = { ...base, ...joinContinuation(base, second({ finish: 'length' })) };
  assert.equal(canContinue(joined), true);
  const done = { ...joined, ...joinContinuation(joined, second({ text: ' Third.', usage: { cost: 0.04 }, receipt: { id: 'receipt-three' } })) };
  assert.equal(done.text, 'First second. Third.');
  assert.equal(done.continuationCalls.length, 3);
  assert.equal(replyFacts(done).cost, 0.07);
});

test('continuation runs only its lane and keeps its bubble id through the shared transport', () => {
  const opts = options();
  assert.equal(continueAnswer(opts), true);
  assert.equal(opts.calls.length, 1);
  assert.equal(opts.calls[0][0], opts.lane.id);
  assert.equal(opts.calls[0][1], model.id);
  assert.equal(opts.calls[0][3], 'answer');
  assert.equal(opts.getLanes()[0].messages.length, 2);
  assert.equal(opts.getLanes()[0].messages.at(-1).status, 'waiting');
});

test('auth, busy, missing model, unavailable model and full context hold without mutation or a call', () => {
  for (const override of [{ needKey: () => true }, { busy: true }, { find: () => null }, { find: () => ({ ...model, availability: 'temporarily_unavailable' }) }, { find: () => ({ ...model, context: 10 }) }]) {
    const opts = options(override);
    assert.equal(continueAnswer(opts), false);
    assert.equal(opts.calls.length, 0);
    assert.deepEqual(opts.getLanes(), [original()]);
  }
});

test('cap holds the continuation estimate including the cut-off reply; Send anyway resumes once', () => {
  const guard = createCapGuard();
  let pending;
  const opts = options();
  opts.cap = { check: (requests, resume) => guard.check([opts.lane], '10000', requests, resume, value => { pending = value; }) };
  opts.resume = () => continueAnswer(opts);
  assert.equal(continueAnswer(opts), false);
  assert.equal(opts.calls.length, 0);
  assert.deepEqual(opts.getLanes(), [original()]);
  assert.equal(pending.spent, 10000n);
  assert.ok(pending.estimate > 0n);
  guard.sendAnyway(pending.resume);
  assert.equal(opts.calls.length, 1);
  const requests = [{ model, ...buildRequest({ model, messages: continuationJob(original(), 'answer').history }) }];
  assert.equal(capDecision([original()], null, requests).held, false);
});

test('context includes the continuation instruction and avoids summing repeated input usage', () => {
  const lane = original(), base = lane.messages.at(-1);
  const joined = { ...base, ...joinContinuation(base, second()), contextSystem: '' };
  const before = contextMeter({ model, messages: lane.messages });
  const request = contextMeter({ model, messages: continuationJob(lane, base.id).history });
  assert.ok(request.tokens > before.tokens);
  assert.equal(contextMeter({ model, messages: [lane.messages[0], joined] }).tokens, 29);
  const partial = { ...base, ...joinContinuation(base, second({ text: 'x'.repeat(1000), usage: null, receipt: null, status: 'stopped' })) };
  assert.ok(contextMeter({ model, messages: [lane.messages[0], partial] }).tokens >= 250);
});

test('errors and stops preserve text and billed calls, without inventing missing usage', () => {
  const base = original().messages.at(-1);
  for (const status of ['error', 'stopped']) {
    const joined = { ...base, ...joinContinuation(base, second({ text: '', usage: null, receipt: null, finish: null, status, error: 'Stopped' })) };
    assert.equal(joined.text, base.text);
    assert.equal(replyFacts(joined).cost, 0.01);
    assert.equal(chatCost([{ messages: [joined] }]).microUsd, '10000');
    assert.equal(canContinue(joined), true);
    assert.equal(joined.continuationCalls.at(-1).cost, undefined);
  }
});

test('history and exports retain continuation details and joined costs; old history remains valid', async () => {
  const lane = original(), base = lane.messages.at(-1);
  lane.messages[1] = { ...base, ...joinContinuation(base, second({ finish: 'length' })) };
  const chat = currentChat([lane], null, 100);
  const imported = parseImport(exportJson([chat]));
  const restored = restoreLanes(imported[0].lanes);
  assert.equal(restored[0].messages[1].text, 'First second.');
  assert.equal(restored[0].messages[1].finish, 'length');
  assert.equal(restored[0].messages[1].servedModel, model.id);
  assert.deepEqual(restored[0].messages[1].continuationCalls, lane.messages[1].continuationCalls);
  assert.equal(chatCost(restored).microUsd, '30000');
  const storage = memoryStorage(), vault = () => createHistory({ storage, crypto: webcrypto, iterations: 100000 });
  const writer = vault(); await writer.create('sample continuation passphrase'); await writer.put(chat); writer.lock();
  const reader = vault(); await reader.unlock('sample continuation passphrase');
  assert.equal(reader.get(chat.id).lanes[0].messages[1].continuationCalls.length, 2);
  const old = original(); delete old.messages[1].finish; delete old.messages[1].servedModel;
  const oldRestored = restoreLanes(parseImport(exportJson([currentChat([old], null, 101)]))[0].lanes);
  assert.equal(canContinue(oldRestored[0].messages[1]), false);
});

test('continued text stays on the shown branch version and survives reopening both versions', () => {
  const lane = original();
  const job = regenerateBranch(lane, model.id, () => 'new-answer');
  job.lane.messages[1] = { ...lane.messages[1], id: job.reply.id };
  const base = job.lane.messages[1];
  job.lane.messages[1] = { ...base, ...joinContinuation(base, second()) };
  const old = switchVersion(job.lane, job.reply.id, 'answer');
  assert.equal(old.messages[1].text, 'First ');
  const reopened = restoreLanes(snapshotLanes([old]))[0];
  assert.equal(switchVersion(reopened, 'answer', 'new-answer').messages[1].text, 'First second.');
  assert.equal(switchVersion(reopened, 'answer', 'new-answer').messages[1].continuationCalls.length, 2);
});

test('history rejects malformed continuation fields and strips unrelated call data', () => {
  for (const fields of [{ finish: 1 }, { servedModel: {} }, { continuationCalls: [{}] }, { continuationCalls: [{ cost: -1 }, {}] }, { continuationCalls: [{ prompt_tokens: Infinity }, {}] }]) assert.throws(() => continuationFields(fields), /valid answer continuation/);
  assert.deepEqual(continuationFields({ continuationCalls: [{ cost: 1, credentials: 'sample-value' }, { receiptId: 'receipt-two' }] }).continuationCalls, [{ cost: 1 }, { receiptId: 'receipt-two' }]);
});

test('copied compare replies count the original once and each lane’s continuation once, in either order', () => {
  const lane = original(), base = lane.messages[1];
  const continued = { ...base, ...joinContinuation(base, second(), 'call-lane-one') };
  const compared = { ...base, ...joinContinuation(base, second({ usage: { cost: 0.04 }, receipt: null }), 'call-lane-two') };
  const otherLane = message => ({ ...lane, id: 'lane-two', messages: [lane.messages[0], message] });
  for (const lanes of [[lane, otherLane(continued)], [otherLane(continued), lane]]) assert.equal(chatCost(lanes).microUsd, '30000');
  const first = otherLane(continued), other = otherLane(compared);
  for (const lanes of [[first, other], [other, first]]) assert.equal(chatCost(lanes).microUsd, '70000');
  assert.equal(chatCost([first, otherLane(continued)]).microUsd, '30000');
  const reopened = restoreLanes(snapshotLanes([first, other]));
  assert.equal(chatCost(reopened).microUsd, '70000');
});

test('UI renders the note, keyboard button and both receipts; other finish reasons have no button', () => {
  const source = readFileSync(new URL('../components/harness/ContinueAnswer.jsx', import.meta.url), 'utf8');
  const output = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' });
  const scope = { React, createContext: React.createContext, useContext: React.useContext, useBranchLane: () => 'lane', canContinue, receiptHref, s: new Proxy({}, { get: (_, key) => key }) };
  const Component = new Function(...Object.keys(scope), output.replace(/^import .*;\n/gm, '').replace(/export default function /g, 'function ').replace(/export const /g, 'const ') + '\nreturn ContinueAnswer;')(...Object.values(scope));
  const render = (msg, busy = false) => renderToStaticMarkup(React.createElement(Component, { msg, last: true, busy }));
  const base = original().messages.at(-1);
  assert.match(render(base), /This answer was cut off/);
  assert.match(render(base), /<button type="button"[^>]*>Continue<\/button>/);
  assert.match(render(base, true), /disabled=""/);
  for (const finish of ['stop', 'tool_calls', null, undefined]) assert.doesNotMatch(render({ ...base, finish }), /<button/);
  const joined = { ...base, ...joinContinuation(base, second()) };
  assert.match(render(joined), /Call 1 receipt/);
  assert.match(render(joined), /Call 2 receipt/);
});
