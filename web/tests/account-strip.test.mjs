import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ADD_FUNDS_HREF, INBOX_HREF, POLL_MS, balanceLabel, bellBadge, bellLabel, creditsBalance, formatBalance, nextPollDelay, readAccountStrip, safeHref, stripAlerts, stripApprovals, stripCounts, stripDeposits } from '../lib/account-strip.js';
import { WAKE_GAP_MS, createPoller, sharedPoller } from '../lib/account-poller.js';
import { BalanceLink, BellButton } from '../components/nav/AccountTrigger.js';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const now = Date.parse('2026-10-05T12:00:00.000Z');
const later = '2026-10-05T13:00:00.000Z', earlier = '2026-10-05T11:00:00.000Z';
const scope = 'a'.repeat(64);
const inbox = (data = []) => ({ data, count: data.length, as_of: '2026-10-05T12:00:00.000Z', seen_scope: scope, scope: 'account' });
const approval = (id, expires_at = later) => ({ id: `approval:${id}`, kind: 'approval', approval_id: id, expires_at, at: earlier, can_decide: true, unread: true, href: '/agents/' });
const item = (id, kind) => ({ id, kind, title: kind, at: earlier, href: '/agents/', unread: true });
const deposit = (id, stage) => ({ id, stage, lane: 'usdg', tx_hash: '0x' + '1'.repeat(64) });

