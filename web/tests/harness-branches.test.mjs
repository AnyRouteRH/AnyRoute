import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { editBranch, messageVersions, regenerateBranch, switchVersion } from '../lib/harness-branches.js';
import { resendEdit, resendReply } from '../lib/harness-branch-actions.js';
import { snapshotLanes, restoreLanes } from '../lib/harness-image-history.js';
import { currentChat, exportJson, exportMarkdown, mergeImport, parseImport } from '../lib/harness-history.js';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { parseFolderImport } from '../lib/chat-folders.js';
import { answerFromReply } from '../lib/saved-answers.js';
import { chatCost, restoreChatCost } from '../lib/chat-cost.js';
import { contextMeter } from '../lib/context-meter.js';
import { buildRequest, normalizeModel } from '../lib/harness.js';

const model = normalizeModel({ id: 'model/one', name: 'Model One', context_length: 8192, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } });
const original = () => ({ id: 'l0', modelId: model.id, messages: [
  { id: 'u1', role: 'user', text: 'Original question', attachments: [] },
  { id: 'a1', role: 'assistant', model: model.id, text: 'Original answer', status: 'done', usage: { cost: 0.01 } },
  { id: 'u2', role: 'user', text: 'Later question', attachments: [] },
  { id: 'a2', role: 'assistant', model: model.id, text: 'Later answer', status: 'done', usage: { cost: 0.02 } },
] });
const uid = () => { let n = 0; return () => 'new-' + ++n; };
const finish = (lane, text = 'Edited answer', cost = 0.04) => ({ ...lane, messages: lane.messages.map((m, i) => i === lane.messages.length - 1 ? { ...m, text, status: 'done', usage: { cost } } : m) });
const edit = (lane = original(), id = 'u1', text = 'Edited question', nextId = uid()) => finish(editBranch(lane, id, text, [], nextId).lane);
const vault = storage => createHistory({ storage, crypto: webcrypto, iterations: 100000 });
const pass = 'sample branch passphrase';

test('editing an earlier user message creates a branch and retains the entire original suffix', () => {
  const lane = original(), before = structuredClone(lane), nextId = uid();
  const job = editBranch(lane, 'u1', 'Edited question', [], nextId);
  assert.deepEqual(lane, before);
  assert.deepEqual(job.history.map(m => m.text), ['Edited question']);
  assert.deepEqual(messageVersions(job.lane, job.history[0].id), { ids: ['u1', job.history[0].id], index: 1 });
  const restored = switchVersion(finish(job.lane), job.history[0].id, 'u1');
  assert.deepEqual(restored.messages, before.messages);
  assert.equal(editBranch(lane, 'a1', 'Wrong role', [], nextId), null);
});

test('three versions and nested edits restore each version’s later messages and latest continuation', () => {
  const nextId = uid(), first = edit(original(), 'u1', 'Second', nextId);
  const secondId = first.messages[0].id;
  const continued = { ...first, messages: [...first.messages, { id: 'u3', role: 'user', text: 'Continue second', attachments: [] }, { id: 'a3', role: 'assistant', text: 'Second continuation', status: 'done', usage: { cost: 0.03 } }] };
  const third = edit(continued, secondId, 'Third', nextId);
  assert.equal(messageVersions(third, third.messages[0].id).ids.length, 3);
  const second = switchVersion(third, third.messages[0].id, secondId);
  assert.deepEqual(second.messages, continued.messages);
  const nested = edit(second, 'u3', 'Nested edit', nextId);
  const old = switchVersion(nested, secondId, 'u1');
  assert.deepEqual(old.messages, original().messages);
  const reopened = switchVersion(old, 'u1', secondId);
  assert.equal(reopened.messages.at(-2).text, 'Nested edit');
  assert.equal(switchVersion(reopened, reopened.messages.at(-2).id, 'u3').messages.at(-1).text, 'Second continuation');
  assert.equal(switchVersion(old, 'u1', 'missing'), old);
});

