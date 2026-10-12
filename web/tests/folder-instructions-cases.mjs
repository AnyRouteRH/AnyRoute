// G157: the same behaviour cases run in Node and Bun, without external services.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { createFolder, moveChat, deleteFolder, parseFolderImport, mergeFolderImport, validateFolders } from '../lib/chat-folders.js';
import { activeFolder, folderSystems, setFolderInstructions, MAX_FOLDER_INSTRUCTIONS } from '../lib/folder-instructions.js';
import { buildRequest, defaultSettings, normalizeModel } from '../lib/harness.js';
import { contextMeter, summaryRequest } from '../lib/context-meter.js';
import { estimateTokens } from '../lib/arena.js';
import { copyAsCode } from '../lib/copy-as-code.js';
import { currentChat, exportJson, downloadChats } from '../lib/harness-history.js';

const model = normalizeModel({ id: 'sample/text', context_length: 8192, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['max_tokens', 'temperature'] });
const messages = [{ id: 'u', role: 'user', text: 'Plan a trip', files: [] }];
const chat = { id: 'chat', title: 'Travel', at: 1, pinned: false, lanes: [{ modelId: model.id, messages }] };
const passphrase = 'sample instruction passphrase';
const fresh = () => createFolder({ chats: [structuredClone(chat)], folders: [] }, 'Trips', 'f');
const request = state => buildRequest({ model, system: 'Be brief.', folderInstructions: state.folders.find(folder => folder.id === state.chats[0].folderId)?.instructions || '', messages }).body;
const makeVault = storage => createHistory({ storage, crypto: webcrypto, iterations: 100000 });

