import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { ACCOUNT_GROUPS, ACCOUNT_SECTIONS, TASKS, menuTasks, GROUPS } from '../lib/site-map.js';
import { AccountNavigation, AccountPreview } from '../components/account/AccountViews.js';
import { dashboardSections, sectionFromHash, sectionHash, homeChecklist, homeSpend } from '../components/account/account-state.js';

test('one account map includes every section once in the intended groups', () => {
  assert.deepEqual(ACCOUNT_GROUPS.map(group => group.title), ['Home', 'Use', 'Agents', 'Money', 'Account']);
  const ids = ACCOUNT_GROUPS.flatMap(group => group.ids);
  assert.equal(new Set(ids).size, 27); // V86: Webhooks joins Account.
  assert.deepEqual(ACCOUNT_GROUPS.find(group => group.title === 'Account').ids, ['account-keys', 'account-export', 'teams', 'providers', 'settings', 'webhooks', 'keep']);
  assert.deepEqual(new Set(ids), new Set(ACCOUNT_SECTIONS.map(section => section.taskId)));
  assert.deepEqual(ACCOUNT_GROUPS.find(group => group.title === 'Money').ids, ['insights', 'account-activity', 'statements', 'account-payments', 'holders', 'spend', 'api-receipts']);
  for (const section of ACCOUNT_SECTIONS) assert.ok(TASKS.some(task => task.id === section.taskId));
  for (const group of GROUPS) assert.ok(menuTasks(group.id).length <= 9);
});

test('every legacy dashboard deep link selects its view; overview and unknown hashes select Home', () => {
  const legacy = ['playground','saved-routes','presets','characters','eval-lab','batch-studio','models','api-keys','agent-sessions','teams','skills','receipts','spend-watch','payments','holders','providers','settings'];
  assert.equal(dashboardSections.length, 23);
  for (const hash of legacy) {
    const title = sectionFromHash('#' + hash);
    assert.notEqual(title, 'Home', hash);
    assert.equal(sectionHash(title), hash);
    assert.ok(ACCOUNT_SECTIONS.some(section => section.href === '/dashboard/#' + hash));
  }
  for (const hash of ['', '#overview', '#home', '#missing']) assert.equal(sectionFromHash(hash), 'Home');
});

test('the rendered sidebar uses real links and marks only the current section', () => {
  for (const current of ['Home', 'Agents', 'Receipts']) {
    const html = renderToStaticMarkup(h(AccountNavigation, { current }));
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /aria-label="Account sections"/);
    for (const section of ACCOUNT_SECTIONS) assert.ok(html.includes(`href="${section.href}"`), section.title);
  }
});

test('sidebar navigation preserves modified clicks and routes dashboard clicks in place', () => {
  const chosen = [];
  const tree = AccountNavigation({ current: 'Home', onNavigate: title => chosen.push(title) });
  const link = tree.props.children[1].props.children[1];
  let prevented = 0;
  link.props.onClick({ button: 0, preventDefault: () => prevented++ });
  assert.deepEqual(chosen, ['Playground']); assert.equal(prevented, 1);
  for (const modifiers of [{button:1},{button:0,metaKey:true},{button:0,ctrlKey:true},{button:0,shiftKey:true},{button:0,altKey:true}]) link.props.onClick({...modifiers,preventDefault:()=>prevented++});
  assert.equal(prevented, 1);
});

test('signed-out previews render honest copy for every section without account figures', () => {
  for (const section of ACCOUNT_SECTIONS) {
    const html = renderToStaticMarkup(h(AccountPreview, { current: section.title }, h('button', null, 'Connect your key')));
    assert.ok(html.includes(section.description)); assert.ok(html.includes(section.start));
    assert.match(html, /Connect your key/);
    assert.doesNotMatch(html, /\b(?:demo|test|tested|mock|simulated|placeholder)\b|local[ -]build|\$\d/i);
  }
});

