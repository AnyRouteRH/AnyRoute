import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MAX_BYTES, MAX_CHATS, createHistory, memoryStorage, restoreLanes } from '../lib/private-history.js';
import { buildSearchIndex, currentChat, downloadChats, exportJson, exportMarkdown, highlightParts, historyShortcut, mergeImport, parseImport, searchChats } from '../lib/harness-history.js';

const chat = (id = 'c1', title = 'Travel notes', body = 'Take the train to Montréal.') => ({
  id, title, at: 1000, lanes: [{ modelId: 'model/one', messages: [
    { id: 'u1', role: 'user', text: body, files: ['map.pdf'] },
    { id: 'a1', role: 'assistant', text: 'Leave in the morning.', model: 'model/one', provider: 'provider', ms: 20, receiptId: 'receipt-1', lane: 'attested', disclosure: 'attested', usage: { prompt_tokens: 4, completion_tokens: 5, cost: 0.01 } },
  ] }],
});
const vault = (storage = memoryStorage()) => createHistory({ storage, crypto: webcrypto, iterations: 100000, now: () => 2000 });
const passphrase = 'sample history passphrase';

test('search indexes every lane, user and assistant text, and highlights literal case-insensitive matches', () => {
  const c = chat();
  c.lanes.push({ modelId: 'model/two', messages: [{ id: 'a2', role: 'assistant', text: 'Bring sunscreen.' }] });
  const index = buildSearchIndex([c, chat('c2', 'Another chat', 'Walk home.')]);
  for (const query of ['TRAVEL', 'montréal', 'morning', 'sunscreen']) assert.equal(searchChats(index, query)[0].chat.id, 'c1');
  assert.equal(searchChats(index, 'nothing here').length, 0);
  assert.equal(searchChats(index, '   ').length, 2);
  assert.match(searchChats(index, 'morning')[0].snippet, /morning/);
  assert.deepEqual(highlightParts('A [.*] and [.*]', '[.*]'), [
    { text: 'A ', match: false }, { text: '[.*]', match: true }, { text: ' and ', match: false }, { text: '[.*]', match: true },
  ]);
  assert.equal(highlightParts('<script>HELLO</script>', 'hello').map(p => p.text).join(''), '<script>HELLO</script>');
});

test('pins lead the results and recent chats lead each section; search does not mutate chat data', () => {
  const chats = [{ ...chat('old'), at: 1, pinned: true }, { ...chat('new'), at: 3 }, { ...chat('pin'), at: 2, pinned: true }];
  const before = structuredClone(chats);
  assert.deepEqual(searchChats(buildSearchIndex(chats), '').map(r => r.chat.id), ['pin', 'old', 'new']);
  assert.deepEqual(chats, before);
});

test('JSON round trip preserves text, models, receipts, metadata and compatible restored lanes', () => {
  const original = { ...chat(), pinned: true };
  const parsed = parseImport(exportJson([original]));
  assert.deepEqual(parsed, [original]);
  assert.deepEqual(restoreLanes(parsed[0].lanes), restoreLanes(original.lanes));
  const md = exportMarkdown(parsed);
  for (const value of ['# Travel notes', '## model/one', '### You', '### Assistant', 'Montréal', 'map', 'receipt']) assert.ok(md.includes(value), value);
});

test('current export uses the history snapshot policy and keeps a renamed title', () => {
  const lanes = [{ modelId: 'model/one', messages: [
    { id: 'u', role: 'user', text: 'hi', attachments: [{ name: 'map.pdf', url: 'data:secret' }] },
    { id: 'a', role: 'assistant', text: 'hello', status: 'done', reasoning: 'hidden reasoning', images: ['data:image'], receipt: { id: 'r1' } },
    { id: 't', role: 'tool', text: 'tool traffic' },
  ] }];
  const c = currentChat(lanes, { id: 'saved', title: 'My title', pinned: true, at: 10 }, 20);
  assert.equal(c.title, 'My title'); assert.equal(c.id, 'saved'); assert.equal(c.pinned, true);
  const serialized = exportJson([c]);
  for (const gone of ['data:secret', 'hidden reasoning', 'data:image', 'tool traffic']) assert.ok(!serialized.includes(gone));
  assert.deepEqual(parseImport(serialized)[0].lanes, JSON.parse(JSON.stringify(c.lanes)));
  assert.equal(currentChat([]), null);
});