export const folderInstructionCases = [
  ['request order keeps folder first, chat prompt second, and conversation after both', () => {
    const body = buildRequest({ model, system: 'Be brief.', folderInstructions: '  Use metric units.  ', messages }).body;
    assert.deepEqual(body.messages, [{ role: 'system', content: 'Use metric units.' }, { role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Plan a trip' }]);
    assert.deepEqual(buildRequest({ model, folderInstructions: 'Use metric units.', messages }).body.messages.slice(0, 1), [{ role: 'system', content: 'Use metric units.' }]);
    assert.deepEqual(buildRequest({ model, system: folderSystems('Be brief.', 'Use metric units.'), messages }).body, { ...body, messages: body.messages });
  }],
  ['unset, empty and whitespace instructions keep the request and copied code byte-identical', () => {
    const original = { model, settings: defaultSettings(), system: 'Be brief.', messages };
    for (const value of [undefined, '', ' \n\t ']) {
      assert.equal(JSON.stringify(buildRequest({ ...original, folderInstructions: value })), JSON.stringify(buildRequest(original)));
      assert.deepEqual(copyAsCode({ ...original, folderInstructions: value }), copyAsCode(original));
      assert.equal(folderSystems(original.system, value), original.system);
    }
    assert.deepEqual(validateFolders([{ id: 'f', name: 'Trips', instructions: '   ' }]), [{ id: 'f', name: 'Trips' }]);
  }],
  ['moving in, out, between folders and deleting changes only subsequent request instructions', () => {
    let state = setFolderInstructions(fresh(), 'f', 'Use metric units.');
    const before = request(state);
    state = moveChat(state, 'chat', 'f');
    assert.equal(request(state).messages[0].content, 'Use metric units.');
    assert.deepEqual(request(moveChat(state, 'chat', null)), before);
    state = setFolderInstructions(createFolder(state, 'Work', 'work'), 'work', 'Answer formally.');
    assert.equal(request(moveChat(state, 'chat', 'work')).messages[0].content, 'Answer formally.');
    assert.deepEqual(request(deleteFolder(state, 'f')), before);
    assert.deepEqual(state.chats[0].lanes, chat.lanes);
  }],
  ['validation enforces 4,000 characters and immutable edits preserve folder names', () => {
    const state = fresh(), next = setFolderInstructions(state, 'f', 'x'.repeat(MAX_FOLDER_INSTRUCTIONS));
    assert.equal(next.folders[0].instructions.length, 4000);
    assert.equal(state.folders[0].instructions, undefined);
    assert.deepEqual(setFolderInstructions(next, 'f', ''), state);
    for (const instructions of [null, 4, {}, 'x'.repeat(4001)]) {
      assert.throws(() => setFolderInstructions(state, 'f', instructions), /4,000/);
      assert.throws(() => validateFolders([{ id: 'f', name: 'Trips', instructions }]), /4,000/);
    }
    assert.throws(() => setFolderInstructions(state, 'missing', 'Instructions'), /no longer/);
  }],
  ['encrypted persistence, locked history guard and continuation preserve instructions', async () => {
    const storage = memoryStorage(), vault = makeVault(storage);
    await assert.rejects(vault.setFolderInstructions('f', 'Denied'), /locked/);
    assert.equal(await storage.get(), null);
    await vault.create(passphrase); await vault.put(chat); await vault.createFolder('Trips');
    const id = vault.listFolders()[0].id;
    await vault.setFolderInstructions(id, 'Use metric units.'); await vault.moveChat(chat.id, id);
    const scope = { history: vault, chatId: chat.id };
    assert.equal(activeFolder(scope).instructions, 'Use metric units.');
    await vault.put({ ...chat, lanes: [{ ...chat.lanes[0], messages: [...messages, { id: 'a', role: 'assistant', text: 'Reply' }] }] });
    assert.equal(currentChat(chat.lanes, vault.get(chat.id)).folderId, id);
    const sealed = JSON.stringify(await storage.get());
    assert.ok(!sealed.includes('Use metric units.') && !sealed.includes('instructions'));
    vault.lock(); assert.equal(activeFolder(scope), null);
    await assert.rejects(vault.setFolderInstructions(id, 'Denied'), /locked/);
    await vault.unlock(passphrase);
    assert.equal(vault.listFolders()[0].instructions, 'Use metric units.');
    await vault.renameFolder(id, 'Travel'); assert.equal(activeFolder(scope).instructions, 'Use metric units.');
    await vault.forget(); assert.equal(activeFolder(scope), null); assert.equal(await storage.get(), null);
  }],
  ['instruction writes are atomic when browser storage fails', async () => {
    const storage = memoryStorage(), vault = makeVault(storage);
    await vault.create(passphrase); await vault.createFolder('Trips');
    const id = vault.listFolders()[0].id, before = await storage.get();
    storage.set = async () => { throw new Error('Storage full'); };
    await assert.rejects(vault.setFolderInstructions(id, 'Use metric units.'), /Storage full/);
    assert.equal(vault.listFolders()[0].instructions, undefined);
    assert.deepEqual(await storage.get(), before);
  }],
  ['export/import includes instructions, remaps collisions and preserves existing same-name instructions', async () => {
    const state = moveChat(setFolderInstructions(fresh(), 'f', 'Use metric units.'), chat.id, 'f');
    const parsed = parseFolderImport(exportJson(state.chats, { folders: state.folders }));
    assert.deepEqual(parsed, state);
    assert.deepEqual(parseFolderImport(exportJson([chat])), { chats: [chat], folders: [] });
    const collision = mergeFolderImport({ chats: [], folders: [{ id: 'f', name: 'Work' }] }, parsed, () => 'remapped');
    assert.equal(collision.folders[1].instructions, 'Use metric units.'); assert.equal(collision.chats[0].folderId, 'remapped');
    const matching = mergeFolderImport({ chats: [], folders: [{ id: 'held', name: 'TRIPS', instructions: 'Answer formally.' }] }, parsed, () => 'unused');
    assert.equal(matching.folders[0].instructions, 'Answer formally.'); assert.equal(matching.chats[0].folderId, 'held');
    const vault = makeVault(memoryStorage()); await vault.create(passphrase); await vault.importFolderHistory(parsed); vault.lock(); await vault.unlock(passphrase);
    assert.equal(activeFolder({ history: vault, chatId: chat.id }).instructions, 'Use metric units.');
    let downloaded;
    downloadChats(parsed.chats, 'json', { URL: { createObjectURL: blob => { downloaded = blob; return 'blob:export'; }, revokeObjectURL() {} }, document: { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } }, setTimeout: fn => fn() }, { folders: parsed.folders });
    assert.deepEqual(parseFolderImport(await downloaded.text()), parsed);
  }],
  ['copy as code includes the ordered system messages in all languages', () => {
    const samples = copyAsCode({ model, system: 'Chat instruction.', folderInstructions: 'Folder instruction.', messages });
    assert.equal(samples.error, '');
    for (const language of ['curl', 'typescript', 'python']) {
      assert.ok(samples[language].indexOf('Folder instruction.') < samples[language].indexOf('Chat instruction.'));
      assert.ok(samples[language].indexOf('Chat instruction.') < samples[language].indexOf('Plan a trip'));
    }
  }],
  ['context, cumulative counts, prompt cost and summary include both system messages', () => {
    const instructions = 'x'.repeat(4000), system = folderSystems('Be brief.', instructions);
    const base = contextMeter({ model, messages, system: 'Be brief.' });
    const withFolder = contextMeter({ model, messages, system });
    assert.equal(withFolder.tokens - base.tokens, 1006);
    assert.ok(estimateTokens(system.join('\n') + 'draft') > estimateTokens('Be brief.' + 'draft'));
    const reply = { role: 'assistant', text: 'Reply', model: model.id, contextSystem: system, usage: { prompt_tokens: 2000, completion_tokens: 2 } };
    assert.equal(contextMeter({ model, messages: [...messages, reply], system: folderSystems('Be brief.', instructions) }).tokens, 2008);
    assert.deepEqual(summaryRequest(model, messages, system).body.messages.slice(0, 2), [{ role: 'system', content: instructions }, { role: 'system', content: 'Be brief.' }]);
    assert.equal(contextMeter({ model: { ...model, context: 500 }, messages, system }).blocked, true);
  }],
];
