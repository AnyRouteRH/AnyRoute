import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { currentChat, downloadChats, exportJson } from '../lib/harness-history.js';
import { createFolder, deleteFolder, folderCounts, MAX_FOLDERS, mergeFolderImport, moveChat, parseFolderImport, renameFolder, searchFolder } from '../lib/chat-folders.js';
const chat = (id, text = id) => ({ id, title: id, at: 1, lanes: [{ modelId: null, messages: [{ id: 'u', role: 'user', text, files: [] }] }] });
const empty = () => ({ chats: [chat('one', 'shared train'), chat('two', 'shared boat')], folders: [] });
const vault = storage => createHistory({ storage, crypto: webcrypto, iterations: 100000 });
const passphrase = 'sample folder passphrase';

test('folder CRUD is immutable, trims names and rejects duplicates and limits', () => {
  const before = empty(), snapshot = structuredClone(before);
  let state = createFolder(before, '  Trips  ', 'f1');
  assert.deepEqual(before, snapshot);
  assert.deepEqual(state.folders, [{ id: 'f1', name: 'Trips' }]);
  assert.throws(() => createFolder(state, 'trips', 'f2'), /already/);
  assert.throws(() => createFolder(state, 'More', 'f1'));
  for (const name of ['', '   ', 'x'.repeat(81)]) assert.throws(() => createFolder(state, name, 'new'));
  state = createFolder(state, 'Work', 'f2');
  assert.throws(() => renameFolder(state, 'f2', 'TRIPS'), /already/);
  assert.throws(() => renameFolder(state, 'missing', 'Travel'), /no longer/);
  state = renameFolder(state, 'f1', 'Travel');
  assert.equal(state.folders[0].name, 'Travel');
  const full = { chats: [], folders: Array.from({ length: MAX_FOLDERS }, (_, i) => ({ id: `f${i}`, name: `Folder ${i}` })) };
  assert.throws(() => createFolder(full, 'Extra', 'extra'), /40/);
});

test('move and delete update counts, keep all chats and allow moving back to All chats', () => {
  const original = createFolder(empty(), 'Trips', 'f1');
  let state = moveChat(original, 'one', 'f1');
  assert.equal(original.chats[0].folderId, undefined);
  assert.deepEqual(folderCounts(state.chats, state.folders), [{ id: 'f1', name: 'Trips', count: 1 }]);
  assert.throws(() => moveChat(state, 'one', 'missing'));
  assert.throws(() => moveChat(state, 'missing', 'f1'));
  assert.deepEqual(moveChat(state, 'one', null), original);
  state = deleteFolder(state, 'f1');
  assert.deepEqual(state, empty());
  assert.deepEqual(deleteFolder(state, 'missing'), state);
});

test('search applies folder scope to titles and messages while all includes assigned and unassigned chats', () => {
  let state = createFolder(empty(), 'Trips', 'f1');
  state = moveChat(state, 'one', 'f1');
  const ids = (query, scope) => searchFolder(state.chats, query, scope).map(row => row.chat.id);
  assert.deepEqual(ids('shared', 'f1'), ['one']);
  assert.deepEqual(ids('two', 'f1'), []);
  assert.deepEqual(ids('TRAIN', 'f1'), ['one']);
  assert.deepEqual(ids('', 'f1'), ['one']);
  assert.deepEqual(ids('shared', null), ['one', 'two']);
  assert.deepEqual(ids('', 'missing'), []);
});

test('JSON round trip keeps folders, empty folders and assignments; old exports remain valid', () => {
  const state = moveChat(createFolder(createFolder(empty(), 'Trips', 'f1'), 'Empty', 'f2'), 'one', 'f1');
  const parsed = parseFolderImport(exportJson(state.chats, state.folders));
  assert.deepEqual(parsed.folders, state.folders);
  assert.equal(parsed.chats[0].folderId, 'f1');
  assert.deepEqual(parseFolderImport(exportJson([])), { chats: [], folders: [] });
  assert.deepEqual(parseFolderImport(exportJson([], state.folders)), { chats: [], folders: state.folders });
  const invalid = (folders, chats = []) => JSON.stringify({ format: 'anyroute-harness-history', version: 1, folders, chats });
  for (const folders of [null, {}, [{ id: '', name: 'Bad' }], [{ id: 'x', name: 'One' }, { id: 'x', name: 'Two' }], [{ id: 'x', name: 'One' }, { id: 'y', name: 'ONE' }]]) assert.throws(() => parseFolderImport(invalid(folders)));
  assert.throws(() => parseFolderImport(invalid([], [{ ...chat('one'), folderId: 'missing' }])));
  assert.throws(() => parseFolderImport(invalid([], [{ ...chat('one'), folderId: {} }])));
});

