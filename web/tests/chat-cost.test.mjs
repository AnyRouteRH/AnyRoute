import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatCost, costSummaryFields, formatChatCost, replyCostUnits, restoreChatCost, savedChatCost } from '../lib/chat-cost.js';
import { applyChunk, blankReply } from '../lib/harness.js';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { snapshotLanes, restoreLanes } from '../lib/harness-image-history.js';
import { currentChat, exportJson, parseImport } from '../lib/harness-history.js';

const reply = (id, cost, extra = {}) => ({ id, role: 'assistant', text: 'A reply', status: 'done', usage: { cost }, ...extra });
const lanes = (...messages) => [{ modelId: 'sample-model', messages: [{ id: 'u1', role: 'user', text: 'A question' }, ...messages] }];
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('empty, failed, free and unpriced replies add zero dollars', () => {
  assert.deepEqual(chatCost(), { microUsd: '0', replies: 0 });
  const total = chatCost(lanes(reply('a', 1, { status: 'error' }), reply('b', 0), reply('c', undefined)));
  assert.deepEqual(total, { microUsd: '0', replies: 3 });
  assert.equal(formatChatCost(total), '$0 · 3 replies');
});

test('sums exactly the footer amounts with integer arithmetic and keeps all significant digits', () => {
  // A >= 1 cent reply footer rounds to four places; smaller replies round to six.
  const total = chatCost(lanes(reply('a', 0.012345), reply('b', 0.0000006), reply('c', 0.0000004)));
  assert.deepEqual(total, { microUsd: '12301', replies: 3 });
  assert.equal(formatChatCost(total), '$0.012301 · 3 replies');
  assert.equal(formatChatCost(chatCost(lanes(reply('a', 0.1), reply('b', 0.2)))), '$0.3000 · 2 replies');
  assert.equal(formatChatCost(chatCost(lanes(reply('a', 0.0123)))), '$0.0123 · 1 reply');
  assert.equal(formatChatCost(chatCost(lanes(reply('a', 0.000001)))), '$0.000001 · 1 reply');
});

test('many tiny replies do not drift, and large integer totals remain exact', () => {
  assert.equal(chatCost(lanes(...Array.from({ length: 10000 }, (_, i) => reply(String(i), 0.000001)))).microUsd, '10000');
  assert.equal(formatChatCost({ microUsd: '9007199254740993', replies: 14 }), '$9007199254.740993 · 14 replies');
});

test('receipt fallback matches reply facts, usage wins, stopped charges count, invalid costs add zero', () => {
  assert.equal(replyCostUnits(reply('a', undefined, { receipt: { payload: { cost: '0.000123' } } })), 123n);
  assert.equal(replyCostUnits(reply('a', 0, { receipt: { payload: { cost: '1' } } })), 0n);
  assert.equal(replyCostUnits(reply('a', 0.00012, { status: 'stopped' })), 120n);
  for (const cost of [NaN, Infinity, -1, 1e21]) assert.equal(replyCostUnits(reply('a', cost)), 0n);
});

test('stream updates replace a reply cost rather than accumulating it again', () => {
  let message = { ...reply('a', undefined), ...blankReply(), status: 'streaming' };
  assert.deepEqual(chatCost(lanes(message)), { microUsd: '0', replies: 1 });
  message = { ...message, ...applyChunk(message, { usage: { cost: 0.001 } }) };
  assert.deepEqual(chatCost(lanes(message)), { microUsd: '1000', replies: 1 });
  message = { ...message, ...applyChunk(message, { usage: { cost: 0.002 } }), status: 'done' };
  assert.deepEqual(chatCost(lanes(message)), { microUsd: '2000', replies: 1 });
});

test('all model lanes count, copied earlier replies count once, tool and user messages do not', () => {
  const one = lanes(reply('a', 0.001), { role: 'tool', text: 'tool output', usage: { cost: 2 } });
  one.push({ modelId: 'sample-second-model', messages: [structuredClone(one[0].messages[1]), reply('b', 0.002), reply('c', 5, { status: 'error' })] });
  assert.deepEqual(chatCost(one), { microUsd: '3000', replies: 3 });
});

test('saved summary restores omitted reply accounting across lanes and survives new replies', () => {
  const live = lanes(reply('a', 0.001), reply('b', 4, { status: 'error' }), reply('c', 0.002, { text: '' }), reply('d', undefined, { receipt: { payload: { cost: '0.003' } } }));
  const chat = { id: 'chat-one', lanes: snapshotLanes(live), costSummary: chatCost(live) };
  const restored = restoreChatCost(chat, restoreLanes(chat.lanes));
  assert.deepEqual(chatCost(restored), chat.costSummary);
  restored.push({ ...restored[0], id: 'another-lane', messages: [...restored[0].messages, reply('e', 0.004)] });
  assert.deepEqual(chatCost(restored), { microUsd: '10000', replies: 5 });
  restored[0].messages.push(reply('f', 0.005));
  assert.deepEqual(chatCost(restored), { microUsd: '15000', replies: 6 });
});

