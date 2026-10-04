import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { CreditsAbi } from "../src/chain/abis.ts";
import { pollChain, processEvents, recordEvents } from "../src/chain/indexer.ts";
import { agentSessions, keys } from "../src/db/schema.ts";
import { balanceOf, ensureAccount } from "../src/ledger/ledger.ts";
import { provisionalCreditAmount } from "../src/pay/fast-credit-amount.ts";
import { accountDeposits, depositRemainingSeconds } from "../src/pay/deposit-progress.ts";
import { clearEscrowPriceCache, escrowAccountId, pollEscrow } from "../src/pay/escrow.ts";
import { ADDR, fakeTx, NVDA, startRouter } from "./helpers.ts";
import type { DecodedLog } from "../src/chain/service.ts";

test('early credit is min(observed value, account room, global room), never negative', () => {
  expect(provisionalCreditAmount(10n, 25n, 250n)).toBe(10n);
  expect(provisionalCreditAmount(100n, 25n, 250n)).toBe(25n);
  expect(provisionalCreditAmount(100n, 25n, 7n)).toBe(7n);
  expect(provisionalCreditAmount(10n, 25n, 0n)).toBe(0n);
  expect(provisionalCreditAmount(10n, -1n, 250n)).toBe(0n);
});
test('remaining time uses live block gap and delay; unavailable delay is unknown', () => {
  const fin = { head: 12000n, final: 0n, headTime: 1200, finalTime: 0, finalHash: fakeTx() };
  expect(depositRemainingSeconds(6000n, fin, 0n)).toBe(600);
  expect(depositRemainingSeconds(0n, fin, 0n)).toBe(0);
  expect(depositRemainingSeconds(6000n, { ...fin, finalTime: 1200 }, 0n)).toBeNull();
});
test('submitted hash survives API rereads; rejects typed amounts, unauthenticated access and cross-account data', async () => {
  const h = await startRouter();
  try {
    const a = await h.newKey(), b = await h.newKey(), hash = fakeTx();
    const post = (json: unknown) => h.request('/api/v1/credits/deposits', { method: 'POST', headers: a.auth, json });
    expect((await h.request('/api/v1/credits/deposits')).status).toBe(401);
    expect((await post({ tx_hash: hash, lane: 'usdg', amount: '13000' })).status).toBe(400);
    expect((await post({ tx_hash: hash, lane: 'usdg' })).status).toBe(202);
    for (let i = 0; i < 2; i++) {
      const r = await h.request('/api/v1/credits/deposits', { headers: a.auth }); expect(r.status).toBe(200);
      expect((await r.json()).data.deposits).toMatchObject([{ tx_hash: hash, stage: 'submitted', block: null }]);
    }
    expect((await (await h.request('/api/v1/credits/deposits', { headers: b.auth })).json()).data.deposits).toEqual([]);
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, a.hash));
    expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(0n);
    const submissions = await Promise.all(Array.from({ length: 25 }, () => post({ tx_hash: fakeTx(), lane: 'usdg' })));
    expect(submissions.filter(r => r.status === 202)).toHaveLength(19);
    expect(submissions.filter(r => r.status === 429)).toHaveLength(6);
    const session = await h.newKey();
    await h.ctx.db.insert(agentSessions).values({ id: 'deposit-status-session', accountId: key.accountId, keyHash: session.hash, parentKeyHash: key.keyHash, expiresAt: new Date(Date.now() + 60000) });
    expect((await h.request('/api/v1/credits/deposits', { headers: session.auth })).status).toBe(403);
    expect((await h.request('/api/v1/credits/deposits', { method: 'POST', headers: session.auth, json: { tx_hash: fakeTx(), lane: 'usdg' } })).status).toBe(403);
  } finally { await h.close(); }
});
test('escrow status confirms observed amount, live worth, settling credit and frozen value through finality', async () => {
  const h = await startRouter({ env: { FAST_CREDIT_ENABLED: 'true', ESCROW_ADDRESS: '0x00000000000000000000000000000000000e5c20', ESCROW_START_BLOCK: '1', CHAIN_CONFIRMATIONS: '1', ESCROW_HAIRCUT_BPS: '0', ESCROW_TOKENS: JSON.stringify([{ symbol: 'NVDA', address: NVDA, decimals: 18, feed: '0x00000000000000000000000000000000000fee01' }]) } });
  try {
    const from = '0x0000000000000000000000000000000000001234' as Hex;
    const account = escrowAccountId(from);
    await ensureAccount(h.ctx.db, account, 'wallet', from);
    h.chain.escrowFinalLag = 50n;
    h.chain.client.getLogs = (async () => []) as never;
    h.chain.feedReading = { answer: 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now() / 1000) }; clearEscrowPriceCache();
    h.chain.escrowLogs.push({ token: NVDA as Hex, from, value: 10n * 10n ** 18n, txHash: fakeTx(), logIndex: 0, blockNumber: 95n });
    await pollEscrow(h.ctx);
    let d = (await accountDeposits(h.ctx, account)).deposits[0];
    expect(d).toMatchObject({ amount: '10', from_address: from, worth_usd: 10, credited_usd: 0, stage: 'detected', worth_fixed: false });
    expect(d.tx_url).toContain(`/tx/${d.tx_hash}`);
    h.chain.escrowHead = 104n; await pollEscrow(h.ctx);
    d = (await accountDeposits(h.ctx, account)).deposits[0];
    expect(d).toMatchObject({ amount: '10', worth_usd: 10, credited_usd: 10, stage: 'provisional', worth_fixed: true });
    h.chain.feedReading.answer = 2n * 10n ** 8n; clearEscrowPriceCache();
    h.chain.escrowFinalLag = 0n; await pollEscrow(h.ctx);
    expect((await accountDeposits(h.ctx, account)).deposits[0]).toMatchObject({ worth_usd: 10, credited_usd: 10, stage: 'final', remaining_s: 0 });
  } finally { clearEscrowPriceCache(); await h.close(); }
});
test('USDG appears before confirmations with fast credit off, waits for finality, then reports final', async () => {
  const h = await startRouter({ env: { CHAIN_CONFIRMATIONS: '1', CHAIN_START_BLOCK: '1' } });
  try {
    const k = await h.newKey(), other = await h.newKey();
    const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
    const e: DecodedLog = { contract: 'credits', event: 'Deposited', txHash: fakeTx(), logIndex: 0, blockNumber: 95n, args: { keyHash: k.chainKeyHash, amount: 13_000_000n, from: '0x0000000000000000000000000000000000001234' } };
    h.chain.escrowFinalLag = 50n;
    h.chain.logs = async (from, to) => e.blockNumber >= from && e.blockNumber <= to ? [e] : [];
    h.chain.client.getTransactionReceipt = (async () => ({ status: 'success', blockNumber: e.blockNumber, blockHash: await h.chain.blockHashAt(e.blockNumber), logs: [{ address: ADDR.credits, topics: encodeEventTopics({ abi: CreditsAbi, eventName: 'Deposited', args: { keyHash: k.chainKeyHash as Hex, from: e.args.from as Hex } }), data: encodeAbiParameters([{ type: 'uint256' }], [13_000_000n]), transactionHash: e.txHash, logIndex: 0, blockNumber: e.blockNumber }] })) as never;
    h.chain.client.getLogs = (async () => (await h.chain.client.getTransactionReceipt({ hash: e.txHash })).logs) as never;
    let r = await h.request('/api/v1/credits/deposits', { headers: k.auth });
    expect((await r.json()).data.deposits[0]).toMatchObject({ stage: 'detected', amount: '13', worth_usd: 13, credited_usd: 0 });
    expect((await (await h.request('/api/v1/credits/deposits', { headers: other.auth })).json()).data.deposits).toEqual([]);
    await pollChain(h.ctx); expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(0n);
    await recordEvents(h.ctx, [e]); await processEvents(h.ctx);
    expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(0n);
    h.chain.escrowFinalLag = 0n; await processEvents(h.ctx);
    expect((await balanceOf(h.ctx.db, key.accountId)).balance).toBe(13_000_000_000_000n);
    r = await h.request('/api/v1/credits/deposits', { headers: k.auth });
    expect((await r.json()).data.deposits[0]).toMatchObject({ stage: 'final', amount: '13', credited_usd: 13 });
    const credits = (await (await h.request('/api/v1/credits', { headers: k.auth })).json()).data;
    expect(credits.expected_credit_delay_s).toBe(0); expect(credits.fast_credit).toBeUndefined();
  } finally { await h.close(); }
});
