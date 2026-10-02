import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHAT_LIMITS_STORE, approvalPhase, chatLimitSpec, createHarnessLimits } from '../lib/harness-limits.js';

const form = { session: '5', day: '2', approval: '0.1', minutes: '60' };
const expiry = () => new Date(Date.now() + 900_000).toISOString();
const session = () => ({ id: 'chat-session', key: 'child-key', key_hash: 'child-hash', budget_usd: 5, expires_at: expiry() });
function setup({ stream, request, stored, pollMs = 5 } = {}) {
  const calls = [], streams = [], values = new Map(stored ? [[CHAT_LIMITS_STORE, JSON.stringify(stored)]] : []);
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const controller = createHarnessLimits({ storage, pollMs,
    request: async (url, opts) => { calls.push([url, opts]);
      if (request) return request(url, opts);
      return { data: url === '/api/v1/sessions' ? session() : {} }; },
    stream: async opts => { streams.push(opts); return stream?.(opts) ?? 'reply'; } });
  return { controller, calls, streams, values };
}
const chat = () => ({ messageId: 'reply-one', key: 'parent-key', body: { model: 'model/one', messages: [{ role: 'user', content: 'A question' }] }, headers: { 'x-anyroute-lane': 'attested' }, signal: new AbortController().signal });
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(fn(), 'state reached'); }
const required = () => Object.assign(new Error('Ask first'), { status: 403, type: 'agent_approval_required', metadata: { approval_id: 'approval-one', expires_at: expiry() } });

test('forms map to router budgets, rolling caps and approvals without widening key settings', () => {
  assert.deepEqual(chatLimitSpec(form), {
    session: { name: 'Chat in this browser', budget_usd: 5, ttl_minutes: 60 },
    policy: { version: 1, models: {}, caps: { per_day_usd: 2 }, approval: { above_usd: 0.1 }, on_breach: 'deny' },
  });
  assert.deepEqual(chatLimitSpec({ ...form, day: '', approval: '' }).policy, { version: 1, models: {}, caps: {}, on_breach: 'deny' });
  for (const change of [{ session: '0' }, { session: '1001' }, { day: '-1' }, { approval: 'NaN' }, { minutes: '1441' }, { minutes: '1.2' }]) assert.throws(() => chatLimitSpec({ ...form, ...change }));
});

test('no child is used until its server rulebook is saved; all chat variants use that child', async () => {
  const { controller: c, calls, streams, values } = setup();
  await c.connect('parent-key', 'parent-hash'); await c.enable(form);
  assert.deepEqual(calls.map(([url, opts]) => [url, opts.method || 'GET', opts.key]), [
    ['/api/v1/agents', 'GET', 'parent-key'], ['/api/v1/sessions', 'POST', 'parent-key'], ['/api/v1/agents/child-hash/policy', 'PUT', 'parent-key'],
  ]);
  assert.equal(calls[1][1].body.management, undefined);
  assert.equal(calls[1][1].body.allowed_models, undefined); // session API inherits the parent's allowlist
  assert.equal(JSON.parse(values.get(CHAT_LIMITS_STORE)).key, 'child-key');
  for (const body of [chat().body, { model: 'model/two', messages: [] }, { model: 'model/one', tools: [{ function: { name: 'read' } }] }]) await c.streamChat({ ...chat(), body });
  assert.ok(streams.every(opts => opts.key === 'child-key'));
  await c.stop(); await c.streamChat(chat()); // send to router even when stopped; its kill guard enforces
  assert.equal(calls.at(-1)[0], '/api/v1/agents/child-hash/kill');
  assert.equal(streams.at(-1).key, 'child-key');
  await c.resume(); assert.equal(calls.at(-1)[0], '/api/v1/agents/child-hash/resume');
  await c.remove(); assert.equal(calls.at(-1)[0], '/api/v1/sessions/chat-session');
  assert.equal(values.has(CHAT_LIMITS_STORE), false);
  await c.streamChat(chat()); assert.equal(streams.at(-1).key, 'parent-key');
});

