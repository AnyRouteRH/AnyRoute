// E149: run with both real services and the plain single-connection database.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { agentApprovals } from '../src/agents/approval-schema.ts';
import { keys, generations, holds } from '../src/db/schema.ts';
import { readRouteAllowed } from '../src/read-only/scope.ts';
import { BATCH_LINE } from '../src/router/batch-line.ts';
import { SCHEDULE_CALL } from '../src/schedules/caller.ts';
import { MODELS, startRouter, type Harness } from './helpers.ts';

let h: Harness, owner: Awaited<ReturnType<Harness['fundedKey']>>;
let reader: { hash: string; secret: string; auth: Record<string, string> };
const chat = { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 };
const month = new Date().toISOString().slice(0, 7), day = new Date().toISOString().slice(0, 10);
const range = `?from=${day}&to=${day}`;
beforeAll(async () => {
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: 'true', AGENT_GUARD_ENABLED: 'true', STATEMENTS_ENABLED: 'true', SPEND_INSIGHTS_ENABLED: 'true', TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '1' } });
  owner = await h.fundedKey();
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { scope: 'read', name: 'Accounting' } });
  expect(r.status).toBe(201);
  const body = await r.json();
  expect(body.data).toMatchObject({ scope: 'read', management: false });
  reader = { hash: body.data.hash, secret: body.key, auth: { authorization: `Bearer ${body.key}` } };
});
afterAll(async () => { await h?.close(); });

async function refused(path: string, method = 'GET', headers = reader.auth) {
  const response = await h.request(path, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { json: {} }) });
  expect(response.status, `${method} ${path}`).toBe(403);
  if (method !== 'HEAD') expect((await response.json()).error.type, `${method} ${path}`).toBe('read_only_key'); // HEAD has no body
}

test('explicit GET allow-list; every other method and unknown or paid GET fails closed', () => {
  for (const path of ['/api/v1/activity', '/api/v1/insights', '/api/v1/statements/2026-10', '/api/v1/lane-report', '/api/v1/proof-pack', '/api/v1/proof-pack/limits', '/api/v1/inbox', '/api/v1/keys', '/api/v1/agents', `/api/v1/agents/${'a'.repeat(64)}/policy/versions`, '/api/v1/status']) {
    expect(readRouteAllowed('GET', path), path).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) expect(readRouteAllowed(method, path)).toBe(false);
  }
  for (const path of ['/unknown', '/api/v1/new-dashboard', '/api/v1/data/stock/AAPL', '/api/v1/data/ipx/text', '/api/v1/keys/current-ip', '/api/v1/keys/cleanup', '/api/v1/keys/not-a-hash', '/api/v1/wallet', '/api/v1/credits/withdrawal-proof', '/api/v1/agents/me/sealed', '/api/v1/schedules', '/api/v1/webhooks', '/api/v1/sessions', '/api/v1/keys/defaults/secret']) expect(readRouteAllowed('GET', path), path).toBe(false);
});

test('account readers and CSV succeed using existing handlers and account visibility', async () => {
  const call = await h.request('/api/v1/chat/completions', { method: 'POST', headers: owner.auth, json: chat });
  expect(call.status).toBe(200); await call.text();
  expect((await h.request(`/api/v1/agents/${owner.hash}/policy`, { method: 'PUT', headers: owner.auth, json: { version: 1, models: {}, caps: { per_request_usd: 1 }, on_breach: 'deny' } })).status).toBe(200);
  for (const path of ['/api/v1/key', '/api/v1/credits', '/api/v1/spend', '/api/v1/account/runway', '/api/v1/agents/approvals', '/api/v1/keys', `/api/v1/keys/${owner.hash}`, '/api/v1/keys/defaults', '/api/v1/activity', '/api/v1/activity?format=csv', '/api/v1/insights', `/api/v1/statements/${month}`, '/api/v1/lane-report' + range, '/api/v1/proof-pack/limits', '/api/v1/proof-pack' + range, '/api/v1/agents', `/api/v1/agents/${owner.hash}/policy`, `/api/v1/agents/${owner.hash}/policy/versions`, `/api/v1/agents/${owner.hash}/events`, `/api/v1/agents/${owner.hash}/ledger`, '/api/v1/inbox', '/api/v1/generations', '/api/v1/status']) {
    const res = await h.request(path, { headers: reader.auth });
    expect(res.status, path + ': ' + (res.status === 200 ? '' : await res.text())).toBe(200);
    if (path === '/api/v1/activity') expect((await res.json()).scope).toBe('account');
    if (path === '/api/v1/generations') expect((await res.json()).data.some((g: any) => g.id === call.headers.get('x-receipt-id'))).toBe(true);
    if (path === '/api/v1/activity?format=csv') expect(res.headers.get('content-type')).toContain('text/csv');
  }
  const outsider = await h.newKey();
  expect((await h.request(`/api/v1/keys/${outsider.hash}`, { headers: reader.auth })).status).toBe(404);
  expect((await h.request(`/api/v1/agents/${outsider.hash}/policy/versions`, { headers: reader.auth })).status).toBe(404);
  expect((await h.request('/api/v1/activity')).status).toBe(401);
});

