import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api } from '../lib/api.js';
import { CHECKUP_PREFIX, accountCheckupItems, readAccountCheckup, readCheckupDismissed, writeCheckupDismissed, visibleCheckupItems } from '../lib/account-checkup.js';
import { checkupTarget, checkupControl } from '../lib/account-checkup-target.js';
import { agentLink, focusSelector } from '../lib/site-actions.js';
const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const key = patch => ({ hash, name: 'Worker', scope: 'account', disabled: false, management: false, expires_at: null, limit: null, allowed_ips: null, last_used: null, ...patch });
const state = patch => ({ workspace: { me: key(), keys: [] }, agents: [], ...patch });
const ids = input => accountCheckupItems(input).map(row => row.id);
const storage = () => { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }; };

test('J177 Telegram and alert checks require known state and configured features', () => {
  for (const linked of [undefined, true]) assert.ok(!ids(state({ telegram: { linked } })).includes('telegram'));
  assert.ok(ids(state({ telegram: { linked: false } })).includes('telegram'));
  for (const enabled of [false, undefined]) assert.ok(!ids(state({ balance: { enabled, low_balance_usd: null } })).includes('balance'));
  assert.ok(ids(state({ balance: { enabled: true, low_balance_usd: null } })).includes('balance'));
  for (const threshold of [0, 2]) assert.ok(!ids(state({ balance: { enabled: true, low_balance_usd: threshold } })).includes('balance'));
  assert.ok(ids(state({ security: { enabled: false } })).includes('security'));
  for (const security of [undefined, { enabled: true }]) assert.ok(!ids(state({ security })).includes('security'));
});
test('J177 muted notice channels link to existing notification controls', () => {
  const notifications = { channels: { low_balance: { inbox: false, telegram: false }, security_alerts: { inbox: false, telegram: false } } };
  const items = accountCheckupItems(state({ balance: { enabled: true, low_balance_usd: 2 }, security: { enabled: true }, notifications }));
  for (const id of ['balance', 'security']) assert.equal(checkupTarget(new URL(items.find(row => row.id === id).href, 'https://example.invalid').search).tab, 'Notifications');
  notifications.channels.low_balance.inbox = true;
  assert.ok(!ids(state({ balance: { enabled: true, low_balance_usd: 2 }, notifications })).includes('balance'));
});
test('J177 expiry and budget checks include zero caps and ignore expired or disabled keys', () => {
  assert.deepEqual(ids(state()), [`expiry:${hash}`, `limit:${hash}`]);
  for (const limit of [0, '0', 2]) assert.ok(!ids({ workspace: { me: key({ limit }) } }).includes(`limit:${hash}`));
  for (const patch of [{ disabled: true }, { expires_at: '2000-01-01T00:00:00Z' }]) assert.equal(accountCheckupItems({ workspace: { me: key(patch) } }).length, 0);
  assert.equal(accountCheckupItems({ workspace: { me: key({ expires_at: '2099-01-01T00:00:00Z', limit: 1 }) } }).length, 0);
  assert.equal(accountCheckupItems(state({ workspace: { me: key(), keys: [key()] } })).length, 2);
  assert.ok(!ids(state({ workspace: { me: key(), keys: [key({ hash: other })], keysError: 'unavailable' } })).includes(`expiry:${other}`));
});
test('J177 IP suggestions require a used management key without a list and do not claim location evidence', () => {
  const check = patch => accountCheckupItems({ workspace: { me: key(patch) } }).find(row => row.id === `ip:${hash}`);
  const suggestion = check({ management: true, last_used: '2026-10-01T00:00:00Z' });
  assert.equal(suggestion.suggestion, true); assert.doesNotMatch(suggestion.sentence, /many places|locations/);
  for (const patch of [{ management: false, last_used: '2026-10-01' }, { management: true }, { management: true, last_used: '2026-10-01', allowed_ips: ['192.0.2.1'] }]) assert.equal(check(patch), undefined);
});
test('J177 agent daily cap and hours suggestions respect inherited rules, approval visibility and active keys', () => {
  const agent = { key_hash: hash, name: 'Worker', caps: {}, policies: [] };
  const check = patch => ids(state({ agents: [{ ...agent, ...patch }] })).filter(id => id.startsWith('daily:') || id.startsWith('hours:'));
  assert.deepEqual(check({}), [`daily:${hash}`, `hours:${hash}`]);
  for (const per_day_usd of [0, '0', 2]) assert.deepEqual(check({ caps: { per_day_usd } }), [`hours:${hash}`]);
  for (const policy of [{ caps: { per_day_usd: 0 }, work_hours: { timezone: 'UTC' } }, { caps: { per_day_usd: 1 }, windows: [{ days: [1], start: '09:00', end: '17:00' }] }]) assert.deepEqual(check({ policies: [{ inherited: true, playbook_id: 'shared-rules', policy }] }), []);
  assert.deepEqual(check({ approval_only: true }), []); assert.deepEqual(check({ policies: undefined }), []); assert.deepEqual(check({ key_hash: other }), []);
  assert.equal(accountCheckupItems(state({ workspace: { me: key({ disabled: true }) }, agents: [agent] })).length, 0);
});
test('J177 every fix resolves to an existing control or selected agent rulebook', () => {
  const input = state({ workspace: { me: key({ management: true, last_used: '2026-10-01' }) }, telegram: { linked: false }, balance: { enabled: true, low_balance_usd: null }, security: { enabled: false }, agents: [{ key_hash: hash, policies: [] }] });
  for (const item of accountCheckupItems(input)) {
    const url = new URL(item.href, 'https://example.invalid');
    if (url.pathname === '/agents/') { assert.equal(agentLink(url.search).agent, hash); assert.equal(agentLink(url.search).focus, item.id.startsWith('daily:') ? 'day' : 'hours'); assert.ok(focusSelector(agentLink(url.search).focus, 'rulebook')); }
    else { const target = checkupTarget(url.search); assert.ok(target); if (target.hash) assert.equal(target.hash, hash); }
  }
  for (const search of ['?checkup=unknown', '?checkup=expiry&checkup_key=sk-ar-v1-secret', '?checkup=ip&checkup_key=../invalid', '?checkup=toString']) assert.equal(checkupTarget(search), null);
  const field = {}; assert.equal(checkupControl({ querySelector: selector => { assert.equal(selector, '#key-limits-budget'); return field; } }, { hash, control: 'limit' }), field);
  assert.equal(checkupControl({ querySelectorAll: () => [{ textContent: 'Security alerts', closest: () => ({ querySelector: () => field }) }] }, { title: 'Security alerts' }), field);
});
test('J177 dismiss, restore, account separation, corrupt and denied browser storage', () => {
  const store = storage(), items = accountCheckupItems(state());
  assert.equal(writeCheckupDismissed(store, hash, [items[0].id]), true);
  assert.deepEqual(visibleCheckupItems(items, readCheckupDismissed(store, hash)), [items[1]]);
  assert.deepEqual(readCheckupDismissed(store, other), []);
  writeCheckupDismissed(store, hash, []); assert.equal(visibleCheckupItems(items, readCheckupDismissed(store, hash)).length, 2);
  store.setItem(CHECKUP_PREFIX + hash, '{'); assert.deepEqual(readCheckupDismissed(store, hash), []);
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.deepEqual(readCheckupDismissed(denied, hash), []); assert.equal(writeCheckupDismissed(denied, hash, ['telegram']), false);
});
test('J177 reader uses existing GET APIs with Bearer auth, no mutation and no credentials in URLs', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(url.includes('low-balance') ? { enabled: true, low_balance_usd: null } : url.includes('notifications') ? { data: { channels: {} } } : url.includes('telegram') ? { data: { linked: false } } : { data: { enabled: false } }); };
  try {
    const result = await readAccountCheckup((path, options) => api(path, { ...options, key: 'fixture-key' }), state());
    assert.deepEqual(result.errors, []); assert.equal(calls.length, 4);
    assert.ok(calls.every(({ url, options }) => options.method === 'GET' && options.headers.authorization === 'Bearer fixture-key' && !url.includes('fixture-key') && !options.body));
  } finally { globalThis.fetch = previous; }
});
test('J177 signed-out and read-only checkup readers are refused without any requests', async () => {
  let calls = 0; const request = async () => { calls++; };
  await assert.rejects(readAccountCheckup(request), { status: 401 });
  await assert.rejects(readAccountCheckup(request, { workspace: { me: key({ scope: 'read' }) } }), { status: 403 });
  assert.equal(calls, 0); assert.deepEqual(accountCheckupItems({ workspace: { me: key({ scope: 'read' }) } }), []);
});
test('J177 denied, missing, malformed and aborted reads stay unknown', async () => {
  for (const status of [401, 403, 404, 500]) {
    const result = await readAccountCheckup(async () => { throw Object.assign(Error('unavailable'), { status }); }, state());
    assert.equal(result.errors.length, 4); assert.equal(result.telegram, undefined); assert.deepEqual(ids(state(result)), [`expiry:${hash}`, `limit:${hash}`]);
  }
  const result = await readAccountCheckup(async () => ({}), state()); assert.equal(result.errors.length, 4);
  await assert.rejects(readAccountCheckup(async () => { throw Object.assign(Error('aborted'), { name: 'AbortError' }); }, state()), { name: 'AbortError' });
});
test('J177 Home, docs and existing control handoff are additive and keyboard accessible', () => {
  for (const [file, fragment] of [['components/account/AccountHome.jsx', '<AccountCheckup key='], ['components/Dashboard.jsx', '<AccountCheckupTarget enabled='], ['app/docs/page.jsx', '<AccountCheckupDocs />']]) assert.ok(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(fragment));
  const component = fs.readFileSync(new URL('../components/account/AccountCheckup.jsx', import.meta.url), 'utf8'); assert.match(component, /Show dismissed items/); assert.match(component, /aria-label=\{`Dismiss:/);
  const css = fs.readFileSync(new URL('../components/account/AccountCheckup.module.css', import.meta.url), 'utf8'); assert.match(css, /flex-wrap:wrap/); assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /focus-visible/);
});
