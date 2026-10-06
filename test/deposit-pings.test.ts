import { expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { accounts, escrowDeposits, keys, kv } from "../src/db/schema.ts";
import { post } from "../src/ledger/ledger.ts";
import { loadConfig } from "../src/config.ts";
import { runDepositPings, depositPingText } from "../src/pay/deposit-pings.ts";
import { startRouter, NVDA, fakeTx, type Harness } from "./helpers.ts";
const env = { AGENT_POLICY_ENABLED: 'true', DEPOSIT_PINGS_ENABLED: 'true', TELEGRAM_LINKING_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123456789:AAFixtureTokenFixtureToken0123456789', ESCROW_ADDRESS: '0x00000000000000000000000000000000000e5c20', ESCROW_TOKENS: JSON.stringify([{ symbol: 'NVDA', address: NVDA, decimals: 18, feed: '0x00000000000000000000000000000000000fee01' }]) };
async function credited(h: Harness, status = 'credited') {
  const owner = await h.newKey(), wallet = '0x' + 'b2'.repeat(20), account = 'w_' + wallet.slice(2), id = fakeTx();
  await h.ctx.db.insert(accounts).values({ id: account, kind: 'wallet', wallet });
  await h.ctx.db.update(keys).set({ accountId: account }).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.insert(kv).values({ key: 'telegram-link:22300', value: { uid: 22300, account, key_hash: owner.hash, generation: 'deposit-link', linked_at: new Date(Date.now() - 60000).toISOString() } });
  await h.ctx.db.insert(escrowDeposits).values({ id, txHash: id, logIndex: 0, blockNumber: 95n, token: NVDA, symbol: 'NVDA', fromAddress: wallet, rawAmount: '1200000000000000000000', status, credited: 1_010_000_000_000n, creditedAt: new Date(), accountId: account });
  await post(h.ctx.db, { accountId: account, kind: 'stock_deposit', ref: `escrow:${id}`, amount: 1_010_000_000_000n });
  await post(h.ctx.db, { accountId: account, kind: 'refund', ref: 'notice-balance', amount: 3_200_000_000_000n });
  return { owner, account, id };
}
function capture(fail = false) {
  const texts: string[] = [];
  const fetch = (async (_: unknown, init: RequestInit) => { texts.push(JSON.parse(String(init.body)).text); if (fail) throw new Error('delivery unavailable'); return Response.json({ ok: true, result: { message_id: 1 } }); }) as typeof globalThis.fetch;
  return { texts, fetch };
}
test('B123 token and money formatting preserves base units', () => {
  expect(depositPingText('1200', 'ANYR', 1_010_000_000_000n, 4_210_000_000_000n)).toBe('Your deposit of 1,200 $ANYR is credited: $1.01 added. Balance: $4.21.');
  expect(depositPingText('9007199254740993.123', 'NVDA', 1n, -1_230_000_000_000n)).toContain('9,007,199,254,740,993.123 NVDA is credited: $0.00 added. Balance: -$1.23.');
});
test('B123 durable claims prevent repeated and concurrent sends; inbox uses existing account guards', async () => {
  const h = await startRouter({ env });
  try {
    const { owner, id } = await credited(h), tg = capture();
    expect(h.ctx.jobs.status().some(j => j.name === 'deposit-pings')).toBe(true);
    await Promise.all([runDepositPings(h.ctx, tg.fetch), runDepositPings(h.ctx, tg.fetch)]);
    await runDepositPings(h.ctx, tg.fetch);
    expect(tg.texts).toEqual(['Your deposit of 1,200 NVDA is credited: $1.01 added. Balance: $4.21.']);
    while (Date.now() <= Date.parse((await h.ctx.db.select().from(kv).where(like(kv.key, 'deposit-ping:%')))[0].value.at as string)) await Bun.sleep(1);
    const read = async (auth: Record<string, string>) => (await (await h.request('/api/v1/inbox', { headers: auth })).json());
    expect((await h.request('/api/v1/inbox')).status).toBe(401);
    const page = await read(owner.auth);
    expect(page.data.filter((r: any) => r.kind === 'deposit')).toMatchObject([{ id: `deposit-credit:${id}`, title: 'Deposit credited', amount: '1.01' }]);
    expect((await read((await h.newKey()).auth)).data).toEqual([]);
    const child = await (await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Deposit reader' } })).json();
    expect((await read({ authorization: `Bearer ${child.key}` })).data).toEqual([]);
    const session = await (await h.request('/api/v1/sessions', { method: 'POST', headers: owner.auth, json: { budget_usd: 1 } })).json();
    expect((await read({ authorization: `Bearer ${session.data.key}` })).data).toEqual([]);
    const seen = await h.request('/api/v1/inbox?since=' + encodeURIComponent(page.as_of), { headers: owner.auth });
    expect((await seen.json()).data).toEqual([]);
  } finally { await h.close(); }
});
test('B123 flag defaults off: no job, markers, inbox notices or outbound messages; API role also refuses', async () => {
  expect(loadConfig({}).depositPingsEnabled).toBe(false);
  const h = await startRouter({ env: { ...env, DEPOSIT_PINGS_ENABLED: 'false' } });
  try {
    const { owner } = await credited(h), tg = capture();
    expect(h.ctx.jobs.status().some(j => j.name === 'deposit-pings')).toBe(false);
    expect(await runDepositPings(h.ctx, tg.fetch)).toEqual({ skipped: true });
    expect(tg.texts).toEqual([]);
    expect(await h.ctx.db.select().from(kv).where(like(kv.key, 'deposit-ping:%'))).toEqual([]);
    expect((await (await h.request('/api/v1/inbox', { headers: owner.auth })).json()).data).toEqual([]);
    expect(await runDepositPings({ ...h.ctx, cfg: { ...h.ctx.cfg, depositPingsEnabled: true, runtimeRole: 'api' } }, tg.fetch)).toEqual({ skipped: true });
  } finally { await h.close(); }
});
test('B123 failed sends retain one inbox notice without retry; disabled principals receive nothing', async () => {
  const h = await startRouter({ env });
  try {
    const { owner, id } = await credited(h, 'provisional'), tg = capture(true);
    await runDepositPings(h.ctx, tg.fetch); await runDepositPings(h.ctx, tg.fetch);
    expect(tg.texts).toHaveLength(1);
    await h.ctx.db.update(escrowDeposits).set({ status: 'credited' }).where(eq(escrowDeposits.id, id));
    await runDepositPings(h.ctx, tg.fetch); expect(tg.texts).toHaveLength(1);
    await h.ctx.db.update(keys).set({ disabled: true }).where(eq(keys.keyHash, owner.hash));
    const next = fakeTx();
    const [row] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.id, id));
    await h.ctx.db.insert(escrowDeposits).values({ ...row, id: next, txHash: next, creditedAt: new Date() });
    await runDepositPings(h.ctx, tg.fetch); expect(tg.texts).toHaveLength(1);
    expect((await h.request('/api/v1/inbox', { headers: owner.auth })).status).toBe(401);
  } finally { await h.close(); }
});

test('B123 unlinked accounts keep inbox notices, while pending and old credits do not notify', async () => {
  const h = await startRouter({ env });
  try {
    const { owner, id } = await credited(h), tg = capture();
    await h.ctx.db.delete(kv).where(eq(kv.key, 'telegram-link:22300'));
    await runDepositPings(h.ctx, tg.fetch);
    expect(tg.texts).toEqual([]);
    const [row] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.id, id));
    for (const status of ['pending_finality', 'pending', 'reversed', 'orphaned']) {
      const next = fakeTx(); await h.ctx.db.insert(escrowDeposits).values({ ...row, id: next, txHash: next, status });
    }
    const next = fakeTx(); await h.ctx.db.insert(escrowDeposits).values({ ...row, id: next, txHash: next, creditedAt: new Date(Date.now() - 2 * 86_400_000) });
    await runDepositPings(h.ctx, tg.fetch);
    expect(await h.ctx.db.select().from(kv).where(like(kv.key, 'deposit-ping:%'))).toHaveLength(1);
    await Bun.sleep(5);
    const page = await (await h.request('/api/v1/inbox', { headers: owner.auth })).json();
    expect(page.data.filter((r: any) => r.kind === 'deposit')).toHaveLength(1);
    const notices = await h.ctx.db.select().from(kv).where(like(kv.key, 'deposit-ping:%'));
    await h.ctx.db.update(kv).set({ updatedAt: new Date(Date.now() - 91 * 86_400_000) }).where(eq(kv.key, notices[0].key));
    const old = await (await h.request('/api/v1/inbox?since=' + encodeURIComponent(new Date(Date.now() - 100 * 86_400_000).toISOString()), { headers: owner.auth })).json();
    expect(old.data.filter((r: any) => r.kind === 'deposit')).toEqual([]);
  } finally { await h.close(); }
});