test('all registered writes and unlisted GET routes refuse before their handlers', async () => {
  // Hono middleware entries also appear in routes; only actual method registrations count.
  const routes = new Map(h.app.routes.filter(r => r.method !== 'ALL').map(r => [`${r.method} ${r.path}`, r]));
  for (const { method, path } of routes.values()) {
    const concrete = path.replace(/:[A-Za-z_]+/g, 'a'.repeat(64)).replace(/\*/g, 'sample');
    if (readRouteAllowed(method, concrete) || method === 'OPTIONS') continue; // CORS preflight never invokes a handler.
    await refused(concrete, method);
  }
  for (const prefix of ['/api/v1', '/v1']) for (const suffix of ['chat/completions', 'completions', 'embeddings', 'responses', 'messages']) await refused(`${prefix}/${suffix}`, 'POST');
  await refused('/api/v1/not-yet-added');
  await refused('/api/v1/messages', 'POST', { 'x-api-key': reader.secret });
  await refused('/api/v1/keys', 'POST', { ...owner.auth, 'x-api-key': reader.secret });
  await refused('/trpc/keys.update', 'POST', { 'x-admin-token': reader.secret });
  const [row] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, reader.hash));
  expect(row.spentTotal).toBe(0n); expect(row.lastUsed).toBeNull();
  expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, reader.hash))).toEqual([]);
  expect(await h.ctx.db.select().from(holds).where(eq(holds.keyHash, reader.hash))).toEqual([]);
});

test('creation requires a management owner, scope stays fixed, and read keys cannot gain management', async () => {
  const ordinary = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: {} });
  const member = { authorization: `Bearer ${(await ordinary.json()).key}` };
  for (const [headers, status] of [[{}, 403], [{ authorization: 'Bearer invalid' }, 401], [member, 403], [reader.auth, 403]] as const) expect((await h.request('/api/v1/keys', { method: 'POST', headers, json: { scope: 'read' } })).status).toBe(status);
  for (const spec of [{ management: true }, { team: 'sample-team' }]) expect((await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { scope: 'read', ...spec } })).status).toBe(400);
  expect((await h.request(`/api/v1/keys/${reader.hash}`, { method: 'PATCH', headers: owner.auth, json: { scope: 'account' } })).status).toBe(400);
  expect((await h.request(`/api/v1/keys/${reader.hash}`, { method: 'PATCH', headers: owner.auth, json: { management: true } })).status).toBe(403);
});

test('stored read restrictions remain with inference provisioning off; normal keys retain writes', async () => {
  expect(h.ctx.cfg.inferenceKeysEnabled).toBe(false);
  await refused('/api/v1/chat/completions', 'POST');
  expect((await h.request(`/api/v1/keys/${reader.hash}`, { method: 'PATCH', headers: owner.auth, json: { name: 'Report reader' } })).status).toBe(200);
  const off = await startRouter();
  try {
    const offOwner = await off.newKey();
    const created = await off.request('/api/v1/keys', { method: 'POST', headers: offOwner.auth, json: { scope: 'read' } });
    expect(created.status).toBe(201);
    const auth = { authorization: `Bearer ${(await created.json()).key}` };
    expect((await off.request('/api/v1/lane-report' + range, { headers: auth })).status).toBe(404);
    expect((await off.request('/api/v1/activity', { headers: auth })).status).toBe(200);
  } finally { await off.close(); }
});

test('read keys keep IP, disabled and expiry checks', async () => {
  const patch = (json: unknown) => h.request(`/api/v1/keys/${reader.hash}`, { method: 'PATCH', headers: owner.auth, json });
  expect((await patch({ allowed_ips: ['203.0.113.9'] })).status).toBe(200);
  expect((await h.request('/api/v1/activity', { headers: { ...reader.auth, 'x-forwarded-for': '203.0.113.9' } })).status).toBe(200);
  const denied = await h.request('/api/v1/activity', { headers: { ...reader.auth, 'x-forwarded-for': '198.51.100.8' } });
  expect(denied.status).toBe(403); expect((await denied.json()).error.type).toBe('ip_not_allowed');
  await patch({ allowed_ips: null, disabled: true });
  expect((await h.request('/api/v1/activity', { headers: reader.auth })).status).toBe(401);
  await patch({ disabled: false, expires_at: new Date(Date.now() - 60_000).toISOString() });
  expect((await h.request('/api/v1/status', { headers: reader.auth })).status).toBe(401);
  await patch({ expires_at: null });
});

test('internal paid calls cannot substitute a read key', async () => {
  for (const capability of [
    { [BATCH_LINE]: { keyHash: reader.hash, batchId: 'sample-batch', idx: 0, discountBps: 10000, generationId: 'sample-generation' } },
    { [SCHEDULE_CALL]: { ownerHash: owner.hash, keyHash: reader.hash, maxCostPico: 1000000000000n, generationId: 'sample-run' } },
    { [SCHEDULE_CALL]: { ownerHash: reader.hash, keyHash: owner.hash, maxCostPico: 1000000000000n, generationId: 'sample-run' } },
  ]) {
    const res = await h.app.request('/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chat) }, capability);
    expect(res.status).toBe(403); expect((await res.json()).error.type).toBe('read_only_key');
  }
});


test('approval and inbox reads preserve records and do not offer decision rights', async () => {
  const id = 'sample-expired-approval';
  await h.ctx.db.insert(agentApprovals).values({ id, keyHash: owner.hash, intent: { kind: 'inference', model: MODELS.llama.slug, lane: 'public', est_cost_pico: '1', tools: [] }, intentHash: 'a'.repeat(64), maxCostPico: 1n, expiresAt: new Date(Date.now() - 60_000) });
  expect((await h.request('/api/v1/agents/approvals', { headers: reader.auth })).status).toBe(200);
  const [row] = await h.ctx.db.select().from(agentApprovals).where(eq(agentApprovals.id, id));
  expect(row.status).toBe('pending');
  await h.ctx.db.update(agentApprovals).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(agentApprovals.id, id));
  const inbox = await (await h.request('/api/v1/inbox', { headers: reader.auth })).json();
  expect(inbox.data.find((item: any) => item.approval_id === id).can_decide).toBe(false);
});