test('older saved chats derive totals from retained replies without a schema migration', () => {
  const chat = { id: 'older-chat', lanes: lanes(reply('a', 0.001)) };
  assert.deepEqual(savedChatCost(chat), { microUsd: '1000', replies: 1 });
  assert.deepEqual(chatCost(restoreChatCost(chat, restoreLanes(snapshotLanes(chat.lanes)))), savedChatCost(chat));
});

test('summary is encrypted in the existing vault, survives reload, rename and pin, and locked reads stay guarded', async () => {
  const storage = memoryStorage();
  const history = createHistory({ storage, crypto: webcrypto, iterations: 100000 });
  const live = lanes(reply('a', 0.0123), reply('b', 0, { status: 'error' }));
  const chat = { id: 'cost-chat', title: 'Cost chat', lanes: snapshotLanes(live), costSummary: chatCost(live) };
  await history.create('sample history passphrase');
  await history.put(chat);
  await history.edit(chat.id, { title: 'Renamed chat', pinned: true });
  assert.deepEqual(history.get(chat.id).costSummary, chat.costSummary);
  assert.deepEqual(Object.keys(await storage.get()).sort(), ['ct', 'iterations', 'iv', 'kdf', 'salt', 'v']);
  assert.ok(!JSON.stringify(await storage.get()).includes('costSummary'));
  history.lock();
  assert.deepEqual(history.list(), []);
  assert.throws(() => history.get(chat.id), { code: 'locked' });
  const reloaded = createHistory({ storage, crypto: webcrypto, iterations: 100000 });
  await reloaded.unlock('sample history passphrase');
  assert.deepEqual(reloaded.get(chat.id).costSummary, chat.costSummary);
  await reloaded.forget();
  assert.equal(await storage.get(), null);
});

test('export/import retains valid totals and strips unrecognized summary fields', () => {
  const current = currentChat(lanes(reply('a', 0.0123), reply('b', 0, { status: 'error' })), null, 1000);
  const imported = parseImport(exportJson([current]))[0];
  assert.deepEqual(imported.costSummary, current.costSummary);
  assert.deepEqual(costSummaryFields({ costSummary: { ...current.costSummary, credential: 'removed' } }), { costSummary: current.costSummary });
  for (const costSummary of [{ microUsd: '-1', replies: 1 }, { microUsd: '1.1', replies: 1 }, { microUsd: '0', replies: -1 }, { microUsd: '0', replies: 1.5 }, { microUsd: '0', replies: Infinity }]) {
    assert.throws(() => parseImport(exportJson([{ ...current, costSummary }])));
  }
});

test('header and saved rows render the same total, with a live accessible header', () => {
  const source = read('components/harness/ChatCost.jsx');
  const transpiled = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' });
  const Component = new Function('React', 'chatCost', 'formatChatCost', 'savedChatCost', 's', transpiled.replace(/^import .*;\n/gm, '').replace('export default function', 'function') + '\nreturn ChatCost;')({ createElement }, chatCost, formatChatCost, savedChatCost, { total: 'total' });
  const live = lanes(reply('a', 0.0123));
  const header = renderToStaticMarkup(createElement(Component, { lanes: live }));
  const row = renderToStaticMarkup(createElement(Component, { chat: { costSummary: chatCost(live) } }));
  for (const html of [header, row]) assert.ok(html.includes('This chat: $0.0123 · 1 reply'));
  assert.match(header, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.ok(!row.includes('role="status"'));
  assert.ok(read('components/Harness.jsx').includes('<ChatCost lanes={lanes} />'));
  assert.ok(read('components/harness/HistoryTools.jsx').includes('<ChatCost chat={chat} />'));
});

test('new-chat clears saved accounting; feature adds no network calls, storage key, flag or auth changes', () => {
  const harness = read('components/Harness.jsx');
  assert.match(harness, /const newChat = \(\) => \{\s*setLanes\(ls => ls.map\(\(\{ chatCostRemainder, \.\.\.lane \}\) => lane\)\)/);
  assert.doesNotMatch(read('lib/chat-cost.js'), /fetch\(|localStorage|sessionStorage|indexedDB|api\(/);
  assert.deepEqual(chatCost(lanes()), { microUsd: '0', replies: 0 });
});

test('docs, feature index, site search and browser inventory describe the feature', () => {
  assert.ok(read('components/ChatCostDocs.jsx').includes('id="chat-cost"'));
  assert.ok(read('app/docs/page.jsx').includes('<ChatCostDocs />'));
  assert.ok(read('components/DocsFeatureIndex.jsx').includes('["chat-cost", "This chat’s cost"]'));
  assert.ok(read('lib/site-map.js').includes("task('chat-cost', 'chat'"));
  const inventory = JSON.parse(read('app/keep/inventory.generated.json'));
  assert.ok(inventory.outside_postgres.browser.items.some(item => item.holds.includes('costSummary') && item.holds.includes('encrypted')));
});
