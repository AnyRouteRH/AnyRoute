import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { exportJson, parseImport, downloadChats } from '../lib/harness-history.js';
import { answerFromReply, savedAnswerOnScreen, mergeSavedAnswers, savedAnswersFromExport, searchSavedAnswers, validateSavedAnswers, SAVED_ANSWER_BYTES } from '../lib/saved-answers.js';

const pass = 'sample history passphrase';
const reply = { id: 'a1', role: 'assistant', text: 'Leave in the morning.', model: 'model/one', status: 'done', usage: { cost: 0.01 }, receipt: { id: 'receipt-1' }, reasoning: 'excluded reasoning', images: ['excluded image'] };
const lane = { id: 'l0', modelId: 'model/one', messages: [{ id: 'u1', role: 'user', text: 'When should I travel?' }, reply] };
const answer = () => answerFromReply(lane, reply, 'c1', 1000);
const chat = { id: 'c1', title: 'Travel', at: 1000, lanes: [{ modelId: lane.modelId, messages: [{ id: 'u1', role: 'user', text: 'When should I travel?', files: [] }] }] };
const vault = (storage = memoryStorage()) => createHistory({ storage, crypto: webcrypto, iterations: 100000 });

test('save captures the preceding question and only reply text, model, cost, date and receipt metadata', () => {
  const a = answer();
  assert.equal(a.question, 'When should I travel?'); assert.equal(a.answer, reply.text);
  assert.equal(a.model, reply.model); assert.equal(a.cost, 0.01); assert.equal(a.at, 1000); assert.equal(a.receiptId, 'receipt-1');
  assert.ok(!JSON.stringify(a).includes('excluded'));
  const longReply = { ...reply, id: "a".repeat(200), model: "m".repeat(300) };
  const longLane = { ...lane, modelId: longReply.model, messages: [lane.messages[0], longReply] };
  assert.equal(answerFromReply(longLane, longReply, "c".repeat(200)).messageId.length, 200);
  const later = { ...reply, id: 'a2', text: 'Later answer', usage: null, receipt: null };
  const nextLane = { ...lane, messages: [...lane.messages, { role: 'user', text: 'Next question' }, { role: 'tool', text: 'excluded tool' }, later] };
  assert.equal(answerFromReply(nextLane, later).question, 'Next question');
  assert.equal(answerFromReply(nextLane, later).cost, null); assert.equal(answerFromReply(nextLane, later).receiptId, '');
});

test('search matches questions and full answers without case sensitivity, newest first', () => {
  const old = answer(), newer = { ...old, id: 'second', at: 2000, question: 'Other question', answer: 'Afternoon departure' };
  const list = [old, newer], before = structuredClone(list);
  assert.deepEqual(searchSavedAnswers(list).map(a => a.id), ['second', old.id]);
  assert.equal(searchSavedAnswers(list, 'TRAVEL')[0].id, old.id);
  assert.equal(searchSavedAnswers(list, 'AFTERNOON')[0].id, 'second');
  assert.deepEqual(searchSavedAnswers(list, 'missing'), []); assert.deepEqual(list, before);
});

test('history is off by default; locked history refuses reads, saves, unsaves and imports', async () => {
  const h = vault(); assert.equal(h.unlocked, false); assert.equal(await h.exists(), false);
  assert.throws(() => h.listSavedAnswers(), /locked/);
  await assert.rejects(h.saveAnswer(answer()), /locked/); await assert.rejects(h.unsaveAnswer('any'), /locked/);
  await assert.rejects(h.importChats([], [answer()]), /locked/);
  assert.equal(await h.exists(), false);
});

test('save and unsave use encrypted storage, preserve prompts and chats, and survive reopening', async () => {
  const storage = memoryStorage(), h = vault(storage); await h.create(pass); await h.put(chat);
  await h.replacePrompts([]); await h.saveAnswer(answer()); await h.saveAnswer(answer());
  assert.deepEqual(h.listSavedAnswers(), [answer()]); assert.ok(h.get('c1')); assert.deepEqual(h.listPrompts(), []);
  for (const text of ['morning', 'travel', 'savedAnswers']) assert.ok(!JSON.stringify(await storage.get()).includes(text));
  h.lock(); await h.unlock(pass); assert.deepEqual(h.listSavedAnswers(), [answer()]);
  await h.unsaveAnswer(answer().id); h.lock(); await h.unlock(pass); assert.deepEqual(h.listSavedAnswers(), []);
});

