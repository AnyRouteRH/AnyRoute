import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as pins from '../lib/message-pins.js';
import { buildRequest, normalizeModel } from '../lib/harness.js';
import { editBranch, regenerateBranch, switchVersion } from '../lib/harness-branches.js';
import { currentChat, exportJson, exportMarkdown, parseImport } from '../lib/harness-history.js';
import { snapshotLanes, restoreLanes } from '../lib/harness-image-history.js';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { contextMeter, summaryRequest, summarySeed } from '../lib/context-meter.js';
import { printChatModel } from '../lib/print-chat.js';

const model = normalizeModel({ id: 'sample/model', context_length: 8192, architecture: { output_modalities: ['text'] }, supported_parameters: ['max_tokens', 'stream', 'tools'] });
const lane = () => ({ id: 'l0', modelId: model.id, messages: [
  { id: 'u1', role: 'user', text: 'Keep this question', attachments: [] },
  { id: 'a1', role: 'assistant', text: 'Keep this answer', status: 'done', model: model.id },
  { id: 'u2', role: 'user', text: 'Later question', attachments: [] },
  { id: 'a2', role: 'assistant', text: 'Later answer', status: 'done', model: model.id },
] });
const pin = (source, ...ids) => ids.reduce(pins.toggleMessagePin, source);
const uid = () => { let id = 0; return () => `version-${++id}`; };
const source = file => readFileSync(new URL(file, import.meta.url), 'utf8');

function components(bindings = {}) {
  const output = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));'], { input: source('../components/harness/MessagePins.jsx'), encoding: 'utf8' });
  const scope = { React, createContext: React.createContext, useContext: () => null, useRef: init => ({ current: init }), useBranchLane: () => 'l0', ...pins, s: new Proxy({}, { get: (_, key) => key }), ...bindings };
  return new Function(...Object.keys(scope), output.replace(/^import .*;\n/gm, '').replace(/export function /g, 'function ') + '\nreturn { MessagePinsProvider, MessagePinMenu, MessagePinsStrip, PrintedPin };')(...Object.values(scope));
}