test('polls every 30 s and doubles per consecutive failure up to five minutes', () => {
  assert.equal(POLL_MS, 30_000);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(n => nextPollDelay(n)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test('counts approvals waiting, alerts and deposits in progress, without double counting', () => {
  const page = inbox([approval('one'), approval('gone', earlier), item('alert:1', 'alert'), item('agreement:1', 'agreement'), item('host:1', 'host'), item('deposit:1', 'deposit')]);
  assert.deepEqual(stripApprovals(page, now).map(row => row.approval_id), ['one']);
  assert.deepEqual(stripAlerts(page).map(row => row.id), ['alert:1', 'agreement:1', 'host:1']);
  const deposits = { deposits: [deposit('a', 'detected'), deposit('b', 'submitted'), deposit('c', 'final'), deposit('d', 'credited'), deposit('e', 'final'), deposit('f', 'final')] };
  assert.deepEqual(stripDeposits(deposits).pending.map(d => d.id), ['a', 'b']);
  assert.deepEqual(stripDeposits(deposits).final.map(d => d.id), ['c', 'd', 'e']);
  assert.deepEqual(stripCounts({ inbox: page, deposits }, now), { approvals: 1, alerts: 3, deposits: 2, total: 6 });
  assert.deepEqual(stripCounts({ inbox: null, deposits: null }, now), { approvals: null, alerts: null, deposits: null, total: 0 });
});

test('the bell names every count, says what is missing, and caps its badge', () => {
  assert.equal(bellLabel(null), 'Open account updates. Reading counts.');
  const page = inbox([approval('one'), item('alert:1', 'alert'), item('alert:2', 'alert')]);
  assert.equal(bellLabel({ at: now, inbox: page, deposits: { deposits: [deposit('a', 'detected')] } }, now), 'Open account updates: 1 approval waiting, 2 alerts, 1 deposit in progress.');
  assert.equal(bellLabel({ at: now, inbox: inbox(), deposits: { deposits: [] } }, now), 'Open account updates: 0 approvals waiting, 0 alerts, 0 deposits in progress.');
  assert.equal(bellLabel({ at: now, inbox: null, deposits: null, inboxError: 'x', depositsError: 'y' }, now), 'Open account updates: approvals and alerts unavailable, deposits unavailable.');
  assert.equal(bellLabel({ at: now, inbox: inbox(), depositsOff: true }, now), 'Open account updates: 0 approvals waiting, 0 alerts.');
  assert.equal(bellBadge({ inbox: inbox() }), '');
  assert.equal(bellBadge({ inbox: inbox(Array.from({ length: 120 }, (_, i) => item('alert:' + i, 'alert'))) }), '99+');
});

test('balance reads available first, never rounds up, and keeps its visible text in the accessible name', () => {
  assert.equal(creditsBalance({ available: 3.5, balance: 9 }), 3.5);
  assert.equal(creditsBalance({ balance: '2.25' }), 2.25);
  assert.equal(creditsBalance({}), null); assert.equal(creditsBalance({ available: 'x' }), null);
  assert.equal(formatBalance(12.349), '$12.34'); assert.equal(formatBalance(0), '$0.00'); assert.equal(formatBalance(0.004), '<$0.01');
  assert.equal(formatBalance(1234.5), '$1,234.50'); assert.equal(formatBalance(null), 'Balance');
  assert.equal(balanceLabel({ balance: 5 }), 'Balance $5.00. Add funds.');
  assert.equal(balanceLabel(null), 'Balance, reading. Add funds.');
  assert.equal(balanceLabel({ balanceError: 'no' }), 'Balance unavailable. Add funds.');
});

test('alert links stay on this site', () => {
  assert.equal(safeHref('/dashboard/#spend-watch'), '/dashboard/#spend-watch');
  assert.equal(safeHref('/hosts/?id=h1'), '/hosts/?id=h1');
  for (const bad of ['//elsewhere.example/', 'https://elsewhere.example/', 'javascript:alert(1)', '/\\elsewhere', null]) assert.equal(safeHref(bad), INBOX_HREF);
});

test('one read cycle requests balance, inbox and deposits one at a time, with the key never in a URL', async () => {
  const calls = []; let open = 0;
  const responses = { '/api/v1/credits': { data: { available: 7 } }, '/api/v1/inbox': inbox([approval('one')]), '/api/v1/credits/deposits': { data: { deposits: [deposit('a', 'detected')] } } };
  const request = async (path, options) => { assert.equal(open++, 0, 'one request at a time'); calls.push(path); assert.ok(options.signal); await null; open--; return responses[path]; };
  const signal = new AbortController().signal;
  const { value, ok } = await readAccountStrip(request, { signal });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['/api/v1/credits', '/api/v1/inbox', '/api/v1/credits/deposits']);
  assert.ok(calls.every(path => !/sk-ar|key=/.test(path)));
  assert.equal(value.balance, 7); assert.equal(value.inbox.data.length, 1); assert.equal(value.deposits.deposits.length, 1);
});

test('deposits a key cannot read are skipped from then on; failures keep the last values and back off; 401 ends polling', async () => {
  const fail = (status, message = 'no') => Object.assign(new Error(message), { status });
  let calls = [];
  const off = await readAccountStrip(async path => { calls.push(path); if (path.endsWith('/deposits')) throw fail(403); return path === '/api/v1/credits' ? { data: { available: 1 } } : inbox(); });
  assert.equal(off.ok, true); assert.equal(off.value.depositsOff, true);
  calls = [];
  await readAccountStrip(async path => { calls.push(path); return path === '/api/v1/credits' ? { data: { available: 1 } } : inbox(); }, { previous: off.value });
  assert.deepEqual(calls, ['/api/v1/credits', '/api/v1/inbox']);
  const flaky = await readAccountStrip(async path => { if (path === '/api/v1/inbox') throw fail(503, 'Busy.'); return { data: path === '/api/v1/credits' ? { available: 2 } : { deposits: [] } }; }, { previous: { inbox: inbox([approval('kept')]) } });
  assert.equal(flaky.ok, false); assert.equal(flaky.value.inboxError, 'Busy.'); assert.equal(flaky.value.inbox.data[0].approval_id, 'kept'); assert.equal(flaky.value.balance, 2);
  calls = [];
  const gone = await readAccountStrip(async path => { calls.push(path); throw fail(401); });
  assert.equal(gone.value.fatal, true); assert.deepEqual(calls, ['/api/v1/credits']);
});

function fakeEnv() {
  const env = { t: 0, away: false, timers: new Map(), id: 0, unlistened: 0 };
  return Object.assign(env, {
    setTimeout: (fn, ms) => { env.timers.set(++env.id, { fn, ms }); return env.id; },
    clearTimeout: id => env.timers.delete(id),
    now: () => env.t,
    hidden: () => env.away,
    listen: (wake, refresh) => { env.wake = wake; env.refresh = refresh; return () => env.unlistened++; },
    delays: () => [...env.timers.values()].map(timer => timer.ms),
    fire: () => { const [id, timer] = [...env.timers][0]; env.timers.delete(id); timer.fn(); },
  });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function reader() {
  const r = { calls: 0, open: 0, max: 0, pending: [], signals: [] };
  r.read = signal => { r.calls++; r.open++; r.max = Math.max(r.max, r.open); r.signals.push(signal); return new Promise((resolve, reject) => r.pending.push({ resolve: value => { r.open--; resolve(value); }, reject: error => { r.open--; reject(error); } })); };
  r.ok = (value = { at: 1 }) => r.pending.shift().resolve({ value, ok: true });
  r.bad = (value = { at: 1 }) => r.pending.shift().resolve({ value, ok: false });
  return r;
}

test('the poller reads on subscribe, then every 30 s, one read at a time, and backs off on failures', async () => {
  const env = fakeEnv(), r = reader(), seen = [];
  const poller = createPoller({ read: r.read, env });
  poller.subscribe(state => seen.push(state));
  assert.equal(r.calls, 1);
  poller.refresh(); poller.refresh(); env.refresh();
  assert.equal(r.calls, 1, 'refreshes while a read is in flight wait for it');
  r.ok({ at: 1 }); await tick();
  assert.equal(r.calls, 2, 'exactly one follow-up read'); assert.equal(r.max, 1);
  r.ok({ at: 2 }); await tick();
  assert.deepEqual(env.delays(), [30_000]); assert.deepEqual(seen.map(state => state.at), [1, 2]);
  env.fire(); r.bad(); await tick(); assert.deepEqual(env.delays(), [60_000]);
  env.fire(); r.bad(); await tick(); assert.deepEqual(env.delays(), [120_000]);
  env.fire(); r.ok(); await tick(); assert.deepEqual(env.delays(), [30_000]);
  env.fire(); r.pending.shift().reject(new Error('down')); await tick();
  assert.deepEqual(env.delays(), [60_000]); assert.equal(poller.state.readError, 'down');
});

test('the poller pauses while the tab is hidden and refreshes when it is shown or focused', async () => {
  const env = fakeEnv(), r = reader();
  const poller = createPoller({ read: r.read, env });
  poller.subscribe(() => {});
  r.ok(); await tick(); assert.deepEqual(env.delays(), [30_000]);
  env.t = 1_000; env.wake(); assert.equal(r.calls, 1, 'a focus right after a read does not read again');
  env.away = true; env.wake(); assert.deepEqual(env.delays(), [], 'hidden: no timer');
  env.t = 120_000; env.away = false; env.wake(); assert.equal(r.calls, 2, 'shown: reads at once');
  env.away = true; r.ok(); await tick(); assert.deepEqual(env.delays(), [], 'a read that ends while hidden schedules nothing');
  env.away = false; env.t = 120_000 + WAKE_GAP_MS; env.wake(); assert.equal(r.calls, 3);
});

test('the last subscriber stops the poller, aborts its read and removes its listeners; a 401 stops scheduling', async () => {
  const env = fakeEnv(), r = reader(); let stopped = 0;
  const poller = createPoller({ read: r.read, env, onStop: () => stopped++ });
  const a = poller.subscribe(() => {}), b = poller.subscribe(() => {});
  assert.equal(r.calls, 1, 'two subscribers share one read');
  a(); assert.equal(poller.stopped, false);
  b(); assert.equal(poller.stopped, true); assert.equal(r.signals[0].aborted, true); assert.equal(env.unlistened, 1); assert.equal(stopped, 1);
  r.ok(); await tick(); assert.deepEqual(env.delays(), []);
  const env2 = fakeEnv(), r2 = reader();
  const fatal = createPoller({ read: r2.read, env: env2 }); fatal.subscribe(() => {});
  r2.bad({ fatal: true, at: 1 }); await tick();
  assert.deepEqual(env2.delays(), []); env2.t = 600_000; env2.wake(); assert.equal(r2.calls, 1);
});

test('one shared poller per key on a page', () => {
  let made = 0;
  const make = onStop => { made++; const poller = createPoller({ read: () => new Promise(() => {}), env: fakeEnv(), onStop }); return poller; };
  const one = sharedPoller('sample-key-1', make), two = sharedPoller('sample-key-1', make);
  assert.equal(one, two); assert.equal(made, 1);
  const stop = one.subscribe(() => {}); stop();
  assert.notEqual(sharedPoller('sample-key-1', make), one); assert.equal(made, 2);
});

test('header controls: balance links to add funds; the bell is a dialog button with counts', () => {
  const balance = renderToStaticMarkup(h(BalanceLink, { snapshot: { balance: 42.5 }, className: 'balance' }));
  assert.match(balance, new RegExp(`href="${ADD_FUNDS_HREF.replace(/[/#]/g, '\\$&')}"`)); assert.match(balance, />\$42\.50</); assert.match(balance, /aria-label="Balance \$42\.50\. Add funds\."/);
  const bell = renderToStaticMarkup(h(BellButton, { snapshot: { at: now, inbox: inbox([approval('one')]), deposits: { deposits: [] } }, open: true, badgeClass: 'badge' }));
  assert.match(bell, /aria-haspopup="dialog"/); assert.match(bell, /aria-expanded="true"/); assert.match(bell, /type="button"/);
  assert.match(bell, /1 approval waiting, 0 alerts, 0 deposits in progress/); assert.match(bell, /class="badge"[^>]*>1</);
  assert.doesNotMatch(renderToStaticMarkup(h(BellButton, { snapshot: null })), /badge/);
});

test('the header mounts the strip once; signed out it renders nothing and starts no poller', () => {
  const ui = read('components/UI.jsx'), strip = read('components/nav/AccountStrip.jsx');
  assert.equal(ui.match(/<AccountStrip\/>/g).length, 1); assert.doesNotMatch(ui, /InboxBell/);
  assert.ok(strip.indexOf('if (!key) return;') < strip.indexOf('accountPoller(key)'));
  assert.match(strip, /if \(!key \|\| snapshot\?\.fatal\) return null;/);
});

test('the drawer is a modal dialog: Escape closes it, Tab stays inside, and it reuses the inbox decisions', () => {
  const drawer = read('components/nav/AccountDrawer.jsx');
  assert.match(drawer, /showModal\(\)/); assert.match(drawer, /onCancel=\{event => \{ event\.preventDefault\(\); onClose\(\); \}\}/);
  assert.match(drawer, /aria-labelledby="account-drawer-title"/); assert.match(drawer, /event\.key !== 'Tab'/);
  assert.match(drawer, /decideInboxApproval\(request, item\.approval_id, choice\)/); assert.match(drawer, /markInboxSeen\(request, window\.localStorage, page\)/);
});

test('new files store nothing, put no key in a URL and keep to the public wording', () => {
  const files = ['lib/account-strip.js', 'lib/account-poller.js', 'components/nav/AccountStrip.jsx', 'components/nav/AccountDrawer.jsx', 'components/nav/AccountTrigger.js', 'components/nav/AccountStrip.module.css'];
  for (const file of files) {
    const source = read(file).replace(/\.test\(/g, '(');
    assert.doesNotMatch(source, /setItem|sessionStorage|document\.cookie|indexedDB/, file);
    assert.doesNotMatch(source, /[?&](?:key|api_key|token)=/, file);
    assert.doesNotMatch(source, /\b(?:demo|test|tested|local|mock|simulated|placeholder|fixture|private|no logs|earn|yield|APY|returns|bonds?|x402|Harness|kill)\b/i, file);
  }
});
