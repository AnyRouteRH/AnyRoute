import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { accounts, escrowDeposits, keys } from "../src/db/schema.ts";
import { withDepositCountdown } from "../src/pay/deposit-countdown.ts";
import { startRouter, NVDA, fakeTx } from "./helpers.ts";
const env = { ESCROW_ADDRESS: '0x00000000000000000000000000000000000e5c20', CHAIN_CONFIRMATIONS: '1', ESCROW_TOKENS: JSON.stringify([{ symbol: 'NVDA', address: NVDA, decimals: 18, feed: '0x00000000000000000000000000000000000fee01' }]) };
test('B123 escrow estimate derives from live finality, isolates wallets and preserves auth', async () => {
  const h = await startRouter({ env });
  try {
    const owner = await h.newKey(), other = await h.newKey();
    const wallet = '0x' + 'a1'.repeat(20), account = 'w_' + wallet.slice(2), id = fakeTx();
    await h.ctx.db.insert(accounts).values({ id: account, kind: 'wallet', wallet });
    await h.ctx.db.update(keys).set({ accountId: account }).where(eq(keys.keyHash, owner.hash));
    await h.ctx.db.insert(escrowDeposits).values({ id, txHash: id, logIndex: 0, blockNumber: 95n, token: NVDA, symbol: 'NVDA', fromAddress: wallet, rawAmount: '1000000000000000000', status: 'pending_finality' });
    h.chain.escrowHead = 100n; h.chain.escrowFinalLag = 50n;
    expect((await h.request('/api/v1/escrow/deposits')).status).toBe(401);
    expect((await h.request('/api/v1/escrow/deposits', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
    const read = async () => (await (await h.request('/api/v1/escrow/deposits', { headers: owner.auth })).json()).data.deposits[0];
    const first = await read();
    expect(first.stage).toBe('confirming');
    expect(Date.parse(first.expected_final_at) - Date.now()).toBeGreaterThan(0);
    expect((await (await h.request('/api/v1/escrow/deposits', { headers: other.auth })).json()).data.deposits).toEqual([]);
    h.chain.escrowFinality = async () => { throw new Error('unavailable'); };
    expect((await read()).expected_final_at).toBeNull();
    await h.ctx.db.update(escrowDeposits).set({ status: 'credited', credited: 1_000_000_000_000n }).where(eq(escrowDeposits.id, id));
    expect(await read()).toMatchObject({ stage: 'credited', expected_final_at: null, credited_usd: 1 });
    expect(await withDepositCountdown(h.ctx, [])).toEqual([]);
  } finally { await h.close(); }
});