test('regeneration creates assistant versions, keeps the preceding request, and preserves later continuations', () => {
  const nextId = uid(), lane = original(), job = regenerateBranch(lane, model.id, nextId);
  assert.deepEqual(job.history, lane.messages.slice(0, -1));
  const next = finish(job.lane, 'Regenerated answer');
  assert.deepEqual(messageVersions(next, job.reply.id), { ids: ['a2', job.reply.id], index: 1 });
  const continued = { ...next, messages: [...next.messages, { id: 'u3', role: 'user', text: 'After regeneration', attachments: [] }] };
  const old = switchVersion(continued, job.reply.id, 'a2');
  assert.deepEqual(old.messages, lane.messages);
  assert.deepEqual(switchVersion(old, 'a2', job.reply.id).messages, continued.messages);
});

test('only the selected path is sent, metered and counted in cost; switching performs no request', () => {
  const next = edit(), firstId = next.messages[0].id;
  assert.deepEqual(buildRequest({ model, messages: next.messages }).body.messages.map(m => m.content), ['Edited question', 'Edited answer']);
  assert.deepEqual(chatCost([next]), { microUsd: '40000', replies: 1 });
  assert.equal(contextMeter({ model, messages: next.messages }).tokens, 20);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Switch must not send'); };
  try {
    const old = switchVersion(next, firstId, 'u1');
    assert.deepEqual(buildRequest({ model, messages: old.messages }).body.messages.map(m => m.content), original().messages.map(m => m.text));
    assert.deepEqual(chatCost([old]), { microUsd: '30000', replies: 2 });
    assert.equal(contextMeter({ model, messages: old.messages }).tokens > contextMeter({ model, messages: next.messages }).tokens, true);
  } finally { globalThis.fetch = previousFetch; }
});

test('branch actions require sign-in and preserve context/image guards before changing anything', () => {
  const lane = original(), events = [];
  const options = { lanes: [lane], messageId: 'u1', text: 'Changed', attachments: [], uid: uid(), find: () => model, system: '', setLanes: () => events.push('set'), runLane: () => events.push('run'), onSaved: () => events.push('saved'), onError: error => events.push(error), needKey: () => true };
  resendEdit(options); assert.deepEqual(events, []);
  resendEdit({ ...options, needKey: () => false, find: () => ({ ...model, context: 1 }) });
  assert.match(events.pop(), /Context is full/); assert.deepEqual(events, []);
  resendEdit({ ...options, needKey: () => false, attachments: [{ kind: 'image', url: 'data:image/jpeg;base64,AA==' }], find: () => ({ ...model, inputs: ['text'], capabilities: { vision: false } }) });
  assert.match(events.pop(), /does not accept image input/); assert.deepEqual(events, []);
  resendEdit({ ...options, needKey: () => false });
  assert.deepEqual(events, ['set', 'saved', 'run']);
});

test('editing copied message ids in Compare changes only the chosen lane and streams its selected prefix', () => {
  const lanes = [original(), { ...original(), id: 'l1' }], calls = [];
  let next;
  resendEdit({ lanes, laneId: 'l1', messageId: 'u2', text: 'Changed second lane', attachments: [], uid: uid(), find: () => model, system: '', needKey: () => false, onError: assert.fail, onSaved: () => {}, setLanes: value => { next = value; }, runLane: (...args) => calls.push(args) });
  assert.equal(next[0], lanes[0]); assert.equal(next[1].messages.at(-2).text, 'Changed second lane');
  assert.equal(calls[0][0], 'l1'); assert.deepEqual(calls[0][2].map(m => m.text), ['Original question', 'Original answer', 'Changed second lane']);
});

test('regeneration action reuses the stream callback and image mode with no alternate request path', () => {
  const lane = original(); lane.messages.at(-1).imageMode = true;
  const calls = []; let lanes = [lane];
  resendReply({ lane, modelId: model.id, uid: uid(), setLanes: fn => { lanes = fn(lanes); }, runLane: (...args) => calls.push(args) });
  assert.equal(calls.length, 1); assert.equal(calls[0][4], true);
  assert.deepEqual(calls[0][2], lane.messages.slice(0, -1));
  assert.equal(messageVersions(lanes[0], calls[0][3]).ids.length, 2);
});