test('saved answers survive chat deletion, later chat writes, metadata edits and automatic trimming', async () => {
  const storage = memoryStorage(), h = vault(storage); await h.create(pass); await h.put(chat); await h.saveAnswer(answer());
  await h.remove('c1'); assert.equal(h.get('c1'), null); assert.deepEqual(h.listSavedAnswers(), [answer()]);
  await h.put({ ...chat, id: 'other' }); await h.edit('other', { title: 'Renamed' });
  for (let i = 0; i < 41; i++) await h.put({ ...chat, id: 'chat-' + i });
  h.lock(); await h.unlock(pass); assert.deepEqual(h.listSavedAnswers(), [answer()]);
  await h.forget(); assert.equal(await h.exists(), false); assert.throws(() => h.listSavedAnswers(), /locked/);
});

test('existing history JSON exports round trip both chats and detached saved answers, with idempotent imports', async () => {
  const source = exportJson([chat], [answer()]); const chats = parseImport(source), answers = savedAnswersFromExport(source);
  const h = vault(); await h.create(pass); await h.importChats(chats, answers); await h.importChats(chats, answers);
  assert.equal(h.list().length, 1); assert.deepEqual(h.listSavedAnswers(), [answer()]);
  await h.remove('c1'); const detached = exportJson([], h.listSavedAnswers());
  const other = vault(); await other.create(pass); await other.importChats(parseImport(detached), savedAnswersFromExport(detached));
  assert.deepEqual(other.list(), []); assert.deepEqual(other.listSavedAnswers(), [answer()]);
  assert.deepEqual(savedAnswersFromExport(exportJson([chat])), []);
});

test('malformed saved answers and over-capacity writes fail without evicting stored answers', async () => {
  for (const patch of [{ question: {} }, { answer: null }, { cost: -1 }, { at: Infinity }, { receiptId: 12 }, { id: '' }, { chatId: null }]) {
    assert.throws(() => validateSavedAnswers([{ ...answer(), ...patch }]));
    assert.throws(() => parseImport(exportJson([chat]).replace('"chats":', '"savedAnswers": ' + JSON.stringify([{ ...answer(), ...patch }]) + ', "chats":')));
  }
  const h = vault(); await h.create(pass); await h.saveAnswer(answer());
  await assert.rejects(h.saveAnswer({ ...answer(), id: 'too-big', answer: 'x'.repeat(SAVED_ANSWER_BYTES) }), /full/);
  assert.deepEqual(h.listSavedAnswers(), [answer()]);
  assert.equal(mergeSavedAnswers([answer()], [{ ...answer(), answer: 'Overwrite attempt' }])[0].answer, reply.text);
});

test('failed encrypted writes and imports leave both saved answers and chats intact', async () => {
  const storage = memoryStorage(), h = vault(storage); await h.create(pass); await h.put(chat); await h.saveAnswer(answer());
  storage.set = async () => { throw new Error('Storage full'); };
  await assert.rejects(h.unsaveAnswer(answer().id), /Storage full/);
  await assert.rejects(h.saveAnswer({ ...answer(), id: 'second' }), /Storage full/);
  await assert.rejects(h.importChats([{ ...chat, id: 'second' }], [{ ...answer(), id: 'second' }]), /Storage full/);
  assert.deepEqual(h.listSavedAnswers(), [answer()]); assert.equal(h.get('second'), null);
});

test('saved-only exports work through the existing download helper without network or plain storage', () => {
  let blob, clicked = false;
  const link = { click: () => { clicked = true; }, remove() {} };
  const scope = { URL: { createObjectURL: value => { blob = value; return 'blob:answers'; }, revokeObjectURL() {} }, document: { createElement: () => link, body: { append() {} } }, setTimeout: fn => fn() };
  downloadChats([], 'json', scope, [answer()]); assert.equal(clicked, true); assert.ok(blob instanceof Blob);
});

test('ordinary replies can be saved without saving or clearing the conversation; Open chat follows its lifetime', async () => {
  const h = vault(); await h.create(pass);
  const detached = answerFromReply(lane, reply, "", 1000), before = structuredClone(lane);
  await h.saveAnswer(detached); assert.deepEqual(h.list(), []); assert.deepEqual(lane, before);
  assert.equal(savedAnswerOnScreen(detached, [lane]), true);
  assert.equal(savedAnswerOnScreen(detached, [{ ...lane, messages: [] }]), false);
  assert.equal(savedAnswerOnScreen(detached, [{ ...lane, messages: [{ ...reply, text: "Other reply" }] }]), false);
  h.lock(); await h.unlock(pass); assert.deepEqual(h.listSavedAnswers(), [detached]);
});
