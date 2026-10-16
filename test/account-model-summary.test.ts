import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { generations, keys, kv, teamMembers, ledger } from '../src/db/schema.ts';
import { sha256 } from '../src/lib/util.ts';
import { prefsKey } from '../src/notifications/prefs.ts';
import { readModelSummary } from '../src/account/model-summary.ts';
import { readInsights } from '../src/insights/read.ts';
import { insightsQuery } from '../src/insights/query.ts';
import { readSavings } from '../src/savings/read.ts';
import { savingsQuery } from '../src/savings/query.ts';
import { MODELS, startRouter, type Harness } from './helpers.ts';
let h: Harness;
const MODEL = MODELS.qwen.slug;
const path = (id = MODEL) => '/api/v1/account/models/' + encodeURIComponent(id) + '/summary';
type Key = { hash: string; auth: Record<string, string> };
beforeAll(async () => { h = await startRouter(); });
afterAll(async () => { await h?.close(); });
async function child(owner: Key) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Model activity key' } });
  expect(r.status).toBe(201); const j = await r.json(); return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
async function row(key: Key) { return (await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)))[0]; }
async function call(key: Key, id: string, extra: Partial<typeof generations.$inferInsert> = {}) {
  await h.ctx.db.insert(generations).values({ id, accountId: (await row(key)).accountId, keyHash: key.hash, modelId: MODEL, providerId: 'alpha', mode: 'prepaid', ts: new Date(Date.now() - 86400000), cost: 1000000000n, tokensIn: 1000, tokensOut: 500, receipt: { lane: 'public', disclosure: 'vendor-forwarded' }, ...extra });
}
async function read(key: Key) {
  const r = await h.request(path(), { headers: key.auth }); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); return r.json();
}
test('composition matches existing readers, exact spend/refunds, model and time windows', async () => {
  const owner = await h.fundedKey();
  await call(owner, 'summary-ok'); await call(owner, 'summary-error', { finishReason: 'error' });
  await call(owner, 'summary-month', { ts: new Date(Date.now() - 20 * 86400000) });
  await call(owner, 'summary-other-model', { modelId: MODELS.llama.slug });
  await call(owner, 'summary-old', { ts: new Date(Date.now() - 31 * 86400000) });
  await call(owner, 'summary-future', { ts: new Date(Date.now() + 86400000) });
  await h.ctx.db.insert(ledger).values({ id: 'summary-refund', ref: 'summary-refund', accountId: (await row(owner)).accountId, keyHash: owner.hash, kind: 'refund', amount: 100000000n, generationId: 'summary-ok' });
  const now = new Date(), key = await row(owner), range = savingsQuery({}, now);
  const result = await readModelSummary(h.ctx, key, MODEL, now);
  const insights = await readInsights(h.ctx, key, insightsQuery({ from: range.from, to: range.to }));
  expect(result.usage).toMatchObject({ calls: '3', charged_usd: '0.003', refunded_usd: '0.0001', cost_usd: '0.0029' });
  expect(result.usage.cost_usd).toBe(insights.models.find(r => r.id === MODEL)!.cost_usd);
  expect(result.reliability).toMatchObject({ days: 7, calls: '2', succeeded: '1', success_rate: 50 });
  expect(result.savings).toEqual((await readSavings(h.ctx, key, range)).models.find(r => r.model === MODEL)!);
  expect(result.price_notice).toBeNull(); expect(result.price_notices_visible).toBe(false);
});
test('Activity scoping prevents cross-account/key leakage and retains deleted-key stamps', async () => {
  const owner = await h.fundedKey(), agent = await child(owner), other = await h.fundedKey();
  await call(owner, 'summary-scope-owner'); await call(agent, 'summary-scope-agent'); await call(other, 'summary-scope-other', { cost: 999000000000n });
  await call(owner, 'summary-mismatch', { accountId: (await row(other)).accountId });
  expect(await read(owner)).toMatchObject({ scope: 'account', usage: { calls: '2', charged_usd: '0.002' } });
  expect(await read(agent)).toMatchObject({ scope: 'key', usage: { calls: '1' } });
  await h.ctx.db.delete(keys).where(eq(keys.keyHash, agent.hash));
  expect((await read(owner)).usage.calls).toBe('2');
});
test('team admins keep Activity call visibility; sessions stay on their own key', async () => {
  const owner = await h.fundedKey(), admin = await child(owner), member = await child(owner);
  await h.ctx.db.update(keys).set({ teamId: 'summary-team' }).where(eq(keys.keyHash, admin.hash));
  await h.ctx.db.insert(teamMembers).values({ teamId: 'summary-team', keyHash: admin.hash, role: 'admin' });
  await call(member, 'summary-team-member'); expect(await read(admin)).toMatchObject({ scope: 'account', usage: { calls: '1' } });
  const r = await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } });
  expect(r.status).toBe(201); const s = (await r.json()).data;
  const session = { hash: s.key_hash, auth: { authorization: 'Bearer ' + s.key } };
  await call(session, 'summary-session'); await h.ctx.db.update(keys).set({ management: true }).where(eq(keys.keyHash, session.hash));
  expect(await read(session)).toMatchObject({ scope: 'key', usage: { calls: '1' }, price_notice: null });
});
test('price notices reuse retained history, management and inbox preferences; flags default off', async () => {
  expect(h.ctx.cfg.modelWatchEnabled).toBe(false); expect(h.ctx.cfg.priceNoticesEnabled).toBe(false);
  const owner = await h.fundedKey(), agent = await child(owner), account = (await row(owner)).accountId;
  const at = new Date().toISOString();
  await h.ctx.db.insert(kv).values({ key: 'price-notices:daily:' + sha256(account) + ':' + at.slice(0, 10), value: { account, day: at.slice(0, 10), items: [{ id: 'summary-notice', at, model: MODEL, title: 'Model input rate changed' }], overflow: 0 } });
  expect((await read(owner)).price_notice).toBeNull();
  h.ctx.cfg.priceNoticesEnabled = true;
  try {
    expect((await read(owner)).price_notice).toEqual({ at, title: 'Model input rate changed' });
    expect((await read(agent)).price_notice).toBeNull();
    await h.ctx.db.insert(kv).values({ key: prefsKey(account), value: { channels: { price_notices: { inbox: false, telegram: true } } } });
    expect(await read(owner)).toMatchObject({ price_notice: null, price_notices_visible: false });
  } finally { h.ctx.cfg.priceNoticesEnabled = false; }
});
test('auth, read-only refusal, unknown/hidden model and empty/default behaviour', async () => {
  expect((await h.request(path())).status).toBe(401);
  expect((await h.request(path(), { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
  const owner = await h.fundedKey();
  expect(await read(owner)).toMatchObject({ usage: { calls: '0', cost_usd: '0' }, reliability: { calls: '0', success_rate: null }, savings: null, price_notice: null });
  expect((await h.request(path('missing/model'), { headers: owner.auth })).status).toBe(404);
  const model = h.ctx.catalog.models.get(MODEL)!; model.hidden = true;
  try { expect((await h.request(path(), { headers: owner.auth })).status).toBe(404); } finally { model.hidden = false; }
  const agent = await child(owner); await h.ctx.db.update(keys).set({ scope: 'read' }).where(eq(keys.keyHash, agent.hash));
  expect((await h.request(path(), { headers: agent.auth })).status).toBe(403);
  await h.ctx.db.update(keys).set({ scope: null, disabled: true }).where(eq(keys.keyHash, agent.hash));
  expect((await h.request(path(), { headers: agent.auth })).status).toBe(401);
  await h.ctx.db.update(keys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(keys.keyHash, owner.hash));
  expect((await h.request(path(), { headers: owner.auth })).status).toBe(401);
});