test('encrypted history round-trip keeps branches with folders, prompts, saved answers and branch costs', async () => {
  const lane = edit(), storage = memoryStorage(), history = vault(storage);
  assert.equal(history.unlocked, false); assert.equal(await storage.get(), null);
  const chat = currentChat([lane], { id: 'chat', title: 'Version notes' }, 1000);
  await assert.rejects(history.put(chat), /locked/);
  await history.create(pass); await history.put(chat); await history.createFolder('Work');
  await history.moveChat('chat', history.listFolders()[0].id);
  const answerLane = original(), answer = answerFromReply(answerLane, answerLane.messages[1], 'chat');
  await history.saveAnswer(answer); await history.replacePrompts([]);
  const record = JSON.stringify(await storage.get());
  for (const text of ['Original question', 'Edited question', 'branches', 'Work']) assert.equal(record.includes(text), false);
  history.lock(); await history.unlock(pass);
  const kept = history.get('chat'), restored = restoreChatCost(kept, restoreLanes(kept.lanes));
  assert.equal(kept.folderId, history.listFolders()[0].id); assert.deepEqual(history.listSavedAnswers(), [answer]);
  const old = switchVersion(restored[0], restored[0].messages[0].id, 'u1');
  assert.deepEqual(old.messages.map(m => m.text), original().messages.map(m => m.text));
  assert.deepEqual(chatCost([old]), { microUsd: '30000', replies: 2 });
  assert.deepEqual(chatCost(restored), { microUsd: '40000', replies: 1 });
});

test('JSON export/import preserves all versions and metadata in the single existing format', async () => {
  const lane = edit(), chat = { ...currentChat([lane], { id: 'chat', title: 'Versions' }, 1000), folderId: 'folder' };
  const answerLane = original(), savedAnswer = answerFromReply(answerLane, answerLane.messages[1], chat.id, 1000);
  const source = exportJson([chat], { folders: [{ id: 'folder', name: 'Work' }], savedAnswers: [savedAnswer] });
  const envelope = JSON.parse(source); assert.equal(envelope.version, 1); assert.equal(envelope.format, 'anyroute-harness-history');
  assert.equal(envelope.chats[0].lanes[0].messages[0].text, 'Edited question');
  assert.equal(envelope.chats[0].lanes[0].branches.nodes[0].message.text, 'Original question');
  const incoming = parseFolderImport(source), history = vault(memoryStorage());
  await history.create(pass); await history.importFolderHistory(incoming);
  const restored = restoreLanes(history.get(chat.id).lanes)[0];
  assert.equal(messageVersions(restored, restored.messages[0].id).ids.length, 2);
  assert.equal(switchVersion(restored, restored.messages[0].id, 'u1').messages.at(-1).text, 'Later answer');
  assert.deepEqual(history.listSavedAnswers(), [savedAnswer]); assert.equal(history.listFolders()[0].name, 'Work');
  const markdown = exportMarkdown([chat]); assert.equal(markdown.includes('Edited answer'), true); assert.equal(markdown.includes('Original answer'), false);
});

test('old-format exports and vaults load without branch controls and can then be edited', async () => {
  const chat = { id: 'old', title: 'Older chat', at: 1, lanes: [{ modelId: model.id, messages: original().messages.map(({ attachments, status, ...message }) => message) }] };
  const old = parseImport(exportJson([chat]))[0], storage = memoryStorage(), history = vault(storage);
  await history.create(pass); await history.put(old); history.lock(); await history.unlock(pass);
  const lane = restoreLanes(history.get('old').lanes)[0];
  assert.equal(lane.branches, undefined); assert.equal(messageVersions(lane, 'u1'), null);
  assert.equal(messageVersions(edit(lane), 'new-1').ids.length, 2);
});

