// J183: shared Node/Bun cases, no service requirements.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { projectFields, effectiveProject, projectHeaders, projectStream, projectFolder, restoreChatProject, setFolderProject, projectBudgetRefusal } from '../lib/chat-projects.js';
import { createFolder, moveChat, deleteFolder, validateFolders, parseFolderImport, mergeFolderImport } from '../lib/chat-folders.js';
import { currentChat, exportJson, exportMarkdown } from '../lib/harness-history.js';
import { copyAsCode } from '../lib/copy-as-code.js';
import { normalizeModel } from '../lib/harness.js';
import { createHarnessLimits } from '../lib/harness-limits.js';
import { fundingError } from '../lib/add-funds.js';
const model = normalizeModel({ id: 'sample/text', context_length: 8192, architecture: { input_modalities: ['text'], output_modalities: ['text'] } });
const chat = { id: 'chat', title: 'Research', at: 1, pinned: false, lanes: [{ modelId: model.id, messages: [{ id: 'u', role: 'user', text: 'Explain gravity', files: [] }] }] };
const makeVault = storage => createHistory({ storage, crypto: webcrypto, iterations: 100000 });
const passphrase = 'sample project passphrase';
export const chatProjectCases = [
  ['no selection preserves every existing request byte and leaves the key default alone', async () => {
    const options = { body: { messages: [] }, headers: { 'x-title': 'Chat' }, key: 'sample-key' };
    await projectStream(async received => { assert.equal(received, options); }, () => null)(options);
    assert.deepEqual(projectFields({}), {}); assert.deepEqual(projectHeaders(null), {});
    assert.equal(effectiveProject({}), null);
    assert.equal(projectFolder({ history: { unlocked: false } }), null);
    assert.deepEqual(parseFolderImport(exportJson([chat])), { chats: [chat], folders: [] });
  }],
  ['send, retry, continuation, tool reply and summary use the same tag without changing bodies or auth', async () => {
    const headers = { 'x-title': 'Chat', 'x-anyroute-lane': 'attested' };
    for (const messageId of ['send', 'retry', 'continue', 'tool', 'summary']) {
      const options = { messageId, body: { model: model.id, messages: [] }, headers, key: 'sample-key' };
      await projectStream(async received => {
        assert.equal(received.body, options.body); assert.equal(received.key, options.key);
        assert.deepEqual(received.headers, { ...headers, 'X-Anyroute-Project': 'research' });
      }, () => 'Research')(options);
    }
    assert.deepEqual(headers, { 'x-title': 'Chat', 'x-anyroute-lane': 'attested' });
  }],
  ['folder defaults follow moves and edits while explicit chat choices take priority', () => {
    let state = setFolderProject(createFolder({ chats: [chat], folders: [] }, 'Work', 'f'), 'f', 'TEAM');
    state = moveChat(state, chat.id, 'f');
    const resolve = value => effectiveProject(value.chats[0], value.folders.find(f => f.id === value.chats[0].folderId));
    assert.equal(resolve(state), 'team');
    assert.equal(effectiveProject({ project: 'research' }, state.folders[0]), 'research');
    assert.equal(effectiveProject({ project: null }, state.folders[0]), 'team');
    assert.equal(resolve(setFolderProject(state, 'f', 'new-team')), 'new-team');
    assert.equal(resolve(moveChat(state, chat.id, null)), null);
    assert.equal(resolve(deleteFolder(state, 'f')), null);
    assert.throws(() => setFolderProject(state, 'missing', 'work'), /no longer/);
  }],
  ['names enforce the router grammar and invalid imports are rejected', () => {
    assert.deepEqual(projectFields({ project: 'TEAM.v2_1-a' }), { project: 'team.v2_1-a' });
    assert.equal(projectFields({ project: 'A'.repeat(48) }).project.length, 48);
    for (const project of ['', 'x'.repeat(49), 'bad/name', 'a\nb', 'two words', 'café', {}, 4]) {
      assert.throws(() => projectFields({ project }), /Project must/);
      assert.throws(() => validateFolders([{ id: 'f', name: 'Work', project }]), /Project must/);
      assert.throws(() => parseFolderImport(exportJson([{ ...chat, project }])));
    }
  }],
  ['chat overrides and folder defaults survive encrypted persistence, clearing, lock and export/import', async () => {
    const storage = memoryStorage(), vault = makeVault(storage);
    await assert.rejects(vault.setFolderProject('f', 'work'), /locked/);
    await vault.create(passphrase); await vault.put({ ...chat, project: 'research' }); await vault.createFolder('Work');
    const id = vault.listFolders()[0].id;
    await vault.setFolderProject(id, 'team'); await vault.moveChat(chat.id, id);
    await vault.put({ ...chat, project: 'research' });
    const scope = { history: vault, chatId: chat.id };
    assert.equal(projectFolder(scope).project, 'team');
    const lanes = restoreChatProject(vault.get(chat.id), chat.lanes);
    assert.equal(lanes[0].project, 'research');
    assert.equal(currentChat(lanes, vault.get(chat.id)).project, 'research');
    assert.equal(currentChat(lanes, vault.get(chat.id)).folderId, id);
    const sealed = JSON.stringify(await storage.get());
    assert.ok(!sealed.includes('research') && !sealed.includes('project'));
    vault.lock(); assert.equal(projectFolder(scope), null);
    await vault.unlock(passphrase); assert.equal(vault.get(chat.id).project, 'research');
    const incoming = parseFolderImport(exportJson([vault.get(chat.id)], { folders: vault.listFolders() }));
    assert.equal(incoming.chats[0].project, 'research'); assert.equal(incoming.folders[0].project, 'team');
    assert.match(exportMarkdown(incoming.chats), /Project: research/);
    const target = makeVault(memoryStorage()); await target.create(passphrase); await target.importFolderHistory(incoming); target.lock(); await target.unlock(passphrase);
    assert.equal(target.get(chat.id).project, 'research'); assert.equal(target.listFolders()[0].project, 'team');
    await vault.put({ ...chat, project: null });
    assert.equal(vault.get(chat.id).project, null);
    assert.equal(effectiveProject(vault.get(chat.id), projectFolder(scope)), 'team');
    await vault.setFolderProject(id, null); assert.equal(effectiveProject(vault.get(chat.id), projectFolder(scope)), null);
    await vault.forget(); assert.equal(await storage.get(), null);
  }],
  ['folder merges retain imported defaults and preserve an existing same-name default', () => {
    const incoming = { chats: [{ ...chat, folderId: 'f', project: 'research' }], folders: [{ id: 'f', name: 'Work', project: 'team' }] };
    const collision = mergeFolderImport({ chats: [], folders: [{ id: 'f', name: 'Other' }] }, incoming, () => 'remapped');
    assert.equal(collision.folders[1].project, 'team'); assert.equal(collision.chats[0].folderId, 'remapped');
    const same = mergeFolderImport({ chats: [], folders: [{ id: 'old', name: 'WORK', project: 'existing' }] }, incoming, () => 'unused');
    assert.equal(same.folders[0].project, 'existing'); assert.equal(same.chats[0].project, 'research');
  }],
  ['storage failure leaves folder defaults unchanged', async () => {
    const storage = memoryStorage(), vault = makeVault(storage);
    await vault.create(passphrase); await vault.createFolder('Work'); const id = vault.listFolders()[0].id;
    storage.set = async () => { throw new Error('Storage full'); };
    await assert.rejects(vault.setFolderProject(id, 'team'), /Storage full/);
    assert.equal(vault.listFolders()[0].project, undefined);
  }],
  ['copy as code includes the effective project tag in all languages and omits it when absent', () => {
    for (const [choice, folder] of [[{ project: 'research' }, { project: 'team' }], [{}, { project: 'team' }]]) {
      const project = effectiveProject(choice, folder);
      const samples = copyAsCode({ model, messages: chat.lanes[0].messages, headers: projectHeaders(project) });
      for (const language of ['curl', 'typescript', 'python']) { assert.match(samples[language], /X-Anyroute-Project/); assert.ok(samples[language].includes(project)); }
    }
    const samples = copyAsCode({ model, messages: chat.lanes[0].messages, headers: projectHeaders(null) });
    for (const language of ['curl', 'typescript', 'python']) assert.ok(!samples[language].includes('X-Anyroute-Project'));
  }],
  ['project budget refusals retain the router wording and bypass the funding action', async () => {
    const error = Object.assign(new Error("Project 'research' has used $1 of its $1 budget this month"), { type: 'project_budget_exceeded', status: 402 });
    assert.equal(projectBudgetRefusal(error), true); assert.equal(fundingError(error), false);
    assert.equal(fundingError({ status: 402, type: 'insufficient_balance' }), true);
    const send = projectStream(async () => { throw error; }, () => 'research');
    await assert.rejects(send({ body: {} }), received => received === error);
  }],
  ['existing limits freeze the project through approval retries and never use the parent fallback', async () => {
    let choice = 'research'; const calls = [];
    const expires_at = new Date(Date.now() + 60000).toISOString();
    const session = { id: 'session', key: 'child-key', key_hash: 'child-hash', parentHash: 'parent-hash', ready: true };
    const limits = createHarnessLimits({ storage: { getItem: () => JSON.stringify(session) }, pollMs: 1000,
      request: async url => ({ data: url.endsWith('/approve') ? { status: 'approved', expires_at } : {} }),
      stream: async options => {
        calls.push(options);
        if (!options.headers['x-agent-approval']) throw Object.assign(new Error('Ask first'), { type: 'agent_approval_required', metadata: { approval_id: 'approval', expires_at } });
        return 'reply';
      },
    });
    await limits.connect('parent-key', 'parent-hash');
    const send = projectStream(limits.streamChat, () => choice);
    const pending = send({ messageId: 'reply', body: { messages: [] }, headers: {} });
    for (let n = 0; n < 20 && !limits.get().approvals.length; n++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(limits.get().approvals.length, 1); choice = 'next';
    await limits.decide('reply', 'approve'); assert.equal(await pending, 'reply');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.headers['X-Anyroute-Project'] === 'research' && call.key === 'child-key'));
    assert.equal(calls[1].headers['x-agent-approval'], 'approval');
  }],
];
