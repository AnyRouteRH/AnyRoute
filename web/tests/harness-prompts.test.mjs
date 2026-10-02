import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { PROMPT_KEY, PROMPT_FORMAT, MAX_PROMPT_BYTES, MAX_PROMPTS, STARTER_PROMPTS, validatePrompts, fillPrompt, promptVariables, importPrompts, exportPrompts, mergePrompts, readPrompts, writePrompts, searchPrompts, slashPrompts, promptShortcut } from '../lib/harness-prompts.js';

const entry = (patch = {}) => ({ id: 'prompt-one', name: 'Explain code', text: 'Explain {{code}} to {{audience}}. Repeat {{code}}.', tags: ['code'], pinned: false, ...patch });
const storage = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }; };
const vault = (store = memoryStorage()) => createHistory({ storage: store, crypto: webcrypto, iterations: 100000 });
const phrase = 'sample passphrase';
const chat = { id: 'chat-one', title: 'A chat', lanes: [{ modelId: 'model-one', messages: [{ id: 'user-one', role: 'user', text: 'An ordinary message' }] }] };

test('variable fields are ordered, repeated names appear once, system fields join and JSON braces stay literal', () => {
  assert.deepEqual(promptVariables(entry().text, 'Be {{tone}} for {{audience}}'), ['code', 'audience', 'tone']);
  assert.deepEqual(promptVariables('JSON {"a":1} and {{invalid!}} and {{ code }}'), ['code']);
  assert.equal(fillPrompt(entry().text, { code: '$& <script>literal</script> {{nested}}', audience: 'people' }), 'Explain $& <script>literal</script> {{nested}} to people. Repeat $& <script>literal</script> {{nested}}.');
  assert.equal(fillPrompt('{"a":1} {{ code }}', { code: 'hello' }), '{"a":1} hello');
});

test('escaping keeps literal variables and backslash pairs; missing, inherited and empty values fail', () => {
  const source = String.raw`\{{literal}} \\{{code}} \\\{{escaped}} {{code}}`;
  assert.deepEqual(promptVariables(source), ['code']);
  assert.equal(fillPrompt(source, { code: 'value' }), String.raw`{{literal}} \value \{{escaped}} value`);
  for (const values of [{}, { code: '' }, { code: ' ' }, { code: 1 }, Object.create({ code: 'inherited' })]) assert.throws(() => fillPrompt('{{code}}', values), /Fill in code/);
  assert.equal(fillPrompt('{{constructor}} {{__proto__}}', JSON.parse('{"constructor":"literal","__proto__":"plain"}')), 'literal plain');
});

test('versioned import preserves only allowed data and rejects malformed, unsupported or duplicate entries', () => {
  const p = entry({ system: 'Use {{tone}}', model: 'model-one', pinned: true });
  assert.deepEqual(importPrompts(exportPrompts([p])), [p]);
  assert.deepEqual(validatePrompts([{ ...p, executable: 'throw new Error()', apiKey: 'sample-key', tags: ['code', 'code'] }]), [p]);
  for (const input of ['{', '{}', 'null', JSON.stringify({ format: PROMPT_FORMAT, version: 2, prompts: [p] }), JSON.stringify({ format: 'other', version: 1, prompts: [] })]) assert.throws(() => importPrompts(input));
  for (const patch of [{ id: '' }, { name: ' ' }, { text: '' }, { text: {} }, { tags: 'code' }, { tags: [''] }, { pinned: 'yes' }, { model: '' }, { system: 1 }, { name: 'x'.repeat(81) }, { tags: Array(21).fill('tag') }]) assert.throws(() => validatePrompts([entry(patch)]));
  assert.throws(() => validatePrompts([p, p]));
  assert.throws(() => validatePrompts(Array.from({ length: MAX_PROMPTS + 1 }, (_, i) => entry({ id: String(i) }))));
  assert.throws(() => importPrompts('x'.repeat(MAX_PROMPT_BYTES + 1)));
  assert.throws(() => validatePrompts(Array.from({ length: 30 }, (_, i) => entry({ id: String(i), text: 'x'.repeat(100000) }))));
});

