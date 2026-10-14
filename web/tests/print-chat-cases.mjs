import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { printChatModel, openChatPrint } from '../lib/print-chat.js';
import { editBranch, switchVersion } from '../lib/harness-branches.js';

export function registerPrintChatTests(register) {
const image = 'data:image/png;base64,aGVsbG8=';
const lane = () => ({ modelId: 'model/one', messages: [
  { id: 'u1', role: 'user', text: 'Question', attachments: [{ kind: 'file', name: 'notes.pdf', text: 'file contents' }, { kind: 'image', url: image }] },
  { id: 'a1', role: 'assistant', model: 'model/reply', status: 'done', text: '**Answer**\n```js\nlongLine()\n```', images: [image, 'https://images.invalid/image.png'], reasoning: 'private reasoning', toolCalls: [{ arguments: 'tool arguments' }], usage: { cost: 0.0123 }, receipt: { id: 'receipt-one', payload: { cost: '0.03' }, signature: 'signature' } },
  { id: 't1', role: 'tool', text: 'tool result' },
] });
const find = id => ({ name: id === 'model/reply' ? 'Reply Model' : 'Lane Model' });

register('print projection includes shown text, model per reply, inline images, cost and receipt only', () => {
  const source = lane(), before = structuredClone(source);
  const model = printChatModel({ lanes: [source], chat: { title: 'Chosen title', at: 123 }, find });
  assert.equal(model.title, 'Chosen title');
  assert.equal(model.at, 123);
  assert.equal(model.lanes[0].messages.length, 2);
  assert.deepEqual(model.lanes[0].messages[0].files, ['notes.pdf']);
  assert.deepEqual(model.lanes[0].messages[0].images, [image]);
  const reply = model.lanes[0].messages[1];
  assert.equal(reply.text, source.messages[1].text);
  assert.equal(reply.model, 'Reply Model');
  assert.equal(reply.cost, 0.0123);
  assert.equal(reply.receiptId, 'receipt-one');
  assert.deepEqual(reply.images, [image]);
  assert.equal(reply.omittedImages, 1);
  assert.doesNotMatch(JSON.stringify(model), /private reasoning|tool arguments|tool result|signature|file contents/);
  assert.deepEqual(source, before);
});

register('only the selected branch prints after edits and version switching', () => {
  let id = 0;
  const original = lane();
  const edited = editBranch(original, 'u1', 'Edited question', [], () => `edited-${++id}`).lane;
  edited.messages[1] = { ...edited.messages[1], text: 'Edited answer', status: 'done' };
  const shown = printChatModel({ lanes: [edited] });
  assert.deepEqual(shown.lanes[0].messages.map(message => message.text), ['Edited question', 'Edited answer']);
  assert.doesNotMatch(JSON.stringify(shown), /Question|Answer|receipt-one/);
  const restored = switchVersion(edited, edited.messages[0].id, 'u1');
  assert.deepEqual(printChatModel({ lanes: [restored] }).lanes[0].messages.map(message => message.text), original.messages.slice(0, 2).map(message => message.text));
});

register('compare lanes retain screen ordering rather than interleaving turns', () => {
  const model = printChatModel({ lanes: [lane(), { modelId: 'model/two', messages: [{ role: 'user', text: 'Second lane' }] }, { modelId: 'model/three', messages: [{ role: 'assistant', text: 'Third lane' }] }] });
  assert.deepEqual(model.lanes.map(item => [item.number, item.model]), [[1, 'model/one'], [2, 'model/two'], [3, 'model/three']]);
  assert.equal(model.lanes[1].messages[0].text, 'Second lane');
  assert.equal(model.lanes[2].messages[0].text, 'Third lane');
});

register('missing metadata, stopped replies, image-only replies and invalid costs remain honest', () => {
  const model = printChatModel({ now: 456, lanes: [{ messages: [{ role: 'user', text: 'A title' }, { role: 'assistant', images: [image], status: 'stopped', receipt: { id: 'receipt-two', payload: { cost: '0.05' } } }, { role: 'assistant', status: 'error', usage: { cost: NaN } }, { role: 'assistant', usage: { cost: -1 } }] }] });
  assert.equal(model.title, 'A title');
  assert.equal(model.at, 456);
  const replies = model.lanes[0].messages.slice(1);
  assert.equal(replies[0].status, 'Stopped');
  assert.equal(replies[0].cost, 0.05);
  assert.equal(replies[0].receiptId, 'receipt-two');
  assert.deepEqual(replies[0].images, [image]);
  assert.equal(replies[1].status, 'Reply failed');
  assert.equal(replies[1].cost, null);
  assert.equal(replies[2].cost, null);
  assert.deepEqual(printChatModel().lanes, []);
});

register('print waits for inline images, tolerates decode failure and opens one browser dialog', async () => {
  const order = [], timers = [];
  await openChatPrint({ querySelectorAll: () => [{ decode: async () => { order.push('image'); } }, { decode: async () => { throw Error('unavailable'); } }] }, {
    setTimeout(fn, delay) { timers.push(delay); return 1; }, clearTimeout(timer) { assert.equal(timer, 1); order.push('clear'); }, print() { order.push('print'); },
  });
  assert.deepEqual(order, ['image', 'print', 'clear']);
  assert.deepEqual(timers, [2000]);
});

register('image timeout still prints and print errors clear the wait timer', async () => {
  let printed = 0, cleared = 0;
  await openChatPrint({ querySelectorAll: () => [{ decode: () => new Promise(() => {}) }] }, { setTimeout(fn) { fn(); return 2; }, clearTimeout() { cleared++; }, print() { printed++; } });
  assert.equal(printed, 1);
  await assert.rejects(openChatPrint({ querySelectorAll: () => [] }, { setTimeout() { return 2; }, clearTimeout() { cleared++; }, print() { throw Error('blocked'); } }), /blocked/);
  assert.equal(cleared, 2);
});

register('print integration stays opt-in, uses existing Markdown, light tokens and no app chrome', () => {
  const component = readFileSync(new URL('../components/harness/PrintChat.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../components/harness/PrintChat.module.css', import.meta.url), 'utf8');
  const integration = readFileSync(new URL('../components/harness/PrivateMode.jsx', import.meta.url), 'utf8');
  assert.match(component, /disabled=\{!available \|\| busy \|\| pending\}/);
  assert.match(component, /<Markdown text=\{message.text\}/);
  assert.match(component, /Print \/ Save as PDF/);
  assert.match(integration, /<PrintChat chat=\{current\} lanes=\{lanes\} find=\{find\} busy=\{busy\}/);
  assert.doesNotMatch(component, /fetch\(|localStorage|api\(/);
  assert.match(css, /\.print \{ display: none; \}/);
  assert.match(css, /@media print/);
  assert.match(css, /color-scheme: light/);
  assert.match(css, /background: var\(--qr-paper\)/);
  assert.match(css, /color: var\(--night\)/);
  assert.match(css, /:not\(\[data-chat-print\]\).*display: none !important/);
  assert.match(css, /counter\(page\)/);
  assert.match(css, /\.lane \+ \.lane \{ break-before: page/);
  assert.match(css, /white-space: pre-wrap !important/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\([\d\s.,]+\)/i);
});

}
