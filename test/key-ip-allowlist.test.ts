// E148: all new cases also run against the plain in-process database.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { MODELS, startRouter, type Harness } from './helpers.ts';
import { keys, generations, holds } from '../src/db/schema.ts';
import { parseIp, parseIpRange, ipAllowed, allowlistFromLines } from '../src/key-ip/address.js';
import { derivedClientIp } from '../src/hardening/client.ts';
import { loadConfig } from '../src/config.ts';
import { BATCH_LINE } from '../src/router/batch-line.ts';
import { SCHEDULE_CALL } from '../src/schedules/caller.ts';

const IP = '203.0.113.9', PROXY = '10.0.0.2';
const onionSecret = 'onion-proxy-secret-for-tests-0123456789abcdef';
const chat = { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 };
let h: Harness, owner: Awaited<ReturnType<Harness['fundedKey']>>;
beforeAll(async () => { h = await startRouter({ env: { TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2', ONION_PROXY_SECRET: onionSecret } }); owner = await h.fundedKey(); });
afterAll(async () => { await h?.close(); });
const forwarded = (ip = IP) => ({ 'x-forwarded-for': `198.51.100.8, ${ip}, ${PROXY}` });
async function create(spec = {}) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: spec });
  expect(r.status).toBe(201);
  const result = await r.json();
  return { hash: result.data.hash as string, secret: result.key as string, auth: { authorization: `Bearer ${result.key}` }, data: result.data };
}
const patch = (hash: string, json: unknown, headers: Record<string, string> = owner.auth) => h.request('/api/v1/keys/' + hash, { method: 'PATCH', headers, json });
const call = (key: { auth: Record<string, string> }, ip = IP, extra = {}) => h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...key.auth, ...forwarded(ip) }, json: { ...chat, ...extra } });

 test('IPv4, IPv6 and CIDR matching handles boundaries, zero/full masks and mapped IPv4', () => {
  for (const [ip, rule, allowed] of [
    ['203.0.113.9', '203.0.113.9', true], ['203.0.113.8', '203.0.113.9', false],
    ['203.0.113.255', '203.0.113.9/24', true], ['203.0.114.0', '203.0.113.9/24', false],
    ['255.255.255.255', '0.0.0.0/0', true], ['203.0.113.9', '203.0.113.9/32', true],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1', true], ['2001:db8::ffff', '2001:db8::/32', true],
    ['2001:db9::1', '2001:db8::/32', false], ['ffff::1', '::/0', true],
    ['::1', '::1/128', true], ['::2', '::1/128', false], ['203.0.113.9', '::/0', false],
    ['::ffff:203.0.113.9', '203.0.113.0/24', true], ['203.0.113.9', '::ffff:cb00:7100/120', true],
    ['::ffff:203.0.114.9', '203.0.113.0/24', false],
  ] as const) expect(ipAllowed(ip, [rule]), `${ip} in ${rule}`).toBe(allowed);
  expect(ipAllowed('unknown', ['0.0.0.0/0', '::/0'])).toBe(false);
});

test('validation rejects hosts, ports, zones, invalid prefixes and overlong lists', () => {
  for (const entry of ['localhost', '1.2.3.999', '01.2.3.4', '1.2.3.4:80', '[::1]', 'fe80::1%eth0', '1:2:3:4:5:6:7', '1::2::3', '::ffff:1.2.3.999', '::/129', '1.2.3.4/33', '::/-1', '::/01', '::/', '::/1/2', ' ::1', '::1 ']) expect(parseIpRange(entry), entry).toBeNull();
  expect(parseIp('::')).not.toBeNull();
  expect(allowlistFromLines('203.0.113.9\r\n\n 2001:db8::/32 ')).toEqual(['203.0.113.9', '2001:db8::/32']);
  expect(allowlistFromLines('  \n')).toBeNull();
  expect(() => allowlistFromLines(Array(33).fill(IP).join('\n'))).toThrow('32');
});

test('default/null allowlist leaves existing calls unrestricted and clearing restores use', async () => {
  const key = await create(); expect(key.data.allowed_ips).toBeNull();
  expect((await h.request('/api/v1/key', { headers: key.auth })).status).toBe(200);
  const entries = [IP, '2001:db8::/32'];
  expect((await (await patch(key.hash, { allowed_ips: entries })).json()).data.allowed_ips).toEqual(entries);
  expect((await (await patch(key.hash, { name: 'Renamed' })).json()).data.allowed_ips).toEqual(entries);
  const listed = (await (await h.request('/api/v1/keys', { headers: owner.auth })).json()).data;
  expect(listed.find((row: any) => row.hash === key.hash).allowed_ips).toEqual(entries);
  expect((await h.request('/api/v1/key', { headers: key.auth })).status).toBe(403);
  expect((await (await patch(key.hash, { allowed_ips: null })).json()).data.allowed_ips).toBeNull();
  expect((await h.request('/api/v1/key', { headers: key.auth })).status).toBe(200);
});

