import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { startRouter, type Harness } from "./helpers.ts";
import { accounts, keys, kv, ledger } from "../src/db/schema.ts";
import { lowBalanceAlerts } from "../src/db/low-balance.ts";
import { runwayMath } from "../src/account/runway.ts";
import { crossing, lowBalanceText, registerLowBalanceJob, runLowBalanceAlerts } from "../src/account/low-balance.ts";
import { loadConfig } from "../src/config.ts";
const USD = 1_000_000_000_000n;
let off: Harness, h: Harness;
beforeAll(async () => {
  off = await startRouter();
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", LOW_BALANCE_ALERTS_ENABLED: "true", TELEGRAM_LINKING_ENABLED: "true", TELEGRAM_BOT_TOKEN: "119:fixture-only-telegram-token", SITE_URL: "https://funding.example" } });
});
afterAll(async () => { await off?.close(); await h?.close(); });
async function keyRow(router: Harness, hash: string) { return (await router.ctx.db.select().from(keys).where(eq(keys.keyHash, hash)))[0]; }
let seq = 0;
async function line(account: string, amount: bigint, kind = "usage", keyHash?: string, createdAt = new Date()) {
  const id = `runway-line-${++seq}`;
  await h.ctx.db.insert(ledger).values({ id, accountId: account, amount, kind, keyHash, ref: id, createdAt });
}
async function setting(key: { auth: Record<string, string> }, amount: unknown) {
  return h.request('/api/v1/account/low-balance', { method: 'PATCH', headers: key.auth, json: { low_balance_usd: amount } });
}
async function alerts(key: { auth: Record<string, string> }) {
  const page = await (await h.request('/api/v1/inbox', { headers: key.auth })).json();
  return page.data.filter((item: any) => item.kind === 'low_balance');
}
test('runway math floors days, handles zero, tiny spend and fractional pace without integer rounding', () => {
  expect(runwayMath(12n * USD, 7n * USD)).toEqual({ balance_usd: 12, spend_7d_usd: 7, per_day_usd: 1, days_left: 12 });
  expect(runwayMath(USD / 2n, 7n * USD).days_left).toBe(0);
  expect(runwayMath(USD, 0n).days_left).toBeNull();
  expect(runwayMath(1n, 1n).days_left).toBe(7);
  expect(runwayMath(10n, 8n).days_left).toBe(8);
  expect(runwayMath(-1n, 8n)).toEqual({ balance_usd: -1e-12, spend_7d_usd: 8e-12, per_day_usd: 8e-12 / 7, days_left: -1 });
});
test('runway follows credits auth and posted seven-day charged spending with no flag', async () => {
  const owner = await h.newKey(), other = await h.newKey();
  const account = (await keyRow(h, owner.hash)).accountId;
  await line(account, 25n * USD, 'deposit');
  await line(account, -7n * USD, 'usage', owner.hash);
  await line(account, -USD, 'tool_call', owner.hash);
  await line(account, -USD, 'data_tool', owner.hash);
  await line(account, USD, 'refund', owner.hash);
  await line(account, -USD, 'withdrawal', owner.hash);
  await line(account, -USD, 'usage', owner.hash, new Date(Date.now() - 8 * 86_400_000));
  await line(account, -USD, 'usage', owner.hash, new Date(Date.now() + 86_400_000));
  const response = await h.request('/api/v1/account/runway', { headers: owner.auth });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ balance_usd: 14, spend_7d_usd: 9, per_day_usd: 9 / 7, days_left: 10 });
  const childResponse = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json();
  const childAuth = { authorization: 'Bearer ' + childResponse.key };
  expect(await (await h.request('/api/v1/account/runway', { headers: childAuth })).json()).toEqual(await (await h.request('/api/v1/account/runway', { headers: owner.auth })).json());
  expect((await (await h.request('/api/v1/account/runway', { headers: other.auth })).json()).days_left).toBeNull();
  const own = await off.newKey(); expect((await off.request('/api/v1/account/runway', { headers: own.auth })).status).toBe(200);
  for (const headers of [{}, { authorization: 'Bearer invalid' }]) expect((await h.request('/api/v1/account/runway', { headers })).status).toBe(401);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, other.hash));
  expect((await h.request('/api/v1/account/runway', { headers: other.auth })).status).toBe(401);
});
test('sessions get only their budget and spend, and inference-only keys remain refused', async () => {
  const owner = await h.newKey(), account = (await keyRow(h, owner.hash)).accountId;
  await line(account, 100n * USD, 'deposit'); await line(account, -7n * USD, 'usage', owner.hash);
  const session = await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 4 } })).json();
  const hash = session.data.key_hash, headers = { authorization: 'Bearer ' + session.data.key };
  await line(account, -USD, 'usage', hash); await h.ctx.db.update(keys).set({ spentTotal: USD }).where(eq(keys.keyHash, hash));
  expect(await (await h.request('/api/v1/account/runway', { headers })).json()).toEqual({ balance_usd: 3, spend_7d_usd: 1, per_day_usd: 1 / 7, days_left: 21 });
  expect((await h.request('/api/v1/account/low-balance', { headers })).status).toBe(403);
  await h.ctx.db.update(keys).set({ scope: 'inference' }).where(eq(keys.keyHash, hash));
  expect((await h.request('/api/v1/account/runway', { headers })).status).toBe(403);
});
test('settings are owner-only, nullable, bounded and off prevents edits and jobs', async () => {
  expect(loadConfig({ ANYROUTE_ENV: 'test' }).lowBalanceAlertsEnabled).toBe(false);
  registerLowBalanceJob(off.ctx); registerLowBalanceJob(h.ctx);
  expect(off.ctx.jobs.status().some(row => row.name === 'low-balance-alerts')).toBe(false);
  expect(h.ctx.jobs.status().find(row => row.name === 'low-balance-alerts')?.every_ms).toBe(300_000);
  expect(await runLowBalanceAlerts(off.ctx)).toEqual({ skipped: true });
  const owner = await h.newKey(), account = (await keyRow(h, owner.hash)).accountId;
  for (const path of ['/api/v1/account/low-balance']) for (const method of ['GET', 'PATCH']) expect((await h.request(path, { method, json: method === 'PATCH' ? { low_balance_usd: 5 } : undefined })).status).toBe(401);
  const child = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: {} })).json();
  const headers = { authorization: 'Bearer ' + child.key };
  for (const method of ['GET', 'PATCH']) expect((await h.request('/api/v1/account/low-balance', { method, headers, json: method === 'PATCH' ? { low_balance_usd: 5 } : undefined })).status).toBe(403);
  for (const invalid of [-1, '5', 1_000_001]) expect((await setting(owner, invalid)).status).toBe(400);
  expect((await setting(owner, 5)).status).toBe(200);
  expect(await (await h.request('/api/v1/account/low-balance', { headers: owner.auth })).json()).toEqual({ low_balance_usd: 5, enabled: true });
  expect((await setting(owner, null)).status).toBe(200);
  expect((await h.ctx.db.select().from(accounts).where(eq(accounts.id, account)))[0].lowBalancePico).toBeNull();
  const offOwner = await off.newKey();
  expect(await (await off.request('/api/v1/account/low-balance', { headers: offOwner.auth })).json()).toEqual({ low_balance_usd: null, enabled: false });
  expect((await off.request('/api/v1/account/low-balance', { method: 'PATCH', headers: offOwner.auth, json: { low_balance_usd: 5 } })).status).toBe(403);
});
test('crossing re-arms strictly above, never at equality or while still below', () => {
  expect(crossing(4n, 5n, false)).toBe('alert'); expect(crossing(4n, 5n, true)).toBe('unchanged');
  expect(crossing(5n, 5n, false)).toBe('unchanged'); expect(crossing(5n, 5n, true)).toBe('unchanged');
  expect(crossing(6n, 5n, true)).toBe('rearm'); expect(crossing(0n, null, false)).toBe('disabled');
});
test('job claims a crossing once across concurrent workers, preserves inbox history, and re-arms', async () => {
  const owner = await h.newKey(), account = (await keyRow(h, owner.hash)).accountId;
  await line(account, 3_100_000_000_000n, 'deposit'); await setting(owner, 5);
  await Promise.all([runLowBalanceAlerts(h.ctx), runLowBalanceAlerts(h.ctx)]);
  const first = await alerts(owner); expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ amount: '3.1', href: '/dashboard/#money', unread: true });
  await setting(owner, 5); await runLowBalanceAlerts(h.ctx); expect(await alerts(owner)).toHaveLength(1);
  await line(account, 1_900_000_000_000n, 'deposit'); await runLowBalanceAlerts(h.ctx);
  expect((await h.ctx.db.select().from(accounts).where(eq(accounts.id, account)))[0].lowBalanceAlerted).toBe(true);
  await line(account, USD, 'deposit'); await runLowBalanceAlerts(h.ctx);
  expect((await h.ctx.db.select().from(accounts).where(eq(accounts.id, account)))[0].lowBalanceAlerted).toBe(false);
  await line(account, -2n * USD, 'usage', owner.hash); await runLowBalanceAlerts(h.ctx); expect(await alerts(owner)).toHaveLength(2);
  const child = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: {} })).json();
  expect(await alerts({ auth: { authorization: 'Bearer ' + child.key } })).toHaveLength(0);
  const other = await h.newKey(); expect(await alerts(other)).toHaveLength(0);
  const seen = await (await h.request('/api/v1/inbox', { headers: owner.auth })).json();
  expect((await (await h.request('/api/v1/inbox?since=' + encodeURIComponent(seen.as_of), { headers: owner.auth })).json()).data.some((item: any) => item.kind === 'low_balance')).toBe(false);
  await setting(owner, null); await line(account, -USD, 'usage', owner.hash); await runLowBalanceAlerts(h.ctx); expect(await alerts(owner)).toHaveLength(2);
  expect((await h.ctx.db.select().from(lowBalanceAlerts).where(eq(lowBalanceAlerts.accountId, account)))).toHaveLength(2);
});
test('Telegram uses the existing authorized link and site URL; failed sends do not repeat the crossing', async () => {
  const owner = await h.newKey(), account = (await keyRow(h, owner.hash)).accountId;
  await line(account, 3_100_000_000_000n, 'deposit'); await setting(owner, 5);
  await h.ctx.db.insert(kv).values({ key: 'telegram-link:119', value: { account, key_hash: owner.hash, uid: 119, generation: 'fixture-generation', linked_at: new Date().toISOString() } });
  const sent: any[] = [];
  const fetchImpl = (async (_url: unknown, init: any) => { sent.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof fetch;
  await runLowBalanceAlerts(h.ctx, fetchImpl);
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe('Your Anyroute balance is $3.10, below your $5 alert. Add funds: https://funding.example/dashboard/#money');
  await runLowBalanceAlerts(h.ctx, fetchImpl); expect(sent).toHaveLength(1);
  await setting(owner, 6); const failing = (async () => { throw new Error('delivery unavailable'); }) as typeof fetch;
  await runLowBalanceAlerts(h.ctx, failing); await runLowBalanceAlerts(h.ctx, fetchImpl); expect(sent).toHaveLength(1); expect(await alerts(owner)).toHaveLength(2);
  await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash)); await h.ctx.db.update(accounts).set({ lowBalanceAlerted: false }).where(eq(accounts.id, account));
  await runLowBalanceAlerts(h.ctx, fetchImpl); expect(sent).toHaveLength(1);
  expect(lowBalanceText(3_100_000_000_000n, 5n * USD, 'https://funding.example')).toContain('$3.10');
});
