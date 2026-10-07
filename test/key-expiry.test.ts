// C127: exercise the existing API, with all expiry behavior on the default configuration.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startRouter, MODELS, type Harness } from './helpers.ts';

let h: Harness;
let owner: Awaited<ReturnType<Harness['fundedKey']>>;
beforeAll(async () => { h = await startRouter(); owner = await h.fundedKey(); });
afterAll(async () => { await h?.close(); });
async function create(spec: Record<string, unknown> = {}) {
  const res = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Expiry key', ...spec } });
  expect(res.status).toBe(201);
  const body = await res.json();
  return { data: body.data, auth: { authorization: `Bearer ${body.key}` } };
}
const patch = (hash: string, json: Record<string, unknown>, headers = owner.auth) => h.request(`/api/v1/keys/${hash}`, { method: 'PATCH', headers, json });

test('default keys have no expiry; create, read, list, patch and clear round-trip ISO dates', async () => {
  const plain = await create();
  expect(plain.data.expires_at).toBeNull();
  expect((await h.request('/api/v1/key', { headers: plain.auth })).status).toBe(200);
  const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const key = await create({ expires_at: deadline });
  expect(key.data.expires_at).toBe(deadline);
  const read = await h.request(`/api/v1/keys/${key.data.hash}`, { headers: owner.auth });
  expect((await read.json()).data.expires_at).toBe(deadline);
  const list = (await (await h.request('/api/v1/keys', { headers: owner.auth })).json()).data;
  expect(list.find((row: any) => row.hash === key.data.hash).expires_at).toBe(deadline);
  expect((await (await patch(key.data.hash, { name: 'Renamed expiry key' })).json()).data.expires_at).toBe(deadline);
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
  expect((await (await patch(key.data.hash, { expires_at: later })).json()).data.expires_at).toBe(later);
  expect((await (await patch(key.data.hash, { expires_at: null })).json()).data.expires_at).toBeNull();
});

test('expired credentials are refused on inference, stay listed, and work after owner extends them', async () => {
  const key = await create({ expires_at: new Date(Date.now() - 60_000).toISOString() });
  const call = () => h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth,
    json: { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 } });
  const denied = await call();
  expect(denied.status).toBe(401);
  expect((await denied.json()).error.type).toBe('key_expired');
  expect((await h.request('/api/v1/key', { headers: key.auth })).status).toBe(401);
  const list = (await (await h.request('/api/v1/keys', { headers: owner.auth })).json()).data;
  expect(list.find((row: any) => row.hash === key.data.hash)).toMatchObject({ disabled: false, usage: 0, expires_at: key.data.expires_at });
  expect((await patch(key.data.hash, { expires_at: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(200);
  const accepted = await call();
  expect(accepted.status).toBe(200);
  await accepted.text();
});

test('removing expiry never re-enables a separately disabled key', async () => {
  const key = await create({ disabled: true, expires_at: new Date(0).toISOString() });
  const result = await patch(key.data.hash, { expires_at: null });
  expect(result.status).toBe(200);
  expect((await result.json()).data).toMatchObject({ disabled: true, expires_at: null });
  const denied = await h.request('/api/v1/key', { headers: key.auth });
  expect(denied.status).toBe(401);
  expect((await denied.json()).error.type).toBe('key_disabled');
});

test('expiry edits retain authentication, ownership, team role and scope guards', async () => {
  const key = await create();
  expect((await patch(key.data.hash, { expires_at: null }, {})).status).toBe(401);
  const outsider = await h.fundedKey();
  expect((await patch(key.data.hash, { expires_at: null }, outsider.auth)).status).toBe(404);
  expect((await h.request('/api/v1/keys', { method: 'POST', headers: { authorization: 'Bearer invalid' }, json: { expires_at: null } })).status).toBe(401);
  const team = (await (await h.request('/api/v1/teams', { method: 'POST', headers: owner.auth, json: { name: 'Expiry team' } })).json()).data.id;
  const viewer = await create({ team, role: 'viewer' });
  const admin = await create({ team, role: 'admin' });
  const target = await create({ team });
  expect((await patch(target.data.hash, { expires_at: null }, viewer.auth)).status).toBe(403);
  expect((await patch(key.data.hash, { expires_at: null }, admin.auth)).status).toBe(403);
});

test('malformed expiry dates are rejected without changing the stored date', async () => {
  const key = await create();
  for (const expires_at of ['tomorrow', '2030-01-01', 123]) {
    expect((await patch(key.data.hash, { expires_at })).status).toBe(400);
    expect((await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { expires_at } })).status).toBe(400);
  }
  const read = await h.request(`/api/v1/keys/${key.data.hash}`, { headers: owner.auth });
  expect((await read.json()).data.expires_at).toBeNull();
});