test('proxy hop match serves inference; refusal occurs before any hold, generation or charge', async () => {
  const key = await create(); await patch(key.hash, { allowed_ips: [IP] });
  const providerCalls = h.mocks.alpha.stats.requests;
  const denied = await call(key, '198.51.100.8');
  expect(denied.status).toBe(403); expect((await denied.json()).error).toMatchObject({ type: 'ip_not_allowed', message: 'This key only works from its allowed IP addresses.' });
  expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash))).toEqual([]);
  expect(await h.ctx.db.select().from(holds).where(eq(holds.keyHash, key.hash))).toEqual([]);
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  expect(h.mocks.alpha.stats.requests).toBe(providerCalls);
  expect(row.spentTotal).toBe(0n); expect(row.lastUsed).toBeNull();
  const accepted = await call(key); expect(accepted.status).toBe(200); await accepted.text();
});

test('trusted proxy selection ignores forged left hops and validates selected addresses', () => {
  const cfg = loadConfig({ ANYROUTE_ENV: 'test', TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' }).hardening;
  const app = new Hono(); app.get('/', c => c.text(derivedClientIp(c, c.req.query('trust') !== 'false', cfg)));
  const socket = { requestIP: () => ({ address: '192.0.2.5' }) };
  return (async () => {
    expect(await (await app.request('/', { headers: forwarded() }, socket)).text()).toBe(IP);
    expect(await (await app.request('/?trust=false', { headers: forwarded() }, socket)).text()).toBe('192.0.2.5');
    expect(await (await app.request('/', { headers: { 'x-forwarded-for': 'forged, invalid, 10.0.0.1' } }, socket)).text()).toBe('192.0.2.5');
    expect(await (await app.request('/', { headers: { ...forwarded(), 'cf-connecting-ip': '198.51.100.2' } }, socket)).text()).toBe(IP);
  })();
});

test('IPv6 routes and both credential transports enforce restrictions', async () => {
  const key = await create(); await patch(key.hash, { allowed_ips: ['2001:db8::/32'] });
  const v6 = await call(key, '2001:db8:1::8'); expect(v6.status).toBe(200); await v6.text();
  const denied = await h.request('/api/v1/messages', { method: 'POST', headers: { 'x-api-key': key.secret, ...forwarded() }, json: {} });
  expect(denied.status).toBe(403); expect((await denied.json()).error.type).toBe('ip_not_allowed');
  expect((await h.request('/api/v1/key', { headers: { ...key.auth, ...forwarded('2001:db8::1') } })).status).toBe(200);
});

test('onion and unlinkable requests fail clearly, even with forged addresses or downgrade', async () => {
  const key = await create(); await patch(key.hash, { allowed_ips: [IP] });
  const onion = await h.request('/api/v1/key', { headers: { ...key.auth, ...forwarded(), 'x-anyroute-onion': onionSecret } });
  expect(onion.status).toBe(403); expect((await onion.json()).error.message).toContain('Onion and unlinkable');
  const ordinary = await h.request('/api/v1/key', { headers: { ...key.auth, ...forwarded(), 'x-anyroute-onion': 'invalid' } }); expect(ordinary.status).toBe(200);
  const unlinkable = await call(key, IP, { provider: { lane: 'unlinkable', lane_downgrade: 'attested' } });
  expect(unlinkable.status).toBe(403); expect((await unlinkable.json()).error.type).toBe('ip_not_allowed');
  const header = await h.request('/api/v1/key', { headers: { ...key.auth, ...forwarded(), 'x-anyroute-lane': 'unlinkable' } }); expect(header.status).toBe(403);
});

test('internal batch inference cannot substitute an origin address', async () => {
  const key = await create(); await patch(key.hash, { allowed_ips: ['0.0.0.0/0', '::/0'] });
  const res = await h.app.request('/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chat) }, { [BATCH_LINE]: { keyHash: key.hash, batchId: 'sample-batch', idx: 0, discountBps: 10000, generationId: 'sample-generation' } });
  expect(res.status).toBe(403); expect((await res.json()).error.type).toBe('ip_not_allowed');
});

test('PATCH keeps authentication, ownership, team roles and session guards', async () => {
  const target = await create(), outsider = await h.newKey();
  expect((await patch(target.hash, { allowed_ips: [IP] }, {})).status).toBe(401);
  expect((await patch(target.hash, { allowed_ips: [IP] }, { authorization: 'Bearer invalid' })).status).toBe(401);
  expect((await patch(target.hash, { allowed_ips: [IP] }, outsider.auth)).status).toBe(404);
  const team = (await (await h.request('/api/v1/teams', { method: 'POST', headers: owner.auth, json: { name: 'IP team' } })).json()).data.id;
  const viewer = await create({ team, role: 'viewer' }), admin = await create({ team, role: 'admin' }), teamKey = await create({ team });
  expect((await patch(teamKey.hash, { allowed_ips: [IP] }, viewer.auth)).status).toBe(403);
  expect((await patch(target.hash, { allowed_ips: [IP] }, admin.auth)).status).toBe(403);
  expect((await patch(teamKey.hash, { allowed_ips: [IP] }, admin.auth)).status).toBe(200);
  const session = await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 0.05, ttl_seconds: 300 } });
  expect(session.status).toBe(201);
  const sessionData = (await session.json()).data;
  const sessionEdit = await patch(sessionData.key_hash, { allowed_ips: [IP] });
  expect(sessionEdit.status).toBe(409); expect((await sessionEdit.json()).error.type).toBe('session_key');
});