test('import adds without overwriting matching IDs and validates combined capacity', () => {
  const before = [entry()];
  const incoming = [entry({ name: 'Changed' }), entry({ id: 'prompt-two' })];
  assert.deepEqual(mergePrompts(before, incoming), [entry(), entry({ id: 'prompt-two' })]);
  assert.deepEqual(mergePrompts(before, [entry()]), before);
  const full = Array.from({ length: MAX_PROMPTS }, (_, i) => entry({ id: String(i) }));
  assert.throws(() => mergePrompts(full, [entry()]));
});

test('ordinary browser storage round-trips all prompt fields and keeps an intentionally empty library', () => {
  const store = storage();
  assert.equal(readPrompts(store).length, 8);
  const p = entry({ system: 'Saved instructions', model: 'model-one', pinned: true });
  writePrompts(store, [p]); assert.deepEqual(readPrompts(store), [p]);
  assert.equal(JSON.parse(store.getItem(PROMPT_KEY)).version, 1);
  writePrompts(store, []); assert.deepEqual(readPrompts(store), []);
  store.setItem(PROMPT_KEY, '{}'); assert.throws(() => readPrompts(store));
  assert.throws(() => writePrompts({ setItem: () => { throw new Error('Storage full'); } }, [p]), /Storage full/);
});

test('search uses names, tags, text and system text, handles literal characters and sorts pins first', () => {
  const p = entry({ system: 'Be concise', text: 'Handle [.*] literally.' });
  const other = entry({ id: 'other', name: 'Another', text: 'Draft a reply.', tags: ['writing'], pinned: true });
  for (const query of ['EXPLAIN', 'code', '[.*]', 'concise', 'handle code']) assert.equal(searchPrompts([p, other], query)[0].id, p.id);
  assert.equal(searchPrompts([p, other], 'unmatched').length, 0);
  const list = [p, other], before = structuredClone(list);
  assert.deepEqual(searchPrompts(list, ' ').map((p) => p.id), ['other', p.id]); assert.deepEqual(list, before);
});

test('starter prompts cover eight tasks and every variable can be filled', () => {
  assert.equal(STARTER_PROMPTS.length, 8);
  assert.deepEqual(validatePrompts(STARTER_PROMPTS), STARTER_PROMPTS);
  for (const p of STARTER_PROMPTS) {
    const values = Object.fromEntries(promptVariables(p.text).map((v) => [v, 'Sample content']));
    assert.ok(fillPrompt(p.text, values).length); assert.equal(promptVariables(fillPrompt(p.text, values)).length, 0);
    assert.doesNotMatch(p.name + ' ' + p.text, /\b(?:demo|test|tested|mock|simulated|placeholder)\b|local[ -]build/i);
  }
});

test('shortcut avoids chat/model search and slash commands only match composer command text', () => {
  assert.equal(promptShortcut({ key: 'P', metaKey: true, shiftKey: true }), true);
  for (const patch of [{ key: 'k' }, { shiftKey: false }, { altKey: true }, { repeat: true }, { isComposing: true }, { metaKey: false }]) assert.equal(promptShortcut({ key: 'p', metaKey: true, shiftKey: true, ...patch }), false);
  assert.equal(slashPrompts(STARTER_PROMPTS, '/EXPLAIN')[0].name, 'Explain code');
  assert.equal(slashPrompts(STARTER_PROMPTS, '/').length, 8);
  for (const draft of ['Hello /explain', '/explain\nbody', '/unknown', ' /explain']) assert.equal(slashPrompts(STARTER_PROMPTS, draft).length, 0);
});

