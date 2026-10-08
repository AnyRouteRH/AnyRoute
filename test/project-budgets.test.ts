import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { generations, keys, holds, ledger } from "../src/db/schema.ts";
import { projectBudgetNotices, projectReservations } from "../src/db/project-budgets.ts";
import { assertProjectBudget, projectMonth, projectSpend, settleProjectReservation } from "../src/projects/budgets.ts";
import { reserve, release, settle } from "../src/ledger/ledger.ts";
import { deliverProjectBudgetTelegram } from "../src/projects/budget-notices.ts";
import { usdToPico } from "../src/lib/money.ts";
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { ANYROUTE_FEATURE_COUNCIL: "true" }, providers: [
  { id: 'alpha', name: 'Alpha', models: [MODELS.llama, MODELS.qwen, MODELS.embed, { id: 'project-rerank', slug: 'acme/project-rerank', prompt: '0.00000002', completion: '0', output: ['rerank'] }] },
  { id: 'beta', name: 'Beta', models: [MODELS.llamaPricey] },
] }); });
afterAll(async () => { await h?.close(); });
type Key = Awaited<ReturnType<Harness['fundedKey']>>;
const path = (name = 'checkout') => '/api/v1/projects/' + name + '/budget';
const put = (key: Key, budget_usd: number, name = 'checkout') => h.request(path(name), { method: 'PUT', headers: key.auth, json: { budget_usd } });
async function account(key: Key) { const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash)); return k.accountId; }
async function seed(key: Key, id: string, cost: number, ts = new Date()) {
  await h.ctx.db.insert(generations).values({ id, keyHash: key.hash, accountId: await account(key), modelId: MODELS.llama.slug, providerId: 'alpha', mode: 'prepaid', cost: usdToPico(cost), project: 'checkout', ts });
}
const callBody = { model: MODELS.llama.slug, messages: [{ role: 'user', content: 'Budget request' }], max_tokens: 16 };
test('UTC calendar months roll over December and leap day', () => {
  expect(projectMonth(new Date('2026-12-31T23:59:59Z'))).toMatchObject({ month: '2026-12', to: new Date('2027-01-01T00:00:00Z') });
  expect(projectMonth(new Date('2024-02-29T23:59:59Z')).to).toEqual(new Date('2024-03-01T00:00:00Z'));
});
test('all project routes require account management owner auth', async () => {
  const owner = await h.fundedKey(), other = await h.fundedKey();
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Budget worker' } });
  const child = await response.json(), auth = { authorization: 'Bearer ' + child.key };
  for (const [method, url] of [['GET', '/api/v1/projects'], ['GET', path()], ['PUT', path()], ['DELETE', path()]]) {
    const opts = { method, ...(method === 'PUT' ? { json: { budget_usd: 50 } } : {}) };
    expect((await h.request(url, opts)).status).toBe(401);
    expect((await h.request(url, { ...opts, headers: auth })).status).toBe(403);
  }
  expect((await put(owner, 50)).status).toBe(200);
  const isolated = await (await h.request(path(), { headers: other.auth })).json(); expect(isolated.data.budget_usd).toBeNull();
  expect((await (await h.request('/api/v1/projects', { headers: other.auth })).json()).data).toEqual([]);
});
test('PUT validates numeric caps and labels; DELETE is idempotent and retains spend', async () => {
  const key = await h.fundedKey();
  for (const budget of [-1, 1000001, '50', null]) expect((await h.request(path(), { method: 'PUT', headers: key.auth, json: { budget_usd: budget } })).status).toBe(400);
  expect((await put(key, 50, 'bad%20name')).status).toBe(400);
  await seed(key, 'd139-validation', 2); const saved = await (await put(key, 50, 'CHECKOUT')).json();
  expect(saved.data).toMatchObject({ name: 'checkout', budget_usd: '50', spent_usd: '2', held_usd: '0' });
  for (let n = 0; n < 2; n++) { const r = await h.request(path(), { method: 'DELETE', headers: key.auth }); expect((await r.json()).data).toMatchObject({ budget_usd: null, spent_usd: '2' }); }
  const list = await (await h.request('/api/v1/projects', { headers: key.auth })).json(); expect(list.data[0].name).toBe('checkout');
});
test('refuses at the edge with exact spend and charges nothing; equality fits', async () => {
  const key = await h.fundedKey(), accountId = await account(key); await seed(key, 'd139-edge', 49.98); await put(key, 50);
  await expect(reserve(h.ctx.db, { id: 'd139-edge-refused', accountId, keyHash: key.hash, project: 'checkout', amount: usdToPico(.03) })).rejects.toMatchObject({ status: 402, type: 'project_budget_exceeded', message: "Project 'checkout' has used $49.98 of its $50 budget this month" });
  expect(await h.ctx.db.select().from(holds).where(eq(holds.id, 'd139-edge-refused'))).toEqual([]);
  expect(await h.ctx.db.select().from(ledger).where(eq(ledger.ref, 'settle:d139-edge-refused'))).toEqual([]);
  await reserve(h.ctx.db, { id: 'd139-edge-fits', accountId, keyHash: key.hash, project: 'checkout', amount: usdToPico(.02) }); await release(h.ctx.db, 'd139-edge-fits');
});
test('concurrent holds across keys share account/project cap and release frees it', async () => {
  const key = await h.fundedKey(), accountId = await account(key); await put(key, 1);
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: key.auth, json: { name: 'Second worker' } }); const child = await response.json();
  const results = await Promise.allSettled([key.hash, child.data.hash].map((keyHash, i) => reserve(h.ctx.db, { id: 'd139-concurrent-' + i, accountId, keyHash, project: 'checkout', amount: usdToPico(.6) })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect((await projectSpend(h.ctx.db, accountId, 'checkout')).held).toBe(usdToPico(.6));
  for (let i = 0; i < 2; i++) await release(h.ctx.db, 'd139-concurrent-' + i);
  await reserve(h.ctx.db, { id: 'd139-concurrent-again', accountId, project: 'checkout', amount: usdToPico(1) }); await release(h.ctx.db, 'd139-concurrent-again');
});
test('month rollover excludes old charges but includes pending calls', async () => {
  const key = await h.fundedKey(), accountId = await account(key); await put(key, 1); await seed(key, 'd139-old', 1, new Date('2026-01-31T23:59:59Z'));
  await expect(h.ctx.db.transaction(tx => assertProjectBudget(tx, { accountId, project: 'checkout', amount: 1n }, new Date('2026-01-31T23:59:59Z')))).rejects.toMatchObject({ type: 'project_budget_exceeded' });
  await h.ctx.db.transaction(tx => assertProjectBudget(tx, { accountId, project: 'checkout', amount: usdToPico(1) }, new Date('2026-02-01T00:00:00Z')));
  await reserve(h.ctx.db, { id: 'd139-rollover', accountId, project: 'checkout', amount: usdToPico(.9) });
  await expect(h.ctx.db.transaction(tx => assertProjectBudget(tx, { accountId, project: 'checkout', amount: usdToPico(.2) }, new Date('2026-02-01T00:00:00Z')))).rejects.toMatchObject({ type: 'project_budget_exceeded' });
  await release(h.ctx.db, 'd139-rollover');
});
test('settlement counts once before generation write and assigns charge to settlement month', async () => {
  const key = await h.fundedKey(), accountId = await account(key); await put(key, 10);
  await reserve(h.ctx.db, { id: 'd139-charge', accountId, keyHash: key.hash, project: 'checkout', amount: usdToPico(2) });
  await settle(h.ctx.db, 'd139-charge', usdToPico(1)); await settle(h.ctx.db, 'd139-charge', usdToPico(2));
  expect((await projectSpend(h.ctx.db, accountId, 'checkout')).spent).toBe(usdToPico(1));
  await seed(key, 'd139-charge', 1); expect((await projectSpend(h.ctx.db, accountId, 'checkout')).spent).toBe(usdToPico(1));
  await h.ctx.db.transaction(tx => settleProjectReservation(tx, 'd139-charge', usdToPico(1), new Date('2026-02-01T00:00:00Z')));
  expect((await projectSpend(h.ctx.db, accountId, 'checkout', new Date('2026-01-31T23:59:59Z'))).spent).toBe(0n);
  expect((await projectSpend(h.ctx.db, accountId, 'checkout', new Date('2026-02-01T00:00:00Z'))).spent).toBe(usdToPico(1));
});
test('80 percent inbox notice once per month, never on holds; scoped to management', async () => {
  const key = await h.fundedKey(), accountId = await account(key); await put(key, 1);
  await reserve(h.ctx.db, { id: 'd139-notice', accountId, keyHash: key.hash, project: 'checkout', amount: usdToPico(.9) });
  const notices = () => h.ctx.db.select().from(projectBudgetNotices).where(eq(projectBudgetNotices.accountId, accountId));
  expect(await notices()).toEqual([]); await settle(h.ctx.db, 'd139-notice', usdToPico(.8)); expect(await notices()).toHaveLength(1);
  await put(key, .5); await h.request(path(), { method: 'DELETE', headers: key.auth }); await put(key, 1); expect(await notices()).toHaveLength(1);
  const inbox = await (await h.request('/api/v1/inbox', { headers: key.auth })).json(); expect(inbox.data.filter((r: any) => r.kind === 'project_budget')).toHaveLength(1);
  const response = await h.request('/api/v1/keys', { method: 'POST', headers: key.auth, json: { name: 'Notice worker' } }); const child = await response.json();
  const scoped = await (await h.request('/api/v1/inbox', { headers: { authorization: 'Bearer ' + child.key } })).json(); expect(scoped.data.some((r: any) => r.kind === 'project_budget')).toBe(false);
  await h.ctx.db.transaction(tx => settleProjectReservation(tx, 'd139-notice', usdToPico(.8), new Date('2026-02-01T00:00:00Z'))); expect(await notices()).toHaveLength(2);
});
test('Chat refuses before provider work and the same budget covers embeddings, rerank and adapters', async () => {
  const key = await h.fundedKey(); await put(key, 0);
  const calls = [['/api/v1/chat/completions', callBody], ['/api/v1/embeddings', { model: MODELS.embed.slug, input: 'Budget input' }], ['/api/v1/responses', { model: MODELS.llama.slug, input: 'Budget adapter' }], ['/api/v1/rerank', { model: 'acme/project-rerank', query: 'Budget query', documents: ['Budget note'] }], ['/api/v1/chat/completions', { ...callBody, verify: 'dual' }], ['/api/v1/chat/completions', { ...callBody, model: 'anyroute/council', council: { models: [MODELS.llama.slug, MODELS.qwen.slug], judge: MODELS.llama.slug } }]] as const;
  const before = await Promise.all(Object.values(h.mocks).map(async provider => (await (await fetch(provider.url + '/_stats')).json()).requests));
  for (const [url, json] of calls) {
    const r = await h.request(url, { method: 'POST', headers: { ...key.auth, 'X-Anyroute-Project': 'checkout' }, json });
    expect(r.status).toBe(402); expect((await r.json()).error.type).toBe('project_budget_exceeded');
  }
  expect(await Promise.all(Object.values(h.mocks).map(async provider => (await (await fetch(provider.url + '/_stats')).json()).requests))).toEqual(before);
  expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash))).toEqual([]);
  expect(await h.ctx.db.select().from(projectReservations).where(eq(projectReservations.accountId, await account(key)))).toEqual([]);
});
test('key default enforces budget; header can select another project; untagged and absent budgets unchanged', async () => {
  const key = await h.fundedKey(); await put(key, 0);
  let r = await h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: callBody }); expect(r.status).toBe(200); await r.text();
  r = await h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...key.auth, 'X-Anyroute-Project': 'uncapped' }, json: callBody }); expect(r.status).toBe(200); await r.text();
  await h.request('/api/v1/keys/' + key.hash, { method: 'PATCH', headers: key.auth, json: { project: 'checkout' } });
  r = await h.request('/api/v1/chat/completions', { method: 'POST', headers: key.auth, json: callBody }); expect(r.status).toBe(402);
  r = await h.request('/api/v1/chat/completions', { method: 'POST', headers: { ...key.auth, 'X-Anyroute-Project': 'uncapped' }, json: callBody }); expect(r.status).toBe(200); await r.text();
});
test('Telegram is off by default and does not claim or send', async () => {
  expect(h.ctx.cfg.projectBudgetTelegramEnabled).toBe(false);
  let calls = 0; const before = await h.ctx.db.select().from(projectBudgetNotices).where(eq(projectBudgetNotices.telegramClaimed, false));
  expect(await deliverProjectBudgetTelegram(h.ctx, (async () => { calls++; return new Response('{}'); }) as typeof fetch)).toEqual({ claimed: 0, skipped: true });
  expect(calls).toBe(0); expect(await h.ctx.db.select().from(projectBudgetNotices).where(eq(projectBudgetNotices.telegramClaimed, false))).toHaveLength(before.length);
});