test('imports reject malformed, oversized and unsupported data before merging', () => {
  for (const input of ['{', '{}', 'null', JSON.stringify({ format: 'other', version: 1, chats: [] })]) assert.throws(() => parseImport(input));
  assert.throws(() => parseImport('x'.repeat(MAX_BYTES * 2 + 1)), /smaller than/);
  const mutate = (fn) => { const c = chat(); fn(c); return exportJson([c]); };
  for (const edit of [
    c => c.title = '', c => c.id = '', c => c.title = 'x'.repeat(81), c => c.at = -1,
    c => c.pinned = 'yes', c => c.lanes = [], c => c.lanes.push(...c.lanes, ...c.lanes, ...c.lanes),
    c => c.lanes[0].messages[0].role = 'system', c => c.lanes[0].messages[0].text = {},
    c => c.lanes[0].messages[0].files = 'file', c => c.lanes[0].messages[1].usage.cost = -1,
    c => c.lanes[0].messages[1].stopped = 'yes',
  ]) assert.throws(() => parseImport(mutate(edit)));
  assert.throws(() => parseImport(exportJson(Array.from({ length: MAX_CHATS + 1 }, (_, i) => chat('c' + i)))));
});

test('import allowlist strips unknown fields, attachments and credentials', () => {
  const c = chat(); c.apiKey = 'sample-key'; c.lanes[0].system = 'secret instruction';
  c.lanes[0].messages[0].attachments = [{ url: 'data:attachment' }];
  c.lanes[0].messages[1].reasoning = 'reasoning';
  const parsed = JSON.stringify(parseImport(exportJson([c])));
  for (const gone of ['sample-key', 'secret instruction', 'data:attachment', 'reasoning']) assert.ok(!parsed.includes(gone));
});

test('dedupe handles existing ids, repeated imports and identical content with different message ids', () => {
  const one = chat();
  const clone = { ...chat('copy'), title: 'Different title', pinned: true };
  clone.lanes[0].messages[0].id = 'different';
  const two = chat('c2', 'Second', 'A distinct question');
  const incoming = [one, clone, two, structuredClone(two)];
  const merged = mergeImport([one], incoming);
  assert.deepEqual(merged.additions, [two]); assert.equal(merged.skipped, 3);
  assert.equal(mergeImport([one, two], incoming).additions.length, 0);
  assert.equal(one.title, 'Travel notes');
});

test('import capacity is enforced without evicting existing history', async () => {
  const h = vault(); await h.create(passphrase);
  for (let i = 0; i < MAX_CHATS; i++) await h.put(chat('c' + i, 'Chat ' + i, 'Unique ' + i));
  const before = h.list();
  assert.throws(() => mergeImport(before.map(c => h.get(c.id)), [chat('extra', 'Extra', 'Additional chat')]), /full/);
  await assert.rejects(h.importChats([chat('extra')]), /full/);
  assert.deepEqual(h.list(), before);
  assert.throws(() => mergeImport([], [chat('big', 'Big', 'x'.repeat(MAX_BYTES))]), /full/);
});