test('invalid allowlists and create attempts cannot persist a restriction', async () => {
  const key = await create();
  for (const allowed_ips of [[], [1], ['bad'], Array(33).fill(IP), IP]) expect((await patch(key.hash, { allowed_ips })).status).toBe(400);
  const root = await h.request('/api/v1/keys', { method: 'POST', json: { allowed_ips: [IP] } }); expect(root.status).toBe(400);
  const sub = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { allowed_ips: [IP] } }); expect(sub.status).toBe(400);
  expect((await (await h.request('/api/v1/keys/' + key.hash, { headers: owner.auth })).json()).data.allowed_ips).toBeNull();
});

test('current-IP helper is authenticated, uncacheable, proxy-aware and refuses onion/unknown', async () => {
  expect((await h.request('/api/v1/keys/current-ip', { headers: forwarded() })).status).toBe(401);
  const member = await create(); expect((await h.request('/api/v1/keys/current-ip', { headers: { ...member.auth, ...forwarded() } })).status).toBe(403);
  const res = await h.request('/api/v1/keys/current-ip', { headers: { ...owner.auth, ...forwarded() } });
  expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store'); expect(await res.json()).toEqual({ data: { ip: IP } });
  expect((await h.request('/api/v1/keys/current-ip', { headers: owner.auth })).status).toBe(503);
  const onion = await h.request('/api/v1/keys/current-ip', { headers: { ...owner.auth, ...forwarded(), 'x-anyroute-onion': onionSecret } }); expect(onion.status).toBe(403);
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash)); expect(row.allowedIps).toBeNull();
});

test('synchronous adapters retain verified origin; concurrent requests cannot borrow it', async () => {
  const key = await create(); await patch(key.hash, { allowed_ips: [IP] });
  const results = await Promise.all([
    h.request('/api/v1/responses', { method: 'POST', headers: { ...key.auth, ...forwarded() }, json: { model: MODELS.llama.slug, input: 'hello', max_output_tokens: 8 } }),
    call(key, '198.51.100.77'),
    h.request('/api/v1/messages', { method: 'POST', headers: { 'x-api-key': key.secret, ...forwarded() }, json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 } }),
  ]);
  expect(results.map(result => result.status)).toEqual([200, 403, 200]);
  await Promise.all(results.map(result => result.text()));
  expect((await h.request('/api/v1/key', { headers: key.auth })).status).toBe(403);
});

 test('scheduled calls cannot substitute an origin address', async () => {
  const key = await create(); await patch(key.hash, { allowed_ips: ['0.0.0.0/0', '::/0'] });
  const enabled = h.ctx.cfg.scheduledPromptsEnabled; h.ctx.cfg.scheduledPromptsEnabled = true;
  try {
    const response = await h.app.request('/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...forwarded() }, body: JSON.stringify(chat) }, { [SCHEDULE_CALL]: { ownerHash: owner.hash, keyHash: key.hash, maxCostPico: 1000000000000n, generationId: 'sample-schedule-run' } });
    expect(response.status).toBe(403); expect((await response.json()).error.type).toBe('ip_not_allowed');
  } finally { h.ctx.cfg.scheduledPromptsEnabled = enabled; }
});