test('Telegram sends once to a current management link and does not retry failures', async () => {
  const on = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", PROJECT_BUDGET_TELEGRAM_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456789:AAFixtureTokenFixtureToken0123456789" } });
  try {
    const { issueCode, consumeCode } = await import('../src/telegram/linking.ts');
    const owner = await on.fundedKey(); const [key] = await on.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
    const code = await issueCode(on.ctx, key); await consumeCode(on.ctx, 139001, code.code);
    await on.request(path(), { method: 'PUT', headers: owner.auth, json: { budget_usd: 1 } });
    await reserve(on.ctx.db, { id: 'd139-telegram', accountId: key.accountId, keyHash: key.keyHash, project: 'checkout', amount: usdToPico(.9) });
    await settle(on.ctx.db, 'd139-telegram', usdToPico(.8));
    const calls: any[] = []; const fetch = (async (_input: unknown, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof globalThis.fetch;
    expect((await deliverProjectBudgetTelegram(on.ctx, fetch)).claimed).toBe(1);
    expect(calls).toHaveLength(1); expect(calls[0].text).toContain("Project 'checkout' has used $0.8 of its $1"); expect(calls[0].chat_id).toBe(139001);
    await deliverProjectBudgetTelegram(on.ctx, fetch); expect(calls).toHaveLength(1);
    // A new month's notice is claimed before an ambiguous network failure.
    await on.ctx.db.transaction(tx => settleProjectReservation(tx, 'd139-telegram', usdToPico(.8), new Date('2026-02-01T00:00:00Z')));
    let attempts = 0; const failed = (async () => { attempts++; throw new Error('Delivery failed'); }) as typeof globalThis.fetch;
    await deliverProjectBudgetTelegram(on.ctx, failed); await deliverProjectBudgetTelegram(on.ctx, failed); expect(attempts).toBe(1);
    // Revocation stops delivery of a later notice.
    await on.ctx.db.transaction(tx => settleProjectReservation(tx, 'd139-telegram', usdToPico(.8), new Date('2026-03-01T00:00:00Z')));
    await on.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, key.keyHash));
    await deliverProjectBudgetTelegram(on.ctx, fetch); expect(calls).toHaveLength(1);
  } finally { await on.close(); }
});
