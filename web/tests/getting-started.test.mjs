import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { api } from '../lib/api.js';
import { GETTING_STARTED_PREFIX, gettingStartedSteps, gettingStartedHidden, readGettingStartedState, writeGettingStarted, rememberGettingStartedReceipts, recordGettingStartedReceiptVisit, readGettingStarted } from '../lib/getting-started.js';
const done = (state, id) => gettingStartedSteps(state).find(step => step.id === id).done;
function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}
test('C135 starts with five incomplete steps and links to existing actions', () => {
  const steps = gettingStartedSteps();
  assert.equal(steps.length, 5); assert.ok(steps.every(step => step.done === false));
  assert.deepEqual(steps.map(step => step.href), ['/dashboard/#payments', '/harness/', '/dashboard/#api-keys', '/agents/', '/dashboard/#activity']);
});
test('C135 funds count a positive balance or an actual credited deposit, including spent deposits', () => {
  assert.equal(done({ workspace: { credits: { balance: 2, available: 0 } } }, 'funds'), true);
  assert.equal(done({ workspace: { credits: { available: '0.001' } } }, 'funds'), true);
  assert.equal(done({ workspace: { credits: { balance: 0, total_credits: 9 }, stock: { deposits: [{ status: 'credited' }] } } }, 'funds'), true);
  assert.equal(done({ deposits: [{ kind: 'deposit', status: 'posted', amount: '1' }] }, 'funds'), true);
  for (const status of ['pending', 'pending_finality', 'orphaned', 'reversed']) assert.equal(done({ deposits: [{ status, amount: 10 }] }, 'funds'), false);
  assert.equal(done({ deposits: [{ kind: 'deposit', status: 'posted', amount: '0' }] }, 'funds'), false);
  assert.equal(done({ workspace: { credits: { balance: 0, total_credits: 10 } } }, 'funds'), false); // Positive credits also include refunds.
});
test('C135 first call requires a charge, rather than just a free receipt', () => {
  assert.equal(done({ workspace: { credits: { total_usage: '0.01' } } }, 'call'), true);
  assert.equal(done({ activity: [{ kind: 'call', amount: '-0.01', status: 'cancelled' }] }, 'call'), true);
  assert.equal(done({ workspace: { receipts: [{ id: 'gen-own', cost: 1 }] } }, 'call'), true);
  assert.equal(done({ workspace: { receipts: [{ id: 'gen-free', cost: 0 }] }, activity: [{ kind: 'call', amount: '0' }, { kind: 'deposit', amount: '-1' }] }, 'call'), false);
});
test('C135 any configured budget including zero, or any agent rulebook, counts', () => {
  for (const limit of [0, '0', 1]) assert.equal(done({ workspace: { keys: [{ limit }] } }, 'limit'), true);
  assert.equal(done({ workspace: { me: { limit: 2 }, keys: [] } }, 'limit'), true);
  for (const limit of [undefined, null, NaN, -1]) assert.equal(done({ workspace: { keys: [{ limit }] } }, 'limit'), false);
  assert.equal(done({ agents: [{ has_policy: true, caps: {} }] }, 'limit'), true);
  assert.equal(done({ agents: [{ has_policy: false, caps: { day: 9 } }] }, 'limit'), false);
});
test('C135 Telegram counts only a confirmed link and receipt visit is independent of owning receipts', () => {
  assert.equal(done({ telegram: { linked: true } }, 'telegram'), true);
  for (const telegram of [null, { linked: false }, { linked: 'true' }]) assert.equal(done({ telegram }, 'telegram'), false);
  assert.equal(done({ checked: true }, 'receipt'), true);
  assert.equal(done({ workspace: { receipts: [{ id: 'gen-own' }] } }, 'receipt'), false);
  assert.equal(gettingStartedSteps({ activity: [{ receipt_id: 'gen-own' }] })[4].href, '/verify/?r=gen-own');
});
test('C135 receipt visits match remembered authenticated ids, are scoped, and retain at most 100', () => {
  const store = storage();
  rememberGettingStartedReceipts(store, 'key-a', ['gen-own', '../invalid']);
  rememberGettingStartedReceipts(store, 'key-b', ['gen-other']);
  assert.equal(recordGettingStartedReceiptVisit(store, 'gen-public'), false);
  assert.equal(recordGettingStartedReceiptVisit(store, '../invalid'), false);
  assert.equal(recordGettingStartedReceiptVisit(store, 'gen-own'), true);
  assert.equal(readGettingStartedState(store, 'key-a').checked, true);
  assert.equal(readGettingStartedState(store, 'key-b').checked, false);
  rememberGettingStartedReceipts(store, 'key-a', Array.from({ length: 110 }, (_, i) => 'gen-' + i));
  assert.equal(readGettingStartedState(store, 'key-a').receipts.length, 100);
  assert.equal(readGettingStartedState(store, 'key-a').checked, true);
});
test('C135 Hide and completion survive revisits, clearing storage resets them, denied storage is safe', () => {
  const store = storage(), incomplete = gettingStartedSteps();
  writeGettingStarted(store, 'key-a', { hidden: true });
  assert.equal(gettingStartedHidden(readGettingStartedState(store, 'key-a'), incomplete), true);
  assert.equal(gettingStartedHidden(readGettingStartedState(store, 'key-b'), incomplete), false);
  writeGettingStarted(store, 'key-b', { complete: true });
  assert.equal(gettingStartedHidden(readGettingStartedState(store, 'key-b'), incomplete), true);
  assert.equal(gettingStartedHidden({}, incomplete.map(step => ({ ...step, done: true }))), true);
  assert.equal(gettingStartedHidden(readGettingStartedState(storage(), 'key-a'), incomplete), false);
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, get length() { throw Error('denied'); } };
  assert.equal(writeGettingStarted(denied, 'key-a', { hidden: true }), false);
  assert.equal(recordGettingStartedReceiptVisit(denied, 'gen-own'), false);
  store.setItem(GETTING_STARTED_PREFIX + 'bad', '{');
  assert.equal(readGettingStartedState(store, 'bad').checked, false);
});
test('C135 reads existing routes with Bearer auth and follows deposit pages until credited', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); const query = new URL(url, 'https://example.invalid').searchParams;
    const body = url.includes('/telegram/') ? { data: { linked: true } } : query.get('kind') === 'call' ? { data: [{ kind: 'call', amount: '-1', receipt_id: 'gen-own' }], scope: 'account' } : query.get('cursor') ? { data: [{ kind: 'deposit', amount: '2', status: 'posted' }], scope: 'account', next_cursor: null } : { data: [{ kind: 'deposit', status: 'pending', amount: '0' }], scope: 'account', next_cursor: 'next' };
    return new Response(JSON.stringify(body));
  };
  try {
    const result = await readGettingStarted((path, options) => api(path, { ...options, key: 'fixture-key' }));
    assert.equal(result.errors.length, 0); assert.equal(result.deposits.length, 1); assert.equal(result.telegram.linked, true);
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.options.method === 'GET' && call.options.headers.authorization === 'Bearer fixture-key' && !call.url.includes('fixture-key')));
  } finally { globalThis.fetch = previous; }
});
test('C135 unauthenticated, forbidden and default-off routes never manufacture progress', async () => {
  for (const status of [401, 403, 404]) {
    const result = await readGettingStarted(async () => { throw Object.assign(Error('unavailable'), { status }); });
    assert.equal(result.errors.length, 3); assert.ok(gettingStartedSteps(result).every(step => !step.done));
    if (status === 404) assert.ok(result.errors.includes('Telegram linking is not switched on here.'));
  }
  const paths = [];
  await readGettingStarted(async path => { paths.push(path); return path.includes('/telegram/') ? { data: { linked: false } } : { data: [], scope: 'key' }; }, { readDeposits: false });
  assert.equal(paths.length, 2); assert.ok(paths.every(path => !path.includes('kind=deposit')));
  await assert.rejects(readGettingStarted(async () => { throw Object.assign(Error('aborted'), { name: 'AbortError' }); }), { name: 'AbortError' });
});
test('C135 Home, verify and docs mount the feature with no backend endpoint', () => {
  for (const [file, fragment] of [['components/account/AccountHome.jsx', '<GettingStarted key='], ['app/verify/page.jsx', '<GettingStartedReceiptVisit />'], ['app/docs/page.jsx', '<GettingStartedDocs />']]) assert.ok(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes(fragment));
  const css = fs.readFileSync(new URL('../components/account/GettingStarted.module.css', import.meta.url), 'utf8');
  assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /focus-visible/); assert.match(css, /flex-wrap:wrap/);
});
