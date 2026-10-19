// J181: browser-only cases shared by Bun and the site's test runner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandActions, commandDestination, commandHref, consumeCommand, paletteContext, registerCommand, rotationKeyChoices, runPageCommand } from '../lib/command-palette.js';
import { actionHref, agentChoices, searchAll, SITE_ACTIONS } from '../lib/site-actions.js';
import { isSearchShortcut } from '../lib/site-search.js';
import { COMPARE_STORE } from '../lib/model-compare.js';
const caller = { hash: 'sample-key', management: true, scope: 'full' };
const actions = (context = {}, access = { signedIn: true, caller }) => commandActions(context, access);
const find = (id, rows = actions()) => rows.find(row => row.command === id);
export const commandPaletteCases = [
  ['adds the requested actions and every existing inbox group without changing existing actions', () => {
    const ids = actions({ pathname: '/harness/', ready: ['print-chat', 'continue-answer'] }).map(row => row.command);
    for (const id of ['stop-all', 'resume-all', 'rotate-key', 'duplicate-agent', 'compare-models', 'your-images', 'print-chat', 'continue-answer', 'account-checkup', 'notifications', 'telegram', 'inbox-approvals', 'inbox-money', 'inbox-agents', 'inbox-security', 'inbox-models', 'inbox-other']) assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(SITE_ACTIONS.some(row => row.id === 'stop-agent'));
  }],
  ['context controls print, continuation and model watching; no background or unavailable calls run', () => {
    assert.equal(find('print-chat'), undefined);
    assert.equal(find('continue-answer'), undefined);
    assert.equal(find('watch-model'), undefined);
    assert.equal(find('print-chat', actions({ pathname: '/harness/' })).disabled, true);
    assert.equal(find('print-chat', actions({ pathname: '/harness/', ready: ['print-chat'] })).disabled, false);
    assert.equal(find('continue-answer', actions({ pathname: '/harness/' })), undefined);
    assert.equal(find('continue-answer', actions({ pathname: '/harness/', ready: ['continue-answer'] })).disabled, false);
    assert.equal(find('watch-model', actions({ pathname: '/models/model/', currentModel: 'sample/model' })).disabled, true);
    assert.equal(find('watch-model', actions({ currentModel: 'sample/model', ready: ['watch-model'] })).disabled, false);
    assert.equal(find('resume-all', actions({ pathname: '/agents/' })).disabled, true);
    assert.equal(find('resume-all', actions({ pathname: '/agents/', ready: ['resume-all'] })).disabled, false);
    assert.equal(runPageCommand('unregistered'), false);
  }],
  ['signed-out, read-only, inference, team and management access keep the page permission hints', () => {
    const out = actions({}, { signedIn: false });
    for (const id of ['stop-all', 'resume-all', 'rotate-key', 'duplicate-agent', 'notifications', 'telegram']) {
      assert.equal(find(id, out).signIn, true); assert.equal(find(id, out).disabled, false);
    }
    for (const scope of ['read', 'inference']) {
      const rows = actions({}, { signedIn: true, caller: { ...caller, scope } });
      for (const id of ['stop-all', 'resume-all', 'rotate-key', 'duplicate-agent', 'notifications', 'telegram']) assert.equal(find(id, rows).disabled, true, id);
      assert.equal(find('inbox-money', rows).disabled, false);
    }
    const team = actions({}, { signedIn: true, caller: { ...caller, management: false, team: 'sample-team' } });
    assert.equal(find('stop-all', team).disabled, false);
    assert.match(find('notifications', team).note, /management key/);
    assert.match(find('rotate-key', actions({}, { signedIn: true })).note, /Checking/);
    assert.match(find('rotate-key', actions({}, { signedIn: true, accessError: true })).note, /could not be checked/);
    assert.equal(agentChoices([{ key_hash: 'sample-agent', approval_only: true }], find('duplicate-agent'))[0].disabled, true);
  }],
  ['synonyms rank Stop all for pause and kill switch, and Print this chat for pdf', () => {
    const rows = actions({ pathname: '/harness/', ready: ['print-chat'] });
    for (const query of ['pause', 'pause all', 'kill switch', 'stop all']) assert.equal(searchAll(query, { actions: [...rows, ...SITE_ACTIONS] })[0].command, 'stop-all', query);
    assert.equal(searchAll('pdf', { actions: [...rows, ...SITE_ACTIONS] })[0].command, 'print-chat');
    assert.equal(searchAll('resume all', { actions: rows })[0].command, 'resume-all');
  }],
  ['destinations select the existing page and dialog and never accept secrets as targets', () => {
    assert.equal(commandDestination(find('stop-all')), '/agents/?command=stop-all');
    assert.equal(commandDestination(find('resume-all')), '/agents/?command=resume-all');
    assert.equal(actionHref(find('duplicate-agent'), 'sample-agent'), '/agents/?command=duplicate-agent&target=sample-agent&agent=sample-agent');
    assert.equal(actionHref(find('rotate-key'), 'sample-key'), '/dashboard/?command=rotate-key&target=sample-key#api-keys');
    assert.equal(commandDestination(find('inbox-money')), '/dashboard/?kinds=money#inbox');
    assert.equal(commandDestination(find('notifications')), '/dashboard/#notifications');
    assert.equal(commandDestination(find('telegram')), '/agents/#telegram');
    assert.equal(commandDestination(find('account-checkup')), '/dashboard/#checkup');
    assert.equal(commandHref('/models/model/?id=sample%2Fmodel', 'watch-model'), '/models/model/?id=sample%2Fmodel&command=watch-model');
    for (const bad of ['sk-sample-value', '../bad', 'two words', '', '<script>']) assert.equal(actionHref(find('rotate-key'), bad), null);
  }],
  ['comparison reuses current models and the existing last two picks without writing storage', () => {
    const storage = { getItem(key) { assert.equal(key, COMPARE_STORE); return '["sample/first","sample/second","sample/third"]'; } };
    const url = { pathname: '/models/model/', search: '?id=sample%2Fcurrent' };
    let context = paletteContext(url, storage);
    assert.deepEqual(context.models, ['sample/current', 'sample/second']);
    assert.equal(commandDestination(find('compare-models', actions(context))), '/models/compare/?ids=sample%2Fcurrent,sample%2Fsecond');
    const unregister = registerCommand('chat-context', () => {}, { models: ['sample/chat-a', 'sample/chat-b'] });
    try { assert.deepEqual(paletteContext({ pathname: '/harness/', search: '' }, storage).models, ['sample/chat-a', 'sample/chat-b']); }
    finally { unregister(); }
    assert.deepEqual(paletteContext({ pathname: '/', search: '' }, storage).models, ['sample/second', 'sample/third']);
    assert.equal(paletteContext({ pathname: '/models/model/', search: '?id=sk-sample-value' }).currentModel, null);
  }],
  ['a destination is consumed once only when the matching control and target are ready', () => {
    const location = { pathname: '/dashboard/', search: '?command=rotate-key&target=sample-key&keep=value', hash: '#api-keys' };
    const calls = [], history = { state: null, replaceState(...args) { calls.push(args); location.search = new URL(args[2], 'https://anyroute.tech').search; } };
    assert.equal(consumeCommand(location, history, 'duplicate-agent', 'sample-key'), false);
    assert.equal(consumeCommand(location, history, 'rotate-key', 'other-key'), false);
    assert.equal(consumeCommand(location, history, 'rotate-key', 'sample-key'), true);
    assert.equal(consumeCommand(location, history, 'rotate-key', 'sample-key'), false);
    assert.deepEqual(calls, [[null, '', '/dashboard/?keep=value#api-keys']]);
  }],
  ['page controls run only on selection and stale cleanup cannot remove a newer control', () => {
    let count = 0;
    const old = registerCommand('sample-command', () => count++);
    const current = registerCommand('sample-command', () => count += 2);
    old(); assert.equal(count, 0);
    assert.equal(runPageCommand('sample-command'), true); assert.equal(count, 2);
    current(); assert.equal(runPageCommand('sample-command'), false); assert.equal(count, 2);
  }],
  ['key picker checks the existing rotation permission and reports unavailable or replaced keys', async () => {
    const calls = [];
    const request = async path => {
      calls.push(path);
      if (path === '/api/v1/keys') return { data: [{ hash: 'sample-key', name: 'Main' }, { hash: 'sample-old', disabled: true }] };
      return { data: null };
    };
    const rows = await rotationKeyChoices(request, caller);
    assert.deepEqual(rows.map(row => [row.id, row.disabled]), [['sample-key', false], ['sample-old', true]]);
    assert.ok(calls.includes('/api/v1/keys/sample-key/rotation'));
    assert.deepEqual(await rotationKeyChoices(() => { throw Error('must not request'); }, { ...caller, scope: 'read' }), []);
    const failed = await rotationKeyChoices(async path => { if (path === '/api/v1/keys') return { data: [{ hash: 'sample-key' }] }; throw Error('off'); }, caller);
    assert.equal(failed[0].disabled, true);
    const team = await rotationKeyChoices(async path => { if (path === '/api/v1/keys') throw Error('forbidden'); return { data: null }; }, { ...caller, management: false, team: 'sample-team' });
    assert.equal(team[0].disabled, false);
  }],
  ['command shortcuts work in Chat, preserve open dialogs and ignore repeated shortcuts', () => {
    for (const event of [{ key: 'k', metaKey: true }, { key: 'K', ctrlKey: true }]) {
      assert.equal(isSearchShortcut(event, { pathname: '/harness/', editable: true }), true);
      assert.equal(isSearchShortcut(event, { pathname: '/harness/', dialogOpen: true }), false);
    }
    assert.equal(isSearchShortcut({ key: 'k', ctrlKey: true, repeat: true }, { pathname: '/harness/' }), false);
    assert.equal(isSearchShortcut({ key: '/' }, { pathname: '/harness/' }), false); // Chat keeps / for itself
    assert.equal(isSearchShortcut({ key: 'k', metaKey: true, defaultPrevented: true }, { pathname: '/' }), false);
  }],
  ['keyboard flow selects an action with arrows and Enter, goes back with Escape and refuses held Enter', () => {
    // Exercise the palette's actual handler, including its focus and repeat guards.
    const source = readFileSync(new URL('../components/nav/SiteSearch.jsx', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('  const keys = event => {'), source.indexOf('  const listed ='));
    const rows = actions();
    const create = new Function('rows', 'phase', 'step', `
      let selected = 0;
      const calls = [], input = { current: { focus() { calls.push('focus'); } } };
      const list = rows, results = rows, choices = rows;
      const setSelected = update => { selected = update(selected); };
      const chooseResult = row => calls.push(row.command);
      const chooseChoice = row => calls.push(row.command);
      const close = () => calls.push('close'), back = () => calls.push('back');
      const submitReceipt = () => calls.push('receipt');
      ${handler}
      return { calls, press(key, repeat = false) { keys({ key, repeat, target: input.current, preventDefault() { calls.push('prevent'); } }); } };
    `);
    const flow = create(rows, 'list', null);
    flow.press('ArrowDown'); flow.press('Enter');
    assert.equal(flow.calls.at(-1), 'resume-all');
    flow.press('ArrowUp'); flow.press('Enter');
    assert.equal(flow.calls.at(-1), 'stop-all');
    flow.press('ArrowUp'); flow.press('Enter');
    assert.equal(flow.calls.at(-1), rows.at(-1).command);
    flow.press('Enter', true); assert.equal(flow.calls.at(-1), 'prevent');
    const pick = create(rows, 'pick', { action: rows[0] });
    pick.press('Escape'); assert.equal(pick.calls.at(-1), 'back');
    pick.press('Enter'); assert.equal(pick.calls.at(-1), 'stop-all');
    const destination = commandDestination(rows[0]);
    assert.equal(new URL(destination, 'https://anyroute.tech').searchParams.get('command'), 'stop-all');
  }],
  ['destination pages reuse existing controls and wait for their readiness guards', () => {
    const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.match(read('components/AgentStopAll.jsx'), /usePageCommand\('stop-all', \(\) => run\('stop-all'\), allowed && !!eligible.length && !busy && !disabled\)/);
    assert.match(read('components/AgentStopAll.jsx'), /confirmAllStops\(action, preset, eligible.length, text => window.confirm\(text\), request\)/);
    assert.match(read('components/agents/DuplicateAgent.jsx'), /usePageCommand\('duplicate-agent'.*setName\(duplicateName\(agent.name\)\); setOpen\(true\);.*agent.key_hash/);
    assert.match(read('components/account/KeyRotation.jsx'), /usePageCommand\('rotate-key'.*setSelected\(rotationKey\).*canRotateKey/);
    assert.match(read('components/harness/PrintChat.jsx'), /usePageCommand\('print-chat', print, available && !busy && !pending\)/);
    assert.match(read('components/harness/YourImages.jsx'), /usePageCommand\('your-images', \(\) => setOpen\(true\), !checking\)/);
    assert.match(read('components/commands/ChatCommands.jsx'), /continueReply\(lane.id, reply.id\).*?!busy && canContinue\(reply\)/);
    assert.match(read('components/model-watch/ModelWatchButton.jsx'), /usePageCommand\('watch-model'.*change\(model.id, true\).*!!key && !!value && !busy/);
    assert.match(read('app/agents/TelegramLink.jsx'), /id="telegram"/);
    assert.match(read('components/commands/usePageCommand.js'), /if \(!ready\) return/);
    assert.match(read('components/commands/usePageCommand.js'), /consumeCommand\(window.location, window.history, id, target\)/);
    assert.match(read('components/harness/HistoryTools.jsx'), /if \(e.defaultPrevented\) return/);
    assert.match(read('components/nav/SiteSearch.jsx'), /row.command && !row.pick && context.ready\?\.includes\(row.command\)/);
    assert.match(read('components/CommandPaletteDocs.jsx'), /id="command-palette"/);
  }],
];