test('rulebook failure revokes the unused key; failed revocation blocks fallback and can be retried', async () => {
  let canRevoke = false;
  const { controller: c, streams } = setup({ request: async (url, opts) => {
    if (url === '/api/v1/sessions') return { data: session() };
    if (opts.method === 'PUT' || opts.method === 'DELETE' && !canRevoke) throw new Error('Unavailable');
    return { data: {} };
  } });
  await c.connect('parent-key', 'parent-hash');
  await assert.rejects(c.enable(form), /blocked/);
  await assert.rejects(c.streamChat(chat()), /could not be set up/); assert.equal(streams.length, 0);
  await assert.rejects(c.signOut()); assert.ok(c.get().session);
  canRevoke = true; await c.signOut(); assert.equal(c.get().session, null);
  await assert.rejects(c.streamChat(chat()), /sign-in/);
});

test('reload restores the child and sign-out revokes it with the creating key', async () => {
  const stored = { ...session(), ready: true, parentHash: 'parent-hash' };
  const { controller: c, streams, calls } = setup({ stored });
  await c.connect('parent-key', 'parent-hash'); await c.streamChat(chat());
  assert.equal(streams[0].key, 'child-key'); await c.signOut();
  assert.equal(calls.at(-1)[1].method, 'DELETE'); assert.equal(calls.at(-1)[1].key, 'parent-key');
  const wrong = setup({ stored });
  await assert.rejects(wrong.controller.connect('another-key', 'another-hash'), /Reconnect/);
  await assert.rejects(wrong.controller.streamChat(chat())); assert.equal(wrong.streams.length, 0);
});

test('router refusal and cost approval are authoritative; approval resumes the frozen reply once', async () => {
  let approved = false;
  const { controller: c, streams, calls } = setup({ pollMs: 1000, stream: opts => {
    if (!opts.headers['x-agent-approval']) throw required(); return 'approved reply';
  }, request: async (url, opts) => {
    if (url === '/api/v1/sessions') return { data: session() };
    if (url.endsWith('/approve')) { approved = true; return { data: { status: 'approved', expires_at: expiry() } }; }
    return { data: {} };
  } });
  await c.connect('parent-key', 'parent-hash'); await c.enable(form);
  const opts = chat(), original = structuredClone(opts.body);
  const result = c.streamChat(opts); await until(() => c.get().approvals.length);
  opts.body.messages[0].content = 'Changed'; opts.headers['x-anyroute-lane'] = 'public';
  assert.equal(streams.length, 1); assert.equal(approved, false);
  await c.decide('reply-one', 'approve'); assert.equal(await result, 'approved reply');
  assert.deepEqual(streams[1].body, original); assert.equal(streams[1].key, 'child-key');
  assert.equal(streams[1].headers['x-anyroute-lane'], 'attested'); assert.equal(streams[1].headers['x-agent-approval'], 'approval-one');
  assert.equal(calls.at(-1)[1].key, 'parent-key'); assert.equal(c.get().approvals.length, 0);
});

test('deny, expiry and reused approvals stop without retrying; approval phases are terminal', async () => {
  for (const status of ['denied', 'expired', 'used']) {
    const { controller: c, streams } = setup({ stream: () => { throw required(); }, request: async url => ({ data: url.includes('approvals/') ? { status, expires_at: expiry() } : {} }) });
    await c.connect('parent-key', 'parent-hash'); await assert.rejects(c.streamChat(chat()), new RegExp(status));
    assert.equal(streams.length, 1);
  }
  assert.equal(approvalPhase('pending', { status: 'approved', expires_at: expiry() }), 'approved');
  assert.equal(approvalPhase('denied', { status: 'approved', expires_at: expiry() }), 'denied');
  assert.equal(approvalPhase('pending', { status: 'approved', expires_at: '2000-01-01' }), 'expired');
  assert.throws(() => approvalPhase('pending', { status: 'other', expires_at: expiry() }));
});