test('regenerated tool turns, errors, image inputs and image-only outputs round-trip without credentials or reasoning', () => {
  const lane = original();
  lane.messages[0].attachments = [{ id: 'image', kind: 'image', name: 'image.jpg', url: 'data:image/jpeg;base64,AA==', size: 1, width: 1, height: 1 }];
  lane.messages[1].toolCalls = [{ id: 'call', name: 'lookup', arguments: '{}' }];
  lane.messages.splice(2, 0, { id: 'tool', role: 'tool', name: 'lookup', toolCallId: 'call', text: 'Tool result' });
  lane.messages.at(-1).images = ['data:image/png;base64,AA==']; lane.messages.at(-1).text = ''; lane.messages.at(-1).imageMode = true;
  lane.messages.at(-1).status = 'error'; lane.messages.at(-1).error = 'Request stopped'; lane.messages.at(-1).apiKey = 'excluded-key'; lane.messages.at(-1).reasoning = 'excluded-reasoning';
  const edited = edit(lane), chat = currentChat([edited], { id: 'chat', title: 'Images' }, 1000), source = exportJson([chat]);
  assert.equal(source.includes('excluded-'), false);
  const selected = restoreLanes(parseImport(source)[0].lanes)[0], old = switchVersion(selected, selected.messages[0].id, 'u1');
  assert.equal(old.messages[0].attachments[0].url, lane.messages[0].attachments[0].url);
  assert.deepEqual(old.messages[1].toolCalls, lane.messages[1].toolCalls); assert.equal(old.messages[2].role, 'tool');
  assert.equal(old.messages.at(-1).status, 'error'); assert.deepEqual(old.messages.at(-1).images, lane.messages.at(-1).images);
  const resnapshot = restoreLanes(JSON.parse(JSON.stringify(snapshotLanes([old]))))[0];
  assert.deepEqual(resnapshot.messages, old.messages);
});

test('imports reject invalid graphs, duplicate selections and invalid message fields; extra fields are stripped', () => {
  const chat = currentChat([edit()], { id: 'chat', title: 'Versions' }, 1000);
  const mutate = fn => { const copy = JSON.parse(exportJson([chat])); fn(copy.chats[0].lanes[0].branches); return JSON.stringify(copy); };
  for (const fn of [
    b => b.nodes[0].parent = b.nodes.at(-1).message.id,
    b => b.nodes[1].message.id = b.nodes[0].message.id,
    b => b.selected.push(b.selected[0]),
    b => b.selected.push(b.nodes[0].message.id),
    b => b.nodes[0].message.text = {},
    b => b.nodes[1].message.usage.cost = -1,
    b => b.nodes[1].message.status = 'unknown',
    b => b.selected.push('missing'),
    b => b.selected = [],
  ]) assert.throws(() => parseImport(mutate(fn)));
  const parsed = parseImport(mutate(b => { b.nodes[0].message.apiKey = 'excluded-key'; b.nodes[1].message.reasoning = 'excluded-reasoning'; }));
  assert.equal(JSON.stringify(parsed).includes('excluded-'), false);
});

test('import dedupe does not drop distinct branches that happen to show the same selected conversation', () => {
  const first = currentChat([edit()], { id: 'first', title: 'Versions' }, 1000);
  const second = structuredClone(first); second.id = 'second'; second.lanes[0].branches.nodes[0].message.text = 'Different hidden version';
  assert.equal(mergeImport([first], [second]).additions.length, 1);
});

test('keyboard version controls and compact touch targets are wired beside messages; docs and inventory cover retention', () => {
  const component = readFileSync(new URL('../components/harness/Branches.jsx', import.meta.url), 'utf8');
  assert.equal((component.match(/type="button"/g) || []).length, 2);
  for (const label of ['Previous message version', 'Next message version', 'Message versions']) assert.equal(component.includes(label), true);
  assert.match(component, /disabled=\{branch.busy/); assert.match(component, /aria-live="polite"/);
  const css = readFileSync(new URL('../components/harness/Branches.module.css', import.meta.url), 'utf8');
  assert.match(css, /min-width:44px;min-height:44px/); assert.match(css, /max-width:100%/); assert.match(css, /focus-visible/);
  const harness = readFileSync(new URL('../components/Harness.jsx', import.meta.url), 'utf8');
  assert.equal((harness.match(/<BranchVersions messageId=\{msg.id\}/g) || []).length, 2);
  assert.match(harness, /if \(busy \|\| needKey\("send"\)\) return;/);
  const docs = readFileSync(new URL('../components/EditAndBranchDocs.jsx', import.meta.url), 'utf8');
  assert.match(docs, /id="edit-and-branch"/); assert.match(docs, /switching versions does not refund/);
  assert.match(readFileSync(new URL('../../src/privacy/chat-branches.ts', import.meta.url), 'utf8'), /router reads ordinary inference requests in memory/);
});
