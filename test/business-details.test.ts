import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { startRouter, type Harness } from './helpers.ts';
import { accounts, keys, kv, teamMembers } from '../src/db/schema.ts';
import { businessDetailsBody, readBusinessDetails, saveBusinessDetails } from '../src/statements/business-details.ts';
import { readStatement } from '../src/statements/read.ts';
import { verifyStatement } from '../web/lib/statements.js';
import { statementCsv } from '../web/lib/business-details.js';
let h: Harness;
const path = '/api/v1/account/business-details';
const month = '2026-05';
const fixed = new Date('2026-06-15T00:00:00Z');
const details = { business_name: 'Example Studio', address: '12 Sample Road\nSuite 3', tax_id: 'GST sample-123', reference: 'Purchase order 42' };
beforeAll(async () => { h = await startRouter({ env: { STATEMENTS_ENABLED: 'true', AGENT_POLICY_ENABLED: 'true' } }); });
afterAll(async () => { await h?.close(); });
async function fixture() {
  const owner = await h.fundedKey();
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.update(accounts).set({ createdAt: new Date('2026-04-01T00:00:00Z') }).where(eq(accounts.id, key.accountId));
  return { owner, key };
}
async function child(owner: { auth: Record<string, string> }) {
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Statement reader' } });
  expect(response.status).toBe(201);
  const result = await response.json();
  return { hash: result.data.hash, auth: { authorization: 'Bearer ' + result.key } };
}
test('strict optional fields, bounded text, multiline address, no email reference', () => {
  expect(businessDetailsBody.parse({})).toEqual({ business_name: '', address: '', tax_id: '', reference: '' });
  expect(businessDetailsBody.parse({ ...details, address: '  Line one\r\nLine two  ' }).address).toBe('Line one\nLine two');
  for (const [field, max] of [['business_name',160],['address',1000],['tax_id',120],['reference',240]] as const) {
    expect(businessDetailsBody.parse({ [field]: 'x'.repeat(max) })[field]).toHaveLength(max);
    expect(businessDetailsBody.safeParse({ [field]: 'x'.repeat(max+1) }).success).toBe(false);
    expect(businessDetailsBody.safeParse({ [field]: 42 }).success).toBe(false);
    expect(businessDetailsBody.safeParse({ [field]: null }).success).toBe(false);
  }
  for (const invalid of [{ billing_email: 'billing@example.invalid' }, { account_id: 'other' }, { reference: 'Send to billing@example.invalid' }, { business_name: 'One\nTwo' }, { tax_id: 'x\u0000' }, { address: 'x\u0000' }]) expect(businessDetailsBody.safeParse(invalid).success).toBe(false);
});
test('management saves account-scoped details, replaces fields and Delete removes the kv row', async () => {
  const { owner, key } = await fixture(), other = await fixture();
  const get = await h.request(path, { headers: owner.auth });
  expect(get.status).toBe(200); expect(get.headers.get('cache-control')).toBe('no-store');
  expect(await get.json()).toEqual({ data: null, editable: true });
  const saved = await h.request(path, { method: 'PUT', headers: owner.auth, json: details });
  expect(saved.status).toBe(200); expect(saved.headers.get('cache-control')).toBe('no-store'); expect((await saved.json()).data).toEqual(details);
  expect((await (await h.request(path, { headers: other.owner.auth })).json()).data).toBeNull();
  expect((await (await h.request(path, { method: 'PUT', headers: owner.auth, json: { reference: 'New reference' } })).json()).data).toEqual({ business_name: '', address: '', tax_id: '', reference: 'New reference' });
  const deleted = await h.request(path, { method: 'PUT', headers: owner.auth, json: {} });
  expect(deleted.status).toBe(200); expect((await deleted.json()).data).toBeNull();
  expect(await readBusinessDetails(h.ctx, key.accountId)).toBeNull();
  expect(await h.ctx.db.select().from(kv).where(eq(kv.key, `business-details:${key.accountId}`))).toHaveLength(0);
  await saveBusinessDetails(h.ctx, key.accountId, details);
  expect((await (await h.request(path, { method: 'PUT', headers: owner.auth, json: { business_name: '  ', reference: '' } })).json()).data).toBeNull();
});
test('routes reject missing, invalid, disabled and expired auth and invalid bodies without modifying settings', async () => {
  const { owner, key } = await fixture();
  for (const method of ['GET','PUT']) {
    expect((await h.request(path, { method, ...(method === 'PUT' ? { json: details } : {}) })).status).toBe(401);
    expect((await h.request(path, { method, headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
  }
  await saveBusinessDetails(h.ctx, key.accountId, details);
  for (const invalid of [{ business_name: 'x'.repeat(161) }, { address: 'x'.repeat(1001) }, { tax_id: 'x'.repeat(121) }, { reference: 'x'.repeat(241) }, { reference: 'billing@example.invalid' }, { unknown: 'field' }, { business_name: 123 }]) expect((await h.request(path, { method: 'PUT', headers: owner.auth, json: invalid })).status).toBe(400);
  expect(await readBusinessDetails(h.ctx, key.accountId)).toEqual(details);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
  for (const method of ['GET','PUT']) expect((await h.request(path, { method, headers: owner.auth, ...(method === 'PUT' ? { json: {} } : {}) })).status).toBe(401);
  await h.ctx.db.update(keys).set({ disabled: false, expiresAt: new Date('2020-01-01') }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request(path, { headers: owner.auth })).status).toBe(401);
});
test('members, team admin/owner and sessions can read but cannot edit, including elevated session metadata', async () => {
  const { owner, key } = await fixture(), member = await child(owner), admin = await child(owner);
  await saveBusinessDetails(h.ctx, key.accountId, details);
  const teamId = 'business-team-' + admin.hash.slice(0,12);
  await h.ctx.db.update(keys).set({ teamId }).where(eq(keys.keyHash, admin.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId, keyHash: admin.hash, role: 'admin' });
  const session = (await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json()).data;
  await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, session.key_hash));
  for (const auth of [member.auth, admin.auth, { authorization: 'Bearer ' + session.key }]) {
    const read = await h.request(path, { headers: auth }); expect(read.status).toBe(200); expect(await read.json()).toEqual({ data: details, editable: false });
    expect((await h.request(path, { method: 'PUT', headers: auth, json: {} })).status).toBe(403);
  }
  await h.ctx.db.update(teamMembers).set({ role: 'owner' }).where(eq(teamMembers.keyHash, admin.hash));
  expect((await h.request(path, { method: 'PUT', headers: admin.auth, json: details })).status).toBe(403);
});
test('read-only guard stays closed on settings, but existing statement reads include unsigned details on request', async () => {
  const { owner, key } = await fixture(), reader = await child(owner), inference = await child(owner);
  await saveBusinessDetails(h.ctx, key.accountId, details);
  await h.ctx.db.update(keys).set({ scope: 'read' }).where(eq(keys.keyHash, reader.hash));
  await h.ctx.db.update(keys).set({ scope: 'inference' }).where(eq(keys.keyHash, inference.hash));
  for (const auth of [reader.auth, inference.auth]) for (const method of ['GET','PUT']) expect((await h.request(path, { method, headers: auth, ...(method === 'PUT' ? { json: details } : {}) })).status).toBe(403);
  const base = '/api/v1/statements/' + month;
  const ordinary = (await (await h.request(base, { headers: reader.auth })).json()).data;
  expect(Object.keys(ordinary).sort()).toEqual(['alg','key_id','payload','sig']);
  const response = await h.request(base + '?business_details=true', { headers: reader.auth });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const statement = (await response.json()).data;
  expect(statement.business_details).toEqual(details); expect(statement.payload.business_details).toBeUndefined();
  expect((await verifyStatement(statement, { keys: await h.ctx.signer.jwks() })).valid).toBe(true);
  expect((await h.request(base + '?business_details=true', { headers: inference.auth })).status).toBe(403);
});
test('payload and signature are byte-identical at a fixed read time after save, change and delete; CSV includes only optional unsigned identity', async () => {
  const { owner, key } = await fixture();
  const original = await readStatement(h.ctx, key, month, fixed);
  const absent = (await (await h.request('/api/v1/statements/' + month + '?business_details=true', { headers: owner.auth })).json()).data;
  expect(absent.business_details).toBeNull();
  expect(statementCsv(original)).not.toContain('Billed to');
  for (const value of [details, { ...details, business_name: 'Different Studio' }, businessDetailsBody.parse({})]) {
    await saveBusinessDetails(h.ctx, key.accountId, value);
    expect(await readStatement(h.ctx, key, month, fixed)).toEqual(original);
    expect(JSON.stringify(original)).not.toContain('business_name');
  }
  const csv = statementCsv(original, details);
  expect(csv).toContain('Billed to'); expect(csv).toContain('User-entered · outside the signed statement'); expect(csv).toContain('12 Sample Road\nSuite 3');
  expect(statementCsv(original, null)).not.toContain('Example Studio');
});
test('statements off by default also hides both business settings routes', async () => {
  const off = await startRouter();
  try {
    const owner = await off.fundedKey(); expect(off.ctx.cfg.statementsEnabled).toBe(false);
    for (const method of ['GET','PUT']) expect((await off.request(path, { method, headers: owner.auth, ...(method === 'PUT' ? { json: details } : {}) })).status).toBe(404);
    expect((await off.request('/api/v1/statements/' + month + '?business_details=true', { headers: owner.auth })).status).toBe(404);
  } finally { await off.close(); }
});