test('renames and pins are encrypted, survive reopening and are retained when a conversation continues', async () => {
  const storage = memoryStorage(), h = vault(storage);
  await h.create(passphrase); await h.put(chat());
  const at = h.get('c1').at;
  await h.edit('c1', { title: 'A personal title', pinned: true });
  assert.equal(h.get('c1').at, at);
  const sealed = JSON.stringify(await storage.get());
  for (const plaintext of ['A personal title', 'pinned', 'Travel notes', 'Montréal']) assert.ok(!sealed.includes(plaintext));
  h.lock(); assert.deepEqual(h.list(), []);
  assert.throws(() => h.get('c1'), /locked/);
  await assert.rejects(h.edit('c1', { title: 'No access' }), /locked/);
  await h.unlock(passphrase);
  await h.put(chat('c1', 'Generated title', 'Continued chat'));
  assert.equal(h.get('c1').title, 'A personal title'); assert.equal(h.list()[0].pinned, true);
  await h.edit('c1', { pinned: false });
  assert.equal(h.get('c1').pinned, false);
  await assert.rejects(h.edit('c1', { title: '  ' }));
});

test('validated imports go straight into the encrypted vault and are idempotent', async () => {
  const storage = memoryStorage(), h = vault(storage);
  await h.create(passphrase);
  const incoming = parseImport(exportJson([{ ...chat(), pinned: true }]));
  assert.equal(await h.importChats(incoming), 1);
  assert.equal(await h.importChats(incoming), 0);
  assert.ok(!JSON.stringify(await storage.get()).includes('Travel notes'));
  h.lock(); await assert.rejects(h.importChats(incoming), /locked/);
  await h.unlock(passphrase); assert.deepEqual(h.get('c1'), incoming[0]);
});

test('failed encrypted writes preserve history metadata and contents', async () => {
  const storage = memoryStorage(), h = vault(storage);
  await h.create(passphrase); await h.put(chat());
  const before = h.get('c1'), record = await storage.get();
  storage.set = async () => { throw new Error('Storage full'); };
  await assert.rejects(h.edit('c1', { title: 'Lost title', pinned: true }), /Storage full/);
  await assert.rejects(h.importChats([chat('c2')]), /Storage full/);
  assert.deepEqual(h.get('c1'), before); assert.equal(h.get('c2'), null);
  assert.deepEqual(await storage.get(), record);
});

test('shortcuts distinguish history search and current export from model search and normal typing', () => {
  const key = { key: 'k', ctrlKey: true };
  assert.equal(historyShortcut(key), 'search');
  assert.equal(historyShortcut({ key: 'K', metaKey: true }), 'search');
  assert.equal(historyShortcut({ key: 'E', metaKey: true, shiftKey: true }), 'export');
  for (const e of [{ key: 'k' }, { ...key, shiftKey: true }, { ...key, altKey: true }, { ...key, repeat: true }, { ...key, isComposing: true }, { key: 'e', ctrlKey: true }]) assert.equal(historyShortcut(e), null);
});

test('downloads use a temporary browser blob and revoke it; search and exports never use the network or plain storage', () => {
  const original = globalThis.fetch, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Plain storage forbidden'); } });
  const calls = [], link = { click: () => calls.push('click'), remove: () => calls.push('remove') };
  const scope = {
    URL: { createObjectURL: blob => { assert.ok(blob instanceof Blob); calls.push('blob'); return 'blob:download'; }, revokeObjectURL: url => calls.push(url) },
    document: { createElement: tag => { assert.equal(tag, 'a'); return link; }, body: { append: () => calls.push('append') } },
    setTimeout: fn => fn(),
  };
  try {
    const c = chat(); const index = buildSearchIndex([c]);
    assert.equal(searchChats(index, 'train').length, 1);
    downloadChats([c], 'json', scope);
    assert.equal(link.download, 'anyroute-chat.json');
    assert.deepEqual(calls, ['blob', 'append', 'click', 'remove', 'blob:download']);
    downloadChats([c, chat('c2')], 'md', scope);
    assert.equal(link.download, 'anyroute-history.md');
    assert.throws(() => downloadChats([], 'json', scope), /no conversations/);
  } finally {
    globalThis.fetch = original;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage;
  }
});
