import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createElement, createContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAT_CAP_PREFS, capDecision, capDollars, capFields, capRequest, capSendRequests, capSummaryRequests, createCapGuard, estimateCapRequests, parseCap, readDefaultCap, restoreChatCap, writeDefaultCap } from '../lib/chat-cap.js';
import { defaultSettings, normalizeModel } from '../lib/harness.js';
import { currentChat, exportJson, exportMarkdown, parseImport } from '../lib/harness-history.js';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { restoreLanes } from '../lib/harness-image-history.js';
import { savedEntry } from '../lib/harness-history-vault.js';

const model = normalizeModel({ id: 'sample-model', context_length: 32000, supported_parameters: ['max_tokens'], pricing: { prompt: '0.001', completion: '0.001', request: '0.1' } });
const settings = defaultSettings();
const lanes = (spent = 1.5) => [{ id: 'l0', modelId: model.id, spendingCap: parseCap('2'), messages: [{ id: 'u', role: 'user', text: 'Hi' }, { id: 'a', role: 'assistant', status: 'done', text: 'Hello', usage: { cost: spent } }] }];
const requests = () => capSendRequests(lanes(), () => model, '', settings, 'Next', [], null);
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('presets and custom caps use exact micro-dollar arithmetic and reject invalid amounts', () => {
  for (const value of ['0.50', '1', '2', '5', '2.345678']) assert.equal(capDollars(parseCap(value)), String(Number(value)));
  assert.equal(parseCap('0.000001'), '1');
  assert.equal(capDollars('0'), '0');
  for (const value of ['', '0', '-2', 'Infinity', 'NaN', '1e2', '0.0000001', '1000000000', {}, null]) assert.throws(() => parseCap(value));
});
test('spent plus input, expected output and request fee holds before the cap', () => {
  const estimate = estimateCapRequests(requests());
  assert.ok(estimate > 600000n);
  const result = capDecision(lanes(), parseCap('2'), requests());
  assert.equal(result.held, true);
  assert.equal(result.projected, result.spent + estimate);
  assert.equal(capDecision(lanes(0), parseCap('2'), requests()).held, false);
  assert.equal(capDecision(lanes(), null, requests()).held, false);
});
test('token limit, system and previous conversation enter the estimate; comparisons sum lanes', () => {
  const low = capRequest(model, [{ role: 'user', text: 'Hi' }], '', { ...settings, maxTokens: 1 });
  const high = capRequest(model, [{ role: 'user', text: 'Longer message' }], 'A system prompt', { ...settings, maxTokens: 100 });
  assert.ok(estimateCapRequests([high]) > estimateCapRequests([low]));
  assert.equal(estimateCapRequests([high, low]), estimateCapRequests([high]) + estimateCapRequests([low]));
  assert.ok(estimateCapRequests(requests()) > estimateCapRequests([capRequest(model, [{ role: 'user', text: 'Next' }], '', settings)]));
});
test('editing estimates only retained context but includes all prior displayed spending', () => {
  const live = lanes();
  const editing = capSendRequests(live, () => model, '', settings, 'Edit', [], 0);
  assert.equal(editing[0].body.messages.length, 1);
  assert.equal(capDecision(live, parseCap('2'), editing).spent, 1500000n);
  assert.equal(capDecision(live, parseCap('2'), editing).held, true);
});
test('equality sends, rounding is upward, and unavailable prices hold only with a cap', () => {
  const tiny = { model: { inPrice: 0, outPrice: 0, requestPrice: 0.00000001 }, body: { messages: [], max_tokens: 0 } };
  assert.equal(estimateCapRequests([tiny]), 1n);
  assert.equal(capDecision(lanes(0), '1', [tiny]).held, false);
  const unknown = { model: { inPrice: 0, outPrice: 0 }, body: { messages: [] } };
  assert.equal(capDecision(lanes(), parseCap('2'), [unknown]).held, true);
  assert.equal(capDecision(lanes(), null, [unknown]).held, false);
});
test('hold leaves the action untouched, raising permits it, and Send anyway bypasses only once', () => {
  const guard = createCapGuard(); let held, sends = 0, cap = parseCap('2');
  const send = () => { if (guard.check(lanes(), cap, requests(), send, result => { held = result; })) sends++; };
  send(); assert.equal(sends, 0); assert.equal(held.cap, cap);
  guard.sendAnyway(held.resume); assert.equal(sends, 1);
  send(); assert.equal(sends, 1);
  cap = parseCap('5'); send(); assert.equal(sends, 2);
  assert.throws(() => guard.sendAnyway(() => { throw new Error('request failed'); }));
  cap = parseCap('2'); send(); assert.equal(sends, 2);
});
test('default uses the existing preferences, preserves unrelated fields, handles denied storage', () => {
  let value = JSON.stringify({ model: 'sample-model', sort: 'price' });
  const storage = { getItem: key => { assert.equal(key, CHAT_CAP_PREFS); return value; }, setItem: (key, next) => { assert.equal(key, CHAT_CAP_PREFS); value = next; } };
  assert.equal(readDefaultCap(storage), null);
  assert.equal(writeDefaultCap(storage, parseCap('2')), true);
  assert.equal(readDefaultCap(storage), parseCap('2'));
  assert.deepEqual(JSON.parse(value), { model: 'sample-model', sort: 'price', defaultChatCap: '2000000' });
  writeDefaultCap(storage, null); assert.equal(readDefaultCap(storage), null);
  value = '{'; assert.equal(readDefaultCap(storage), null); assert.equal(writeDefaultCap(storage, '1000000'), true);
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.equal(readDefaultCap(denied), null); assert.equal(writeDefaultCap(denied, '1000000'), false);
});
// Run the hook's state/effect contract without introducing a DOM or a new dependency.
function capSession(storage) {
  let cursor = 0, dirty = false, effects = [];
  const cells = [], deps = [];
  const state = initial => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = initial;
    return [cells[index], next => {
      const value = typeof next === 'function' ? next(cells[index]) : next;
      if (!Object.is(cells[index], value)) { cells[index] = value; dirty = true; }
    }];
  };
  const ref = initial => { const index = cursor++; return cells[index] ??= { current: initial }; };
  const effect = (fn, next) => {
    const index = cursor++;
    if (!deps[index] || next.some((value, i) => !Object.is(value, deps[index][i]))) { deps[index] = next; effects.push(fn); }
  };
  const source = read('components/harness/ChatCap.jsx').split('export function useChatCap')[1].split('// Wrap the existing')[0];
  const hook = new Function('useState', 'useRef', 'useEffect', 'createCapGuard', 'readDefaultCap', 'writeDefaultCap', 'validCap', 'window', `return function useChatCap${source}`)(state, ref, effect, createCapGuard, readDefaultCap, writeDefaultCap, value => typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n, { localStorage: storage });
  const args = { lanes: [{ id: 'l0', messages: [] }], draft: '', files: [], settings, system: '', key: '', privateMode: false, setLanes: next => { args.lanes = typeof next === 'function' ? next(args.lanes) : next; dirty = true; } };
  const render = () => {
    let result, rounds = 0;
    do { cursor = 0; dirty = false; effects = []; result = hook(args); for (const fn of effects) fn(); assert.ok(++rounds < 10, 'effects settle'); } while (dirty);
    return result;
  };
  return { args, render };
}
test('new chats inherit defaults; changing defaults preserves current caps; comparison lanes share the cap', () => {
  let prefs = JSON.stringify({ defaultChatCap: '2000000' });
  const session = capSession({ getItem: () => prefs, setItem: (_, value) => { prefs = value; } });
  let control = session.render(); assert.equal(control.cap, '2000000');
  control.open('default'); control = session.render(); control.save('5000000');
  control = session.render(); assert.equal(control.cap, '2000000'); assert.equal(control.defaultCap, '5000000');
  session.args.lanes = [...session.args.lanes, { id: 'l1', messages: [] }];
  control = session.render(); assert.equal(session.args.lanes[1].spendingCap, '2000000');
  control.reset(); control = session.render(); assert.equal(control.cap, '5000000');
  session.args.lanes = restoreChatCap({}, [{ id: 'old-chat', messages: [] }]);
  control = session.render(); assert.equal(control.cap, null);
});
test('hook holds, raises and resumes once, and edits to attachments clear a held action', () => {
  const session = capSession({ getItem: () => '{}', setItem() {} }); session.args.lanes = lanes();
  let control = session.render(); let sends = 0;
  const send = () => { if (control.check(requests(), send)) sends++; };
  send(); control = session.render(); assert.ok(control.pending); assert.equal(sends, 0);
  control.sendAnyway(); control = session.render(); assert.equal(sends, 1);
  send(); control = session.render(); assert.ok(control.pending);
  session.args.files = [{ kind: 'image', name: 'picture' }]; control = session.render(); assert.equal(control.pending, null);
  send(); control = session.render(); control.open('raise'); control = session.render(); control.save('5000000');
  control = session.render(); send(); assert.equal(sends, 2); assert.equal(control.cap, '5000000');
});
test('existing encrypted history retains caps through update, lock, reload, rename and pin', async () => {
  const storage = memoryStorage(), history = createHistory({ storage, crypto: webcrypto, iterations: 100000 });
  const chat = currentChat(lanes(), null, 1000);
  await history.create('sample history passphrase'); await history.put(chat);
  await history.edit(chat.id, { title: 'Cap conversation', pinned: true });
  await history.put({ ...chat, spendingCap: parseCap('5') });
  assert.equal(history.get(chat.id).spendingCap, parseCap('5'));
  assert.ok(!JSON.stringify(await storage.get()).includes('spendingCap'));
  history.lock(); assert.throws(() => history.get(chat.id), { code: 'locked' });
  await history.unlock('sample history passphrase');
  assert.equal(history.get(chat.id).spendingCap, parseCap('5'));
  const restored = restoreChatCap(history.get(chat.id), restoreLanes(chat.lanes));
  assert.equal(currentChat(restored, history.get(chat.id)).spendingCap, parseCap('5'));
  await history.put({ ...currentChat(restored, history.get(chat.id)), spendingCap: null });
  assert.equal(history.get(chat.id).spendingCap, undefined);
});
test('history exports and imports retain caps, invalid metadata is rejected, older chats stay uncapped', () => {
  const chat = currentChat(lanes(), null, 1000);
  assert.equal(parseImport(exportJson([chat]))[0].spendingCap, '2000000');
  assert.match(exportMarkdown([chat]), /Chat cap: \$2/);
  for (const value of [-1, 2, '2.0', '0', '0001', '1000000000000000']) assert.throws(() => parseImport(exportJson([{ ...chat, spendingCap: value }])));
  const older = { ...chat }; delete older.spendingCap;
  assert.equal(restoreChatCap(older, restoreLanes(older.lanes))[0].spendingCap, null);
  assert.deepEqual(capFields(older), {});
  assert.equal(savedEntry(older, chat, 1000).spendingCap, undefined);
  assert.equal(currentChat(lanes().map(lane => ({ ...lane, spendingCap: null })), chat, 1000).spendingCap, undefined);
});
test('summaries reuse the existing summary request and estimate; invalid summary stays with existing error path', () => {
  const summary = capSummaryRequests(model, lanes()[0].messages, 'System');
  assert.equal(summary.length, 1);
  assert.ok(summary[0].body.max_tokens > 512);
  assert.equal(capDecision(lanes(), parseCap('2'), summary).held, true);
  assert.deepEqual(capSummaryRequests(null, [], ''), []);
});
test('cost menu and hold notice render accessible plain controls without nesting forms', () => {
  const source = read('components/harness/ChatCap.jsx');
  const transformed = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' });
  const exports = new Function('React', 'createContext', 'Button', 'capDollars', 's', transformed.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + '\nreturn { ChatCapCost, ChatCapNotice };')({ createElement }, createContext, ({ secondary, ...props }) => createElement('button', props, props.children), capDollars, {});
  const control = { cap: parseCap('2'), ready: true, pending: capDecision(lanes(), parseCap('2'), requests()) };
  const chip = renderToStaticMarkup(createElement(exports.ChatCapCost, { control, children: 'This chat: $1.5' }));
  assert.match(chip, /aria-haspopup="dialog"/); assert.match(chip, /Stop this chat at \$2/);
  const notice = renderToStaticMarkup(createElement(exports.ChatCapNotice, { control }));
  assert.match(notice, /This chat would pass its \$2 cap/); assert.match(notice, /Raise cap/); assert.match(notice, /Send anyway/);
  assert.match(notice, /role="alert"/); assert.equal((notice.match(/type="button"/g) || []).length, 2); assert.ok(!notice.includes('<form'));
});
test('integration keeps auth before a hold and every charge path wired; docs and inventory are discoverable', () => {
  const harness = read('components/Harness.jsx');
  const send = harness.slice(harness.indexOf('  function send('), harness.indexOf('  function regenerate('));
  assert.ok(send.indexOf('needKey("send")') < send.indexOf('chatCap.check('));
  assert.ok(send.indexOf('chatCap.check(') < send.indexOf('setDraft("")'));
  assert.match(harness, /chatCap.reset\(\); \/\/ G162/);
  assert.match(harness, /\(\) => regenerate\(laneId, alternativeId\)/);
  assert.match(harness, /\(\) => toolResults\(laneId, results\)/);
  assert.match(read('components/ChatCapDocs.jsx'), /id="chat-cap"/);
  assert.match(read('components/DocsFeatureIndex.jsx'), /\["chat-cap"/);
  assert.match(read('lib/site-map.js'), /task\("chat-cap"/);
  const inventory = JSON.parse(read('app/keep/inventory.generated.json'));
  assert.ok(inventory.outside_postgres.browser.items.some(item => item.holds.includes('spendingCap') && item.holds.includes('defaultChatCap')));
});