test('Telegram or Agents approval polling resumes; cancellation stops waiting and late decisions cannot retry', async () => {
  const { controller: c, streams } = setup({ stream: opts => { if (!opts.headers['x-agent-approval']) throw required(); return 'reply'; }, request: async () => ({ data: { status: 'approved', expires_at: expiry() } }) });
  await c.connect('parent-key', 'parent-hash'); assert.equal(await c.streamChat(chat()), 'reply'); assert.equal(streams.length, 2);
  const other = setup({ stream: () => { throw required(); } });
  await other.controller.connect('parent-key', 'parent-hash');
  const ctl = new AbortController(), result = other.controller.streamChat({ ...chat(), signal: ctl.signal });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await until(() => other.controller.get().approvals.length); ctl.abort(); await rejection;
  await other.controller.decide('reply-one', 'approve'); assert.equal(other.streams.length, 1);
});

test('budget, kill and invalid-approval errors never fall back to the account key', async () => {
  for (const type of ['agent_killed', 'agent_policy_denied', 'key_budget_exceeded', 'agent_approval_invalid']) {
    const { controller: c, streams } = setup({ stream: () => { throw Object.assign(new Error(type), { type }); } });
    await c.connect('parent-key', 'parent-hash'); await c.enable(form);
    await assert.rejects(c.streamChat(chat()), new RegExp(type)); assert.equal(streams.length, 1); assert.equal(streams[0].key, 'child-key');
  }
});

test('a limits change blocks new calls until the router saves the policy', async () => {
  let save;
  const { controller: c, streams } = setup({ request: async (url, opts) => {
    if (url === '/api/v1/sessions') return { data: session() };
    if (opts.method === 'PUT') await new Promise(resolve => { save = resolve; });
    return { data: {} };
  } });
  await c.connect('parent-key', 'parent-hash'); const enabling = c.enable(form);
  await until(() => !!save); await assert.rejects(c.streamChat(chat()), /limits change/);
  assert.equal(streams.length, 0); save(); await enabling;
  await c.streamChat(chat()); assert.equal(streams[0].key, 'child-key');
});

test('inline denial uses the owner API; failed approval decisions never grant a retry', async () => {
  for (const unavailable of [false, true]) {
    const { controller: c, streams, calls } = setup({ pollMs: 1000, stream: () => { throw required(); }, request: async (url, opts) => {
      if (opts.method === 'POST') {
        if (unavailable) throw new Error('Decision unavailable');
        return { data: { status: 'denied', expires_at: expiry() } };
      }
      return { data: [] };
    } });
    await c.connect('parent-key', 'parent-hash'); const ctl = new AbortController();
    const result = c.streamChat({ ...chat(), signal: ctl.signal });
    const rejected = assert.rejects(result);
    await until(() => c.get().approvals.length);
    if (unavailable) { await assert.rejects(c.decide('reply-one', 'approve')); assert.equal(streams.length, 1); ctl.abort(); }
    else { await c.decide('reply-one', 'deny'); assert.equal(calls.at(-1)[0], '/api/v1/agents/approvals/approval-one/deny'); assert.equal(calls.at(-1)[1].key, 'parent-key'); }
    await rejected; assert.equal(streams.length, 1);
  }
});

test('an unavailable rulebook feature creates no session', async () => {
  const { controller: c, calls } = setup({ request: async () => { throw Object.assign(new Error('Not switched on'), { status: 404 }); } });
  await c.connect('parent-key', 'parent-hash'); await assert.rejects(c.enable(form));
  assert.deepEqual(calls.map(([url]) => url), ['/api/v1/agents']); assert.equal(c.get().session, null);
});

test('Harness routes its one chat transport through limits and awaits revocation on sign-out', () => {
  const source = fs.readFileSync(new URL('../components/Harness.jsx', import.meta.url), 'utf8');
  assert.equal((source.match(/await limits\.streamChat\(/g) || []).length, 1);
  assert.doesNotMatch(source, /await streamChat\(/);
  assert.match(source, /await limits\.signOut\(\)/);
  assert.match(source, /limitsControl={<Limits/); assert.match(source, /<ReplyApproval/);
  const logic = fs.readFileSync(new URL('../lib/harness-limits.js', import.meta.url), 'utf8');
  assert.doesNotMatch(logic, /localStorage|estimateTokens|est_cost_pico/);
});