test('both pages use the same shell, key hook, and a single connect form', () => {
  for (const file of ['components/Dashboard.jsx', 'app/agents/Agents.jsx']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.match(source, /<AccountShell/); assert.match(source, /useAccountKey\(\)/);
    assert.doesNotMatch(source, /id="(?:signin-key|principal-key)"/);
  }
  const shell = fs.readFileSync(new URL('../components/account/AccountShell.jsx', import.meta.url), 'utf8');
  assert.match(shell, /!apiKey && <AccountPreview/); assert.match(shell, /<AccountConnect/);
  const connect = fs.readFileSync(new URL('../components/account/AccountConnect.jsx', import.meta.url), 'utf8');
  assert.match(connect, /walletApiKey/); assert.match(connect, /href="\/docs\/#payments"/);
  assert.match(connect, /api\('\/api\/v1\/key'/);
  assert.doesNotMatch(connect, /\b(?:demo|test|tested|mock|simulated|placeholder)\b|local[ -]build/i);
});

test('the Home checklist hides completed steps based on existing account data', () => {
  const empty = {credits:{total_credits:0,total_usage:0},keys:[],receipts:[]};
  assert.deepEqual(homeChecklist(empty, []).map(step => step.id), ['funds','key','chat','agent']);
  const complete = {me:{hash:'principal'},credits:{total_credits:10,total_usage:1},keys:[{hash:'principal'}],receipts:[]};
  assert.deepEqual(homeChecklist(complete, [{has_policy:true,caps:{day:1}}]), []);
  assert.deepEqual(homeChecklist({...empty,me:{hash:'principal'},credits:{total_credits:10,total_usage:0}}, [{has_policy:true,caps:{day:0}}]).map(step => step.id), ['chat','agent']);
  assert.ok(homeChecklist(empty, [{has_policy:false,caps:{day:10}}]).some(step => step.id === 'agent'));
  assert.ok(!homeChecklist({...empty,receipts:[{id:'call'}]}, []).some(step => step.id === 'chat'));
});

test('Home spend uses the full daily report and Monday UTC, including Sunday and year boundaries', () => {
  assert.equal(homeSpend(null), null);
  const report = {as_of:'2026-10-04T23:59:59Z',scope:'key',totals:{today_usd:8},series:[{date:'2026-09-27',cost_usd:100},{date:'2026-09-28',cost_usd:2},{date:'2026-10-04',cost_usd:8},{date:'2026-10-05',cost_usd:100}]};
  assert.deepEqual(homeSpend(report), {today:8,week:10,scope:'key'});
  assert.equal(homeSpend({...report,as_of:'2026-10-05T00:00:00Z'}).week,100);
  assert.equal(homeSpend({...report,as_of:'2027-01-01T00:00:00Z',series:[{date:'2026-12-27',cost_usd:20},{date:'2026-12-28',cost_usd:3},{date:'2027-01-01',cost_usd:4}]}).week,7);
});

test('account key observers share one tab-session key and disconnect removes it', async () => {
  const { storeAccountKey, observeAccountKey } = await import('../components/account/useAccountKey.js');
  const { keyStore } = await import('../lib/api.js');
  const saved = Object.fromEntries(['window','sessionStorage','localStorage'].map(name => [name, globalThis[name]]));
  const session = new Map(); const persistent = new Map([[keyStore,'old']]);
  const storage = map => ({ getItem:key=>map.get(key), setItem:(key,value)=>map.set(key,value), removeItem:key=>map.delete(key) });
  globalThis.window = new EventTarget(); globalThis.sessionStorage = storage(session); globalThis.localStorage = storage(persistent);
  try {
    const first = []; const second = [];
    const stopFirst = observeAccountKey(value => first.push(value)); const stopSecond = observeAccountKey(value => second.push(value));
    storeAccountKey('fixture-key');
    assert.equal(session.get(keyStore), 'fixture-key'); assert.ok(!persistent.has(keyStore));
    assert.deepEqual(first, ['', 'fixture-key']); assert.deepEqual(second, first);
    const restored = []; const stopRestored = observeAccountKey(value => restored.push(value)); assert.deepEqual(restored, ['fixture-key']);
    storeAccountKey(''); assert.ok(!session.has(keyStore)); assert.equal(first.at(-1),''); assert.equal(second.at(-1),'');
    stopFirst(); storeAccountKey('next-fixture'); assert.equal(first.at(-1),''); assert.equal(second.at(-1),'next-fixture');
    globalThis.sessionStorage = {getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');},removeItem(){throw new Error('unavailable');}};
    storeAccountKey('memory-fixture'); assert.equal(second.at(-1),'memory-fixture');
    storeAccountKey(''); assert.equal(second.at(-1),''); stopSecond(); stopRestored();
  } finally { for (const [name,value] of Object.entries(saved)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
});
