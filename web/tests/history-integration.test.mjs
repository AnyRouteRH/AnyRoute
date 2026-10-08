import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { downloadChats, exportJson, parseImport } from '../lib/harness-history.js';
import { parseFolderImport } from '../lib/chat-folders.js';
import { SAVED_ANSWER_BYTES } from '../lib/saved-answers.js';

const passphrase = 'sample history passphrase';
const folder = { id: 'f1', name: 'Trips' };
const chat = { id: 'c1', title: 'Travel', at: 1000, lanes: [{ modelId: 'model/one', messages: [{ id: 'u1', role: 'user', text: 'When should I travel?', files: [] }] }] };
const answer = { id: 'saved-1', chatId: 'c1', messageId: 'a1', question: 'When should I travel?', answer: 'Leave in the morning.', model: 'model/one', at: 1000, cost: 0.01, receiptId: 'receipt-1' };
const vault = (storage = memoryStorage()) => createHistory({ storage, crypto: webcrypto, iterations: 100000 });
const combined = () => parseFolderImport(exportJson([{ ...chat, folderId: folder.id }], { folders: [folder], savedAnswers: [answer] }));

test('one download round trips folders, empty folders and detached answers; both legacy array arguments still work', async () => {
  const folders = [folder, { id: 'empty', name: 'Later' }], savedAnswers = [answer, { ...answer, id: 'detached', chatId: 'deleted' }];
  const chats = [{ ...chat, folderId: folder.id }];
  const expected = { chats: parseImport(exportJson(chats, { folders })), folders, savedAnswers };
  assert.deepEqual(parseFolderImport(exportJson(chats, { folders, savedAnswers })), expected);
  assert.deepEqual(parseFolderImport(exportJson(chats, savedAnswers, folders)), expected);
  assert.deepEqual(parseFolderImport(exportJson([chat], [answer])).savedAnswers, [answer]);
  assert.deepEqual(parseFolderImport(exportJson(chats, folders)).folders, folders);
  let blob, clicks = 0, revokes = 0;
  const link = { click() { clicks++; }, remove() {} };
  const scope = { URL: { createObjectURL(value) { blob = value; return 'blob:history'; }, revokeObjectURL() { revokes++; } }, document: { createElement: () => link, body: { append() {} } }, setTimeout: fn => fn() };
  downloadChats(chats, 'json', scope, { folders, savedAnswers });
  assert.equal(clicks, 1); assert.equal(revokes, 1);
  assert.deepEqual(parseFolderImport(await blob.text()), expected);
  downloadChats(chats, 'md', scope, { folders, savedAnswers });
  assert.match(await blob.text(), /# Saved answer[\s\S]*Leave in the morning/);
});

test('every kind of vault write preserves both features and prompts through lock/unlock', async () => {
  const storage = memoryStorage(), h = vault(storage);
  await h.create(passphrase); await h.importFolderHistory(combined());
  await h.replacePrompts([]);
  await h.renameFolder(folder.id, 'Travel plans');
  await h.createFolder('Later');
  const other = h.listFolders().find(f => f.id !== folder.id);
  await h.moveChat(chat.id, other.id);
  await h.saveAnswer({ ...answer, id: 'second' }); await h.unsaveAnswer('second');
  await h.put({ ...chat, title: 'Continuation' }); await h.edit(chat.id, { pinned: true });
  h.lock(); await h.unlock(passphrase);
  assert.equal(h.get(chat.id).folderId, other.id);
  assert.equal(h.get(chat.id).pinned, true);
  assert.deepEqual(h.listSavedAnswers(), [answer]); assert.deepEqual(h.listPrompts(), []);
  await h.deleteFolder(other.id); await h.remove(chat.id);
  h.lock(); await h.unlock(passphrase);
  assert.equal(h.get(chat.id), null); assert.deepEqual(h.listSavedAnswers(), [answer]);
  assert.deepEqual(h.listFolders(), [{ ...folder, name: 'Travel plans' }]);
  for (const text of ['savedAnswers', 'folderId', 'Travel plans', answer.answer]) assert.ok(!JSON.stringify(await storage.get()).includes(text));
});

test('combined imports remap folder collisions, preserve existing records and are idempotent', async () => {
  const h = vault(); await h.create(passphrase);
  await h.importFolderHistory(parseFolderImport(exportJson([{ ...chat, id: 'held', folderId: folder.id }], { folders: [{ ...folder, name: 'Work' }], savedAnswers: [answer] })));
  const incoming = combined(); incoming.chats[0].lanes[0].messages[0].text = 'A different conversation';
  incoming.savedAnswers.push({ ...answer, answer: 'Overwrite attempt' }, { ...answer, id: 'new-answer' });
  const first = await h.importFolderHistory(incoming);
  assert.equal(first.count, 1); assert.equal(first.skipped, 0);
  const trips = h.listFolders().find(f => f.name === 'Trips');
  assert.notEqual(trips.id, folder.id); assert.equal(h.get(chat.id).folderId, trips.id);
  assert.equal(h.get('held').folderId, folder.id);
  assert.equal(h.listSavedAnswers().find(a => a.id === answer.id).answer, answer.answer);
  const again = await h.importFolderHistory(incoming);
  assert.equal(again.count, 0); assert.equal(again.skipped, 1);
  assert.equal(h.listFolders().length, 2); assert.equal(h.listSavedAnswers().length, 2);
  h.lock(); await h.unlock(passphrase);
  assert.equal(h.get(chat.id).folderId, trips.id); assert.equal(h.listSavedAnswers().length, 2);
});

test('failed storage and answer capacity checks leave all imported collections unchanged', async () => {
  const storage = memoryStorage(), h = vault(storage); await h.create(passphrase);
  const before = await storage.get(), write = storage.set;
  storage.set = async () => { throw new Error('Storage full'); };
  await assert.rejects(h.importFolderHistory(combined()), /Storage full/);
  assert.deepEqual(h.list(), []); assert.deepEqual(h.listFolders(), []); assert.deepEqual(h.listSavedAnswers(), []);
  assert.deepEqual(await storage.get(), before);
  storage.set = write;
  const oversized = combined(); oversized.savedAnswers[0].answer = 'x'.repeat(SAVED_ANSWER_BYTES);
  await assert.rejects(h.importFolderHistory(oversized), /full/);
  assert.deepEqual(h.list(), []); assert.deepEqual(h.listFolders(), []); assert.deepEqual(h.listSavedAnswers(), []);
  assert.deepEqual(await storage.get(), before);
});

for (const [label, document] of [
  ['old', { chats: [chat] }],
  ['saved answers only', { chats: [chat], savedAnswers: [answer] }],
  ['folders only', { chats: [{ ...chat, folderId: folder.id }], folders: [folder] }],
]) {
  test(`the ${label} encrypted format opens and gains the other feature without losing data`, async () => {
    const storage = memoryStorage(), h = vault(storage); await h.create(passphrase);
    const record = await storage.get();
    const salt = Buffer.from(record.salt, 'base64'), iv = webcrypto.getRandomValues(new Uint8Array(12));
    const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: record.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('anyroute-private-history/1') }, key, new TextEncoder().encode(JSON.stringify(document)));
    await storage.set({ ...record, iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') });
    h.lock(); await h.unlock(passphrase);
    assert.deepEqual(h.get(chat.id), document.chats[0]);
    assert.deepEqual(h.listFolders(), document.folders || []);
    assert.deepEqual(h.listSavedAnswers(), document.savedAnswers || []);
    if (!document.folders) await h.createFolder('Trips');
    if (!document.savedAnswers) await h.saveAnswer(answer);
    h.lock(); await h.unlock(passphrase);
    assert.equal(h.listFolders()[0].name, 'Trips'); assert.deepEqual(h.listSavedAnswers(), [answer]);
  });
}
