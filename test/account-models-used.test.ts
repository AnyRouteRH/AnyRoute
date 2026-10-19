import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { generations, keys, ledger, teamMembers } from '../src/db/schema.ts';
import { readModelsUsed } from '../src/account/models-used.ts';
import { readModelSummary } from '../src/account/model-summary.ts';
import { MODELS, startRouter, type Harness } from './helpers.ts';

let h: Harness;
const MODEL = MODELS.qwen.slug, OTHER = MODELS.llama.slug;
const PATH = '/api/v1/account/models/used';
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h?.close(); });
async function row(key: Key) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0]; }
async function child(owner: Key) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Catalogue key' } });
  expect(r.status).toBe(201); const j = await r.json();
  return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
async function call(key: Key, id: string, extra: Partial<typeof generations.$inferInsert> = {}) {
  await h.ctx.db.insert(generations).values({ id, keyHash: key.hash, accountId: (await row(key)).accountId,
    modelId: MODEL, providerId: 'alpha', mode: 'prepaid', ts: new Date(Date.now() - 86400000), cost: 1000000000n,
    tokensIn: 1000, tokensOut: 500, receipt: { lane: 'public', disclosure: 'vendor-forwarded' }, ...extra });
}
async function read(key: Key) {
  const r = await h.request(PATH, { headers: key.auth });
  expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); return r.json();
}
test('lists used models by exact net spend, with 30-day calls, success and posted refunds', async () => {
  const owner = await h.fundedKey();
  await call(owner, 'used-ok'); await call(owner, 'used-error', { finishReason: 'error' });
  await call(owner, 'used-cancelled', { cancelled: true });
  await call(owner, 'used-month', { ts: new Date(Date.now() - 20 * 86400000) });
  await call(owner, 'used-cheaper', { modelId: OTHER, cost: 3900000000n });
  await call(owner, 'used-old', { ts: new Date(Date.now() - 31 * 86400000) });
  await call(owner, 'used-future', { ts: new Date(Date.now() + 86400000) });
  await h.ctx.db.insert(ledger).values({ id: 'used-refund', ref: 'used-refund', keyHash: owner.hash, accountId: (await row(owner)).accountId, kind: 'refund', generationId: 'used-ok', amount: 200000000n });
  const report = await read(owner);
  expect(report).toMatchObject({ scope: 'account', days: 30 });
  expect(report.data.map((r: { model: string }) => r.model)).toEqual([OTHER, MODEL]);
  expect(report.data[1]).toMatchObject({ calls: '4', succeeded: '2', success_rate: 50, charged_usd: '0.004', refunded_usd: '0.0002', cost_usd: '0.0038' });
  const summary = await readModelSummary(h.ctx, await row(owner), MODEL);
  expect(summary.savings).not.toBeNull();
  expect(report.data[1].cost_usd).toBe(summary.usage.cost_usd);
  expect(report.data[1].cheaper_option).toEqual(summary.savings?.alternative ?? null);
  expect(new Date(report.to).getTime() - new Date(report.from).getTime()).toBe(30 * 86400000);
});
test('Activity scoping blocks cross-account/key data and preserves removed-key account stamps', async () => {
  const owner = await h.fundedKey(), agent = await child(owner), other = await h.fundedKey();
  await call(owner, 'used-owner'); await call(agent, 'used-agent', { accountId: null });
  await call(other, 'used-other', { cost: 900000000000n });
  await call(owner, 'used-conflicting', { accountId: (await row(other)).accountId });
  expect((await read(owner)).data[0].calls).toBe('2');
  expect(await read(agent)).toMatchObject({ scope: 'key', data: [{ calls: '1', cost_usd: '0.001' }] });
  await h.ctx.db.update(generations).set({ accountId: (await row(owner)).accountId }).where(eq(generations.id, 'used-agent'));
  await h.ctx.db.delete(keys).where(eq(keys.keyHash, agent.hash));
  expect((await read(owner)).data[0].calls).toBe('2');
});
test('team administrators see account calls and sessions remain on their own key', async () => {
  const owner = await h.fundedKey(), admin = await child(owner), member = await child(owner);
  await h.ctx.db.update(keys).set({ teamId: 'used-team' }).where(eq(keys.keyHash, admin.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: 'used-team', keyHash: admin.hash, role: 'admin' });
  await call(member, 'used-team-call');
  expect(await read(admin)).toMatchObject({ scope: 'account', data: [{ calls: '1' }] });
  const r = await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } });
  expect(r.status).toBe(201); const s = (await r.json()).data;
  const session = { hash: s.key_hash, auth: { authorization: 'Bearer ' + s.key } };
  await call(session, 'used-session');
  await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, session.hash));
  expect(await read(session)).toMatchObject({ scope: 'key', data: [{ calls: '1' }] });
});
test('includes free calls, applies exact rolling bounds and omits unknown/hidden models', async () => {
  const owner = await h.fundedKey(), now = new Date(), from = new Date(now.getTime() - 30 * 86400000);
  await call(owner, 'used-start', { ts: from, cost: 0n, modelId: OTHER });
  await call(owner, 'used-end', { ts: now });
  await call(owner, 'used-before', { ts: new Date(from.getTime() - 1) });
  await call(owner, 'used-missing', { modelId: 'sample/missing' });
  const report = await readModelsUsed(h.ctx, await row(owner), now);
  expect(report.data).toMatchObject([{ model: OTHER, calls: '1', cost_usd: '0', success_rate: 100 }]);
  expect(report.data).toHaveLength(1);
  const model = h.ctx.catalog.models.get(OTHER)!; model.hidden = true;
  try { expect((await readModelsUsed(h.ctx, await row(owner), now)).data).toEqual([]); } finally { model.hidden = false; }
});
test('does not truncate at Insights group limits and sorts tiny decimal differences exactly', async () => {
  const owner = await h.fundedKey(), key = await row(owner), source = h.ctx.catalog.models.get(MODEL)!;
  const ids = Array.from({ length: 102 }, (_, i) => 'sample/used-' + i.toString().padStart(3, '0'));
  for (const id of ids) h.ctx.catalog.models.set(id, { ...source, id });
  try {
    await h.ctx.db.insert(generations).values(ids.map((model, i) => ({ id: 'used-many-' + i, keyHash: owner.hash, accountId: key.accountId,
      modelId: model, providerId: 'alpha', mode: 'prepaid', ts: new Date(Date.now() - 86400000), cost: 9007199254740992n + BigInt(i === 0 ? 1 : 0) })));
    const report = await read(owner);
    expect(report.data).toHaveLength(102);
    expect(report.data.map((r: { model: string }) => r.model)).toEqual(ids);
    expect(report.data[0].cost_usd).toBe('9007.199254740993');
  } finally { for (const id of ids) h.ctx.catalog.models.delete(id); }
});
test('auth and read-only refusal; empty/default has no background work or new flag', async () => {
  expect((await h.request(PATH)).status).toBe(401);
  expect((await h.request(PATH, { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
  const owner = await h.fundedKey();
  expect(await read(owner)).toMatchObject({ scope: 'account', data: [], days: 30 });
  expect(h.ctx.cfg.modelWatchEnabled).toBe(false);
  const agent = await child(owner);
  await h.ctx.db.update(keys).set({ scope: 'read' }).where(eq(keys.keyHash, agent.hash));
  expect((await h.request(PATH, { headers: agent.auth })).status).toBe(403);
  await h.ctx.db.update(keys).set({ scope: null, disabled: true }).where(eq(keys.keyHash, agent.hash));
  expect((await h.request(PATH, { headers: agent.auth })).status).toBe(401);
  await h.ctx.db.update(keys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request(PATH, { headers: owner.auth })).status).toBe(401);
});