test('import remaps conflicting folder ids, merges matching names and never changes existing chats', () => {
  const existing = moveChat(createFolder(empty(), 'Work', 'f1'), 'one', 'f1');
  const incoming = { folders: [{ id: 'f1', name: 'Trips' }, { id: 'other', name: 'WORK' }], chats: [{ ...chat('new'), folderId: 'f1' }, { ...chat('more'), folderId: 'other' }, { ...chat('one'), folderId: 'f1' }] };
  const merged = mergeFolderImport(existing, incoming, () => 'remapped');
  assert.deepEqual(merged.folders, [{ id: 'f1', name: 'Work' }, { id: 'remapped', name: 'Trips' }]);
  assert.equal(merged.chats.find(chat => chat.id === 'new').folderId, 'remapped');
  assert.equal(merged.chats.find(chat => chat.id === 'more').folderId, 'f1');
  assert.equal(merged.chats.find(chat => chat.id === 'one').folderId, 'f1');
  assert.equal(merged.count, 2); assert.equal(merged.skipped, 1);
  const again = mergeFolderImport(merged, incoming, () => 'unused');
  assert.equal(again.count, 0); assert.deepEqual(again.folders, merged.folders);
});

test('folders and assignments survive vault writes, lock/unlock, continuation and delete without plaintext storage', async () => {
  const storage = memoryStorage(), h = vault(storage);
  await h.create(passphrase); await h.put(chat('one'));
  await h.createFolder('Private travel');
  const id = h.listFolders()[0].id;
  await h.moveChat('one', id);
  await h.edit('one', { title: 'Trip', pinned: true });
  await h.put(chat('one', 'Continuing'));
  assert.equal(h.get('one').folderId, id);
  const current = currentChat([{ modelId: null, messages: [{ id: 'u', role: 'user', text: 'Hi' }] }], h.get('one'));
  assert.equal(current.folderId, id);
  const sealed = JSON.stringify(await storage.get());
  for (const text of ['Private travel', id, 'folderId', 'Continuing']) assert.ok(!sealed.includes(text));
  h.lock(); assert.throws(() => h.listFolders(), /locked/);
  await assert.rejects(h.createFolder('No access'), /locked/);
  await assert.rejects(h.moveChat('one', null), /locked/);
  await h.unlock(passphrase);
  assert.deepEqual(h.listFolders(), [{ id, name: 'Private travel' }]);
  await h.renameFolder(id, 'Travel'); await h.deleteFolder(id);
  assert.equal(h.get('one').title, 'Trip'); assert.equal(h.get('one').pinned, true);
  assert.equal(h.get('one').folderId, undefined); assert.equal(h.list().length, 1);
  await h.forget(); assert.equal(await storage.get(), null);
});

test('imports are atomic on storage failure, capacity limits include folders, and old vaults unlock', async () => {
  const storage = memoryStorage(), h = vault(storage);
  await h.create(passphrase); await h.put(chat('one'));
  h.lock(); await h.unlock(passphrase); assert.deepEqual(h.listFolders(), []);
  const incoming = parseFolderImport(exportJson([{ ...chat('new'), folderId: 'f' }], [{ id: 'f', name: 'Imported' }]));
  const saved = await storage.get(), write = storage.set;
  storage.set = async () => { throw new Error('Storage full'); };
  await assert.rejects(h.importFolderHistory(incoming), /Storage full/);
  assert.deepEqual(h.listFolders(), []); assert.equal(h.get('new'), null); assert.deepEqual(await storage.get(), saved);
  storage.set = write;
  const result = await h.importFolderHistory(incoming); assert.equal(result.count, 1);
  await h.put(chat('one', 'Other reply'));
  await h.remove('one');
  h.lock(); await h.unlock(passphrase);
  assert.equal(h.get('new').folderId, 'f'); assert.equal(h.listFolders()[0].name, 'Imported');
  assert.equal((await h.importFolderHistory(incoming)).count, 0);
});

test('folder-only exports download without uploading and include empty folders', async () => {
  let blob;
  const link = { click() {}, remove() {} };
  const scope = { URL: { createObjectURL(value) { blob = value; return 'blob:history'; }, revokeObjectURL() {} }, document: { createElement: () => link, body: { append() {} } }, setTimeout: fn => fn() };
  downloadChats([], 'json', scope, [{ id: 'f', name: 'Empty' }]);
  assert.deepEqual(parseFolderImport(await blob.text()), { chats: [], folders: [{ id: 'f', name: 'Empty' }] });
});