test('private prompts share the history key, survive all chat writes and disappear on lock or forget', async () => {
  const store = memoryStorage(), h = vault(store);
  await h.create(phrase); assert.equal(h.listPrompts(), null);
  const p = entry({ name: 'Personal instructions', system: 'Saved system text', model: 'model-one', pinned: true });
  await Promise.all([h.replacePrompts([p]), h.put(chat)]);
  await h.edit(chat.id, { title: 'Renamed chat' }); await h.importChats([{ ...chat, id: 'another-chat' }]); await h.remove(chat.id);
  assert.deepEqual(h.listPrompts(), [p]);
  const copy = h.listPrompts(); copy[0].name = 'Mutated'; assert.equal(h.listPrompts()[0].name, p.name);
  const sealed = JSON.stringify(await store.get());
  for (const text of [p.name, p.text, p.system, p.model, 'prompts', 'pinned']) assert.ok(!sealed.includes(text));
  h.lock(); assert.throws(() => h.listPrompts(), /locked/); await assert.rejects(h.replacePrompts([p]), /locked/);
  await assert.rejects(h.unlock('wrong phrase'));
  const reopened = vault(store); await reopened.unlock(phrase); assert.deepEqual(reopened.listPrompts(), [p]);
  await reopened.replacePrompts([]); reopened.lock(); await reopened.unlock(phrase); assert.deepEqual(reopened.listPrompts(), []);
  await reopened.forget(); assert.equal(await store.get(), null); assert.throws(() => reopened.listPrompts(), /locked/);
});

test('history created before prompt support unlocks and prompt writes do not alter its chats', async () => {
  const store = memoryStorage(), h = vault(store); await h.create(phrase); await h.put(chat);
  h.lock(); await h.unlock(phrase); assert.equal(h.listPrompts(), null);
  const before = h.get(chat.id); await h.replacePrompts([entry()]); assert.deepEqual(h.get(chat.id), before);
  await h.put({ ...chat, id: 'chat-two' }); assert.deepEqual(h.listPrompts(), [entry()]);
});

test('failed and oversized private writes preserve prompts, chats and the encrypted record', async () => {
  const store = memoryStorage(), h = vault(store); await h.create(phrase); await h.replacePrompts([entry()]); await h.put(chat);
  const before = await store.get(), chats = h.list();
  const originalSet = store.set; store.set = async () => { throw new Error('Storage full'); };
  await assert.rejects(h.replacePrompts([entry({ name: 'Lost change' })]), /Storage full/);
  assert.deepEqual(h.listPrompts(), [entry()]); assert.deepEqual(h.list(), chats); assert.deepEqual(await store.get(), before);
  store.set = originalSet;
  await h.put({ ...chat, id: 'large', lanes: [{ modelId: null, messages: [{ id: 'u', role: 'user', text: 'x'.repeat(1900000) }] }] });
  // A nearly full history no longer blocks prompts: they have their own budget.
  await h.replacePrompts([entry({ text: 'x'.repeat(100000) })]);
  assert.equal(h.listPrompts()[0].text.length, 100000);
  await assert.rejects(h.replacePrompts([1, 2, 3].map(i => entry({ id: 'big' + i, text: 'x'.repeat(100000) }))), /full/);
  assert.equal(h.listPrompts()[0].text.length, 100000);
});

test('private prompts have their own budget: a full history plus prompts still seals, oversized prompt sets are refused', async () => {
  const { PRIVATE_PROMPT_BYTES, promptVaultEdits } = await import('../lib/harness-prompt-vault.js');
  assert.ok(PRIVATE_PROMPT_BYTES >= 100_000 && PRIVATE_PROMPT_BYTES <= 500_000);
  const state = { chats: [], prompts: undefined };
  const edits = promptVaultEdits({ serial: fn => fn(), need: () => state, seal: async () => {} });
  const big = Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, name: 'Prompt ' + i, text: 'x'.repeat(1900), tags: [], createdAt: 1, updatedAt: 1 }));
  await assert.rejects(async () => edits.replacePrompts(big), /full|too_large|Invalid|invalid/);
});
