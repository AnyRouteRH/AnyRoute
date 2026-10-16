import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startRouter, type Harness } from './helpers.ts';
import { accountCheckupItems, readAccountCheckup } from '../web/lib/account-checkup.js';

let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: 'true', LOW_BALANCE_ALERTS_ENABLED: 'true', SECURITY_ALERTS_ENABLED: 'true', TELEGRAM_LINKING_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '177:fixture-only-telegram-token' } }); });
afterAll(async () => { await h?.close(); });
function request(router: Harness, auth?: Record<string, string>) {
  return async (path: string) => {
    const response = await router.request(path, { headers: auth });
    const body = await response.json();
    if (!response.ok) throw Object.assign(Error(body.error.message), { status: response.status });
    return body;
  };
}
async function workspace(router: Harness, auth: Record<string, string>) {
  const read = request(router, auth);
  return { me: (await read('/api/v1/key')).data, keys: (await read('/api/v1/keys')).data };
}
test('J177 composes owner-visible APIs and sees saved controls without adding server data', async () => {
  const owner = await h.newKey(), other = await h.newKey();
  const read = request(h, owner.auth), ws = await workspace(h, owner.auth);
  let value = await readAccountCheckup(read, { workspace: ws });
  expect(value.errors).toEqual([]);
  expect(accountCheckupItems({ workspace: ws, ...value }).map(item => item.id)).toContain('balance');
  expect(ws.keys.some(row => row.hash === other.hash)).toBe(false);
  expect((await h.request('/api/v1/account/low-balance', { method: 'PATCH', headers: owner.auth, json: { low_balance_usd: 2 } })).status).toBe(200);
  expect((await h.request('/api/v1/account/security-alerts', { method: 'PATCH', headers: owner.auth, json: { enabled: false } })).status).toBe(200);
  value = await readAccountCheckup(read, { workspace: ws });
  const ids = accountCheckupItems({ workspace: ws, ...value }).map(item => item.id);
  expect(ids).not.toContain('balance'); expect(ids).toContain('security');
});
test('J177 real unauthenticated route reads remain unauthorized', async () => {
  const owner = await h.newKey();
  const value = await readAccountCheckup(request(h), { workspace: await workspace(h, owner.auth) });
  expect(value.errors).toHaveLength(4); expect(value.telegram).toBeUndefined(); expect(value.security).toBeUndefined();
});
test('J177 ordinary keys retain existing forbidden settings visibility', async () => {
  const owner = await h.newKey();
  const created = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Worker' } });
  const child = await created.json(); expect(created.status).toBe(201);
  const auth = { authorization: 'Bearer ' + child.key };
  const value = await readAccountCheckup(request(h, auth), { workspace: { me: (await request(h, auth)('/api/v1/key')).data } });
  expect(value.errors).toHaveLength(4); expect(value.balance).toBeUndefined();
});
test('J177 read-only keys remain refused and no new GET allow-list entry exists', async () => {
  const owner = await h.newKey();
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Read account', scope: 'read' } });
  expect(response.status).toBe(201); const child = await response.json(), auth = { authorization: 'Bearer ' + child.key };
  const ws = await workspace(h, auth);
  await expect(readAccountCheckup(request(h, auth), { workspace: ws })).rejects.toMatchObject({ status: 403 });
  expect((await h.request('/api/v1/account/checkup', { headers: auth })).status).toBe(403);
});
test('J177 existing default-off switches leave checks unavailable, never recommended as configured', async () => {
  const off = await startRouter();
  try {
    const owner = await off.newKey(), ws = await workspace(off, owner.auth);
    const value = await readAccountCheckup(request(off, owner.auth), { workspace: ws });
    expect(value.balance.enabled).toBe(false); expect(value.errors.some(message => message.startsWith('Security alerts: not switched on here'))).toBe(true);
    expect(accountCheckupItems({ workspace: ws, ...value }).map(item => item.id)).not.toContain('balance');
    expect(accountCheckupItems({ workspace: ws, ...value }).map(item => item.id)).not.toContain('security');
  } finally { await off.close(); }
});