export function registerMessagePinTests(test) {
  test('pin and unpin either side without changing content, other messages or model requests', () => {
    const original = lane(), before = structuredClone(original), next = pin(original, 'u1', 'a1');
    assert.deepEqual(pins.pinnedMessages(next).map(message => message.id), ['u1', 'a1']);
    assert.deepEqual(original, before);
    assert.equal(next.messages[2], original.messages[2]);
    assert.deepEqual(buildRequest({ model, messages: next.messages }).body, buildRequest({ model, messages: original.messages }).body);
    assert.deepEqual(pin(next, 'u1', 'a1'), original);
    assert.equal(pins.toggleMessagePin(original, 'missing'), original);
    const tool = { ...original, messages: [{ id: 'tool', role: 'tool', text: 'Result' }] };
    assert.equal(pins.toggleMessagePin(tool, 'tool'), tool);
  });

  test('edited versions start unpinned and switching restores pins only for the selected path', () => {
    const original = pin(lane(), 'u1', 'a1'), nextId = uid();
    let edited = editBranch(original, 'u1', 'New question', [], nextId).lane;
    assert.deepEqual(pins.pinnedMessages(edited), []);
    edited = pin(edited, edited.messages[0].id);
    const old = switchVersion(edited, edited.messages[0].id, 'u1');
    assert.deepEqual(pins.pinnedMessages(old).map(message => message.id), ['u1', 'a1']);
    assert.deepEqual(pins.pinnedMessages(switchVersion(old, 'u1', edited.messages[0].id)).map(message => message.id), [edited.messages[0].id]);
    const shared = editBranch(original, 'u2', 'Changed later', [], nextId).lane;
    assert.deepEqual(pins.pinnedMessages(shared).map(message => message.id), ['u1', 'a1']);
  });

  test('regenerating keeps shared pins while old and new reply pins remain independent', () => {
    const original = pin(lane(), 'u1', 'a2');
    let next = regenerateBranch(original, model.id, uid()).lane;
    const newId = next.messages.at(-1).id;
    assert.deepEqual(pins.pinnedMessages(next).map(message => message.id), ['u1']);
    next = pin(next, newId);
    const old = pin(switchVersion(next, newId, 'a2'), 'a2');
    assert.deepEqual(pins.pinnedMessages(old).map(message => message.id), ['u1']);
    assert.deepEqual(pins.pinnedMessages(switchVersion(old, 'a2', newId)).map(message => message.id), ['u1', newId]);
  });

  test('comparison lanes with copied message ids keep independent pins', () => {
    const first = lane(), second = { ...structuredClone(first), id: 'l1' };
    const all = [first, second].map(item => item.id === 'l1' ? pin(item, 'u1') : item);
    assert.equal(pins.pinnedMessages(all[0]).length, 0);
    assert.equal(pins.pinnedMessages(all[1])[0].id, 'u1');
    assert.notEqual(pins.pinAnchor('l0', 'u1'), pins.pinAnchor('l1', 'u1'));
    assert.notEqual(pins.pinAnchor('l0-a', 'b'), pins.pinAnchor('l0', 'a-b'));
    assert.doesNotThrow(() => pins.pinAnchor('l0', '\ud800'));
  });

  test('history snapshots and export/import restore selected and hidden version pins with the same format', () => {
    const original = pin(lane(), 'u1', 'a1'), edited = editBranch(original, 'u1', 'Different version', [], uid()).lane;
    const selectedId = edited.messages[0].id;
    const saved = currentChat([pin(edited, selectedId)], null, 123);
    const doc = JSON.parse(exportJson([saved]));
    assert.equal(doc.version, 1);
    const imported = parseImport(JSON.stringify(doc))[0];
    const restored = restoreLanes(imported.lanes)[0];
    assert.deepEqual(pins.pinnedMessages(restored).map(message => message.id), [selectedId]);
    assert.deepEqual(pins.pinnedMessages(switchVersion(restored, selectedId, 'u1')).map(message => message.id), ['u1', 'a1']);
    assert.match(exportMarkdown([saved]), /Pinned\n\n### You/);
    const old = currentChat([lane()], null, 123);
    assert.ok(!exportJson([old]).includes('"pinned": true'));
    assert.deepEqual(pins.pinnedMessages(restoreLanes(parseImport(exportJson([old]))[0].lanes)[0]), []);
  });

  test('imports reject invalid pin values in shown messages and branch nodes', () => {
    const saved = currentChat([editBranch(pin(lane(), 'u1'), 'u1', 'Edited', [], uid()).lane], null, 123);
    for (const value of ['yes', 1, null, {}, []]) {
      const shown = structuredClone(saved); shown.lanes[0].messages[0].pinned = value;
      assert.throws(() => parseImport(exportJson([shown])), /valid message pins/);
      const hidden = structuredClone(saved); hidden.lanes[0].branches.nodes[0].message.pinned = value;
      assert.throws(() => parseImport(exportJson([hidden])), /valid message pins/);
    }
    const unpinned = structuredClone(saved); unpinned.lanes[0].messages[0].pinned = false;
    assert.equal(parseImport(exportJson([unpinned]))[0].lanes[0].messages[0].pinned, undefined);
  });

  test('pins stay inside encrypted history, survive lock/reopen and import, and can be removed persistently', async () => {
    const storage = memoryStorage(), history = createHistory({ storage, crypto: webcrypto, iterations: 100000 });
    const pass = 'sample message pin passphrase', saved = currentChat([pin(lane(), 'u1', 'a1')], null, 123);
    await history.create(pass); await history.put(saved);
    assert.doesNotMatch(JSON.stringify(await storage.get()), /Keep this question|pinned/);
    history.lock(); assert.throws(() => history.get(saved.id), /locked/);
    const reopened = createHistory({ storage, crypto: webcrypto, iterations: 100000 });
    await reopened.unlock(pass);
    assert.deepEqual(pins.pinnedMessages(restoreLanes(reopened.get(saved.id).lanes)[0]).map(message => message.id), ['u1', 'a1']);
    const imported = createHistory({ storage: memoryStorage(), crypto: webcrypto, iterations: 100000 });
    await imported.create(pass); await imported.importChats(parseImport(exportJson([reopened.get(saved.id)])));
    const restored = pin(restoreLanes(imported.get(saved.id).lanes)[0], 'u1', 'a1');
    await imported.put({ ...saved, lanes: snapshotLanes([restored]) });
    imported.lock(); await imported.unlock(pass);
    assert.deepEqual(pins.pinnedMessages(restoreLanes(imported.get(saved.id).lanes)[0]), []);
  });

  test('pins on empty, attachment-only, image-only and failed messages survive history without saving reasoning or file bodies', () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    const chat = { id: 'l0', modelId: model.id, messages: [
      { id: 'u', role: 'user', text: '', pinned: true, attachments: [{ kind: 'file', name: 'notes.txt', text: 'file body' }] },
      { id: 'a', role: 'assistant', text: 'Partial reply', status: 'error', pinned: true, reasoning: 'private reasoning' },
      { id: 'empty', role: 'assistant', text: '', status: 'stopped', pinned: true },
      { id: 'image', role: 'assistant', text: '', images: [image], status: 'done', pinned: true },
    ] };
    const saved = currentChat([chat], null, 123), parsed = parseImport(exportJson([saved]))[0];
    assert.doesNotMatch(exportJson([saved]), /file body|private reasoning/);
    const restored = restoreLanes(parsed.lanes)[0];
    assert.deepEqual(pins.pinnedMessages(restored).map(message => message.id), ['u', 'a', 'empty', 'image']);
    assert.deepEqual(restored.messages.map(message => message.text), ['', 'Partial reply', '', '']);
    assert.equal(restored.messages[1].status, 'error');
    assert.equal(restored.messages[2].status, 'stopped');
    // The vault restores prepared images; general JSON imports use the existing text allowlist.
    assert.deepEqual(restoreLanes(saved.lanes)[0].messages.at(-1).images, [image]);
  });

  test('summary request keeps pinned turns while omitting older unpinned turns', () => {
    const small = { ...model, context: 1000 };
    const messages = [
      { id: 'old', role: 'user', text: 'x'.repeat(8000) },
      { id: 'old-reply', role: 'assistant', text: 'An old reply' },
      { id: 'pin', role: 'user', text: 'Keep in full', pinned: true },
      { id: 'pin-reply', role: 'assistant', text: 'Keep this turn together' },
      { id: 'recent', role: 'user', text: 'Recent request' },
    ];
    const before = structuredClone(messages), request = summaryRequest(small, messages);
    assert.equal(request.omitted, 2);
    assert.deepEqual(request.body.messages.slice(0, -1).map(message => message.content), messages.slice(2).map(message => message.text));
    assert.deepEqual(messages, before);
    assert.throws(() => summaryRequest(small, [{ id: 'large-pin', role: 'user', text: 'x'.repeat(8000), pinned: true }]), /Pinned messages need more room/);
  });

  test('pinned tool turns stay valid in summary requests, and continued chats do not replay tools', () => {
    const messages = [
      { id: 'u', role: 'user', text: 'Find a detail' },
      { id: 'a', role: 'assistant', text: 'Found it', pinned: true, toolCalls: [{ id: 'call', name: 'lookup', arguments: '{}' }] },
      { id: 't', role: 'tool', name: 'lookup', toolCallId: 'call', text: 'The detail' },
    ];
    const request = summaryRequest(model, messages);
    assert.equal(request.body.messages[1].tool_calls[0].id, 'call');
    assert.equal(request.body.messages[2].tool_call_id, 'call');
    const seed = summarySeed('Continue here', model.id, 'summary-id', { messages });
    assert.equal(seed.messages[1].text, 'Found it');
    assert.equal(seed.messages[1].toolCalls, undefined);
  });

  test('continued chats keep selected pins in full, ignore hidden versions and reset old context baselines', () => {
    const original = pin(lane(), 'u1', 'a1');
    original.messages[0].attachments = [{ kind: 'file', name: 'note.txt', text: 'Important detail' }];
    original.messages[1].contextSystem = ''; original.messages[1].usage = { prompt_tokens: 7000, completion_tokens: 4 };
    const seed = summarySeed('A concise summary', model.id, 'summary-id', original);
    assert.equal(seed.messages.length, 3);
    assert.deepEqual(seed.messages.slice(1).map(message => [message.id, message.text, message.pinned]), original.messages.slice(0, 2).map(message => [message.id, message.text, message.pinned]));
    assert.deepEqual(seed.messages[1].attachments, original.messages[0].attachments);
    assert.equal(seed.messages[2].contextSystem, undefined);
    assert.ok(contextMeter({ model, messages: seed.messages }).tokens < 100);
    const edited = editBranch(original, 'u1', 'New branch', [], uid()).lane;
    assert.equal(summarySeed('Edited summary', model.id, 'new-summary', edited).messages.length, 1);
    assert.equal(summarySeed('No pins', model.id, 'plain').messages.length, 1);
  });

  test('print model and rendered marker mark selected pinned messages only', () => {
    const original = pin(lane(), 'u1', 'a1'), printed = printChatModel({ lanes: [original] });
    assert.deepEqual(printed.lanes[0].messages.map(message => message.pinned === true), [true, true, false, false]);
    const { PrintedPin } = components();
    assert.equal(renderToStaticMarkup(React.createElement(PrintedPin, { pinned: true })), '<p>Pinned</p>');
    assert.equal(renderToStaticMarkup(React.createElement(PrintedPin, { pinned: false })), '');
    assert.match(source('../components/harness/PrintChat.jsx'), /<PrintedPin pinned=\{message.pinned\}/);
    const edited = editBranch(original, 'u1', 'New question', [], uid()).lane;
    assert.ok(printChatModel({ lanes: [edited] }).lanes[0].messages.every(message => !message.pinned));
  });

  test('message menus and the strip support pin, unpin, default empty and disabled busy states', () => {
    let state = [lane()];
    const { MessagePinsProvider } = components();
    const provider = MessagePinsProvider({ lanes: state, setLanes: update => { state = update(state); }, busy: false });
    provider.props.value.toggle('l0', 'u1');
    const { MessagePinMenu, MessagePinsStrip } = components({ useContext: () => ({ ...provider.props.value, lanes: state }) });
    const markup = renderToStaticMarkup(React.createElement(MessagePinMenu, { message: state[0].messages[0] }));
    assert.match(markup, /Your message menu/); assert.match(markup, /Unpin message/);
    assert.match(renderToStaticMarkup(React.createElement(MessagePinsStrip)), /Pinned · 1/);
    provider.props.value.toggle('l0', 'u1');
    assert.equal(renderToStaticMarkup(React.createElement(MessagePinsStrip)), '');
    assert.match(renderToStaticMarkup(React.createElement(MessagePinMenu, { message: state[0].messages[1] })), /Pin message/);
    const busy = MessagePinsProvider({ lanes: state, setLanes: assert.fail, busy: true });
    busy.props.value.toggle('l0', 'a1');
    const disabled = components({ useContext: () => busy.props.value }).MessagePinMenu;
    assert.match(renderToStaticMarkup(React.createElement(disabled, { message: state[0].messages[1] })), /disabled/);
  });

  test('jump scrolls and focuses the message article in its lane, tolerating missing messages', () => {
    const events = [], target = { scrollIntoView: options => events.push(['scroll', options]), focus: options => events.push(['focus', options]) };
    const document = { getElementById: id => { assert.equal(id, pins.pinAnchor('l1', 'a1')); return { closest: selector => { assert.equal(selector, 'article'); return target; } }; } };
    assert.equal(pins.jumpToPinnedMessage(document, 'l1', 'a1'), true);
    assert.equal(target.tabIndex, -1);
    assert.deepEqual(events, [['scroll', { block: 'start' }], ['focus', { preventScroll: true }]]);
    assert.equal(pins.jumpToPinnedMessage({ getElementById: () => null }, 'l1', 'a1'), false);
  });

  test('Chat, summary, docs and search integrate pins with no new endpoint, flag or storage key', () => {
    const harness = source('../components/Harness.jsx');
    assert.match(harness, /<MessagePinsProvider lanes=\{lanes\} setLanes=\{setLanes\} busy=\{busy\}/);
    assert.equal(harness.match(/<MessagePinMenu message=\{msg\}/g).length, 2);
    assert.match(harness, /<MessagePinsStrip \/>/);
    assert.match(source('../components/harness/ContextMeter.jsx'), /summarySeed\(reply.text, model.id, id, lane\)/);
    assert.match(source('../components/PinMessagesDocs.jsx'), /id="pin-messages"/);
    assert.match(source('../app/docs/page.jsx'), /<PinMessagesDocs \/>/);
    assert.match(source('../components/DocsFeatureIndex.jsx'), /sections.push\(\["pin-messages"/);
    assert.match(source('../lib/site-map.js'), /task\('pin-messages'/);
    assert.doesNotMatch(source('../lib/message-pins.js') + source('../components/harness/MessagePins.jsx'), /fetch\(|localStorage|indexedDB|api\(/);
    assert.doesNotMatch(source('../components/harness/MessagePins.module.css'), /#[\da-f]{3,8}\b|rgba?\([\d\s.,]+\)/i);
  });
}
