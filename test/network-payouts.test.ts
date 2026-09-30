import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, type Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { generations, hostAnchorLeaves, hostAnchors, providers, settlements, payouts } from "../src/db/schema.ts";
import { networkFeeLedger, networkReceiptLinks, networkPayoutDispatch } from "../src/network/payout-schema.ts";
import { sanctionsMeta, sanctionsAddresses } from "../src/network/schema.ts";
import { accrueNetworkHours, networkFee } from "../src/network/accrual.ts";
import { runPayouts, settleHours } from "../src/services/settlement.ts";
import { runNetworkFeeBurn } from "../src/network/fee-burn.ts";
import { networkPayoutDashboard } from "../src/network/payout-dashboard.ts";
import { earningsBand } from "../src/api/hosts.ts";
import { captureNetworkReceipt, forwardNetworkReceipt, linkNetworkReceipt } from "../src/network/receipt-link.ts";
import { registerJobs } from "../src/services/register.ts";
import { startRouter, type Harness } from "./helpers.ts";
const a = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Hex;
const address = a(1), recipient = a(2), oracle = a(3), burner = a(4);
const env = { NETWORK_PAYOUTS_ENABLED: 'true', HOST_ANCHOR_ENABLED: 'true', SANCTIONS_SCREENING_ENABLED: 'true' };
const old = new Date('2020-01-01T00:00:00Z'), accrualAt = new Date('2020-01-02T00:00:00Z');
let h: Harness;
beforeAll(async () => { h = await startRouter({ providers: [], env }); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  h.ctx.cfg.networkPayouts.enabled = true; h.ctx.cfg.networkPayouts.burnEnabled = false;
  for (const t of [networkPayoutDispatch, payouts, settlements, networkReceiptLinks, networkFeeLedger, hostAnchorLeaves, hostAnchors, generations, providers, sanctionsMeta, sanctionsAddresses]) await h.ctx.db.delete(t);
  await h.ctx.db.insert(providers).values({ id: 'host', name: 'Host', baseUrl: 'https://host.example/v1', networkHost: true, payoutMode: 'usdg', payoutAddress: recipient, operator: address });
  await h.ctx.db.insert(sanctionsMeta).values({ id: 1, listDate: new Date(), sourceHash: 'fixture', entryCount: 0, ignoredCount: 0, refreshedAt: new Date() });
});
async function generation(id: string, cost: bigint, anchored = true, providerId = 'host', status = 'confirmed') {
  await h.ctx.db.insert(generations).values({ id, providerId, modelId: 'model', upstreamCost: cost, tokensIn: 2, tokensOut: 3, mode: 'prepaid', ts: old });
  await h.ctx.db.insert(networkReceiptLinks).values({ generationId: id, providerId, receiptId: `rcpt_${id}` });
  if (anchored) {
    const [root] = await h.ctx.db.insert(hostAnchors).values({ providerId, attestationRef: 'ref', receiptKeyId: 'key', receiptPublicKey: 'pub', root: `root-${id}`, fromTs: old, toTs: accrualAt, count: 1, status, txHash: status === 'confirmed' ? 'tx' : null }).returning();
    await h.ctx.db.insert(hostAnchorLeaves).values({ providerId, leaf: `leaf-${id}`, anchorId: root.id, leafIndex: 0, receiptId: `rcpt_${id}`, receiptTs: old });
  }
}
test('fee floor, exact integers, zero/full allowed bounds and rejected bps', () => {
  expect(networkFee(101n, 500)).toEqual({ gross: 101n, fee: 5n, net: 96n });
  expect(networkFee(19n, 500).fee).toBe(0n);
  expect(networkFee(123n, 0).net).toBe(123n);
  expect(networkFee(100n, 2000).net).toBe(80n);
  for (const bps of [-1, 2001, 0.5, NaN]) { expect(() => networkFee(1n, bps)).toThrow(); expect(() => loadConfig({ NETWORK_FEE_BPS: String(bps) })).toThrow(); }
  expect(loadConfig({}).networkPayouts).toMatchObject({ enabled: false, burnEnabled: false, feeBps: 500 });
});
test('anchored costs only, hourly aggregate floor, no repeated invoice, late confirmations accrue later', async () => {
  await generation('one', 10_000_000_101n); await generation('two', 20_000_000_019n); await generation('unanchored', 999_000_000_000n, false); await generation('pending', 999_000_000_000n, true, 'host', 'pending');
  await accrueNetworkHours(h.ctx, accrualAt); await accrueNetworkHours(h.ctx, accrualAt);
  const [invoice] = await h.ctx.db.select().from(settlements);
  expect(invoice).toMatchObject({ upstream: 30_000_000_120n, fee: 1_500_000_006n, usdgOwed: 28_500n, requests: 2, tokens: 10n });
  const [ledger] = await h.ctx.db.select().from(networkFeeLedger); expect(ledger.grossPico - ledger.feePico).toBe(invoice.upstream - invoice.fee);
  await h.ctx.db.update(hostAnchors).set({ status: 'confirmed', txHash: 'late-tx' }).where(eq(hostAnchors.root, 'root-pending'));
  await accrueNetworkHours(h.ctx, new Date('2020-01-02T01:00:00Z'));
  const invoices = await h.ctx.db.select().from(settlements); expect(invoices).toHaveLength(2); expect(invoices.reduce((n, r) => n + r.upstream, 0n)).toBe(1_029_000_000_120n);
});
test('another host root cannot authorize payment; local roots and cache/BYOK do not accrue', async () => {
  await generation('local', 100n, true, 'host', 'local'); await generation('cache', 100n); await generation('byok', 100n); await generation('wrong', 100n);
  await h.ctx.db.update(generations).set({ mode: 'cache' }).where(eq(generations.id, 'cache')); await h.ctx.db.update(generations).set({ mode: 'byok' }).where(eq(generations.id, 'byok'));
  await h.ctx.db.update(hostAnchors).set({ providerId: 'other-host' }).where(eq(hostAnchors.root, 'root-wrong'));
  await accrueNetworkHours(h.ctx, accrualAt); expect(await h.ctx.db.select().from(settlements)).toEqual([]);
});
test('flags off keep curated settlement fees and create no network invoice or burn', async () => {
  h.ctx.cfg.networkPayouts.enabled = false; await generation('off', 100_000_000n);
  await h.ctx.db.insert(providers).values({ id: 'curated', name: 'Curated', baseUrl: 'https://curated.example' });
  await h.ctx.db.insert(generations).values({ id: 'curated-call', providerId: 'curated', modelId: 'model', upstreamCost: 100_000_000n, mode: 'prepaid', ts: old });
  await settleHours(h.ctx, accrualAt);
  const invoices = await h.ctx.db.select().from(settlements); expect(invoices).toHaveLength(1); expect(invoices[0].providerId).toBe('curated'); expect(invoices[0].fee).toBe(2_000_000n);
  expect(await h.ctx.db.select().from(networkFeeLedger)).toEqual([]); expect(await runNetworkFeeBurn(h.ctx)).toEqual({ skipped: 'network fee burn disabled' });
});
test('receipt response header linkage reaches settlement and rejects duplicate sidecar IDs', async () => {
  const id = 'rcpt_' + 'a'.repeat(24);
  const upstream = captureNetworkReceipt({}, new Response('', { headers: { 'x-anyroute-receipt-id': id } }), { provider: { networkHost: true } } as never);
  const route = forwardNetworkReceipt({}, upstream); await linkNetworkReceipt(h.ctx, 'g1', 'host', route); await linkNetworkReceipt(h.ctx, 'g2', 'host', route);
  expect(await h.ctx.db.select().from(networkReceiptLinks)).toMatchObject([{ generationId: 'g1', receiptId: id }]);
});
test('sanctions block before claims; recovered payout reconciles exactly and never pays twice', async () => {
  await generation('paid', 40_000_000_000n); await generation('unpaid', 100_000_000_000n, false); await accrueNetworkHours(h.ctx, accrualAt);
  await h.ctx.db.insert(sanctionsAddresses).values({ address: recipient, listDate: new Date(), sourceHash: 'fixture' });
  await runPayouts(h.ctx); expect(await h.ctx.db.select().from(payouts)).toEqual([]);
  await h.ctx.db.delete(sanctionsAddresses);
  let broadcasts = 0, signed = 0, receipt: any = null;
  const bytes = '0x010203' as Hex; const hash = keccak256(bytes);
  const client = h.ctx.chain.client;
  const wallet = h.ctx.chain.wallet;
  const roleAddress = h.ctx.chain.roleAddress;
  h.ctx.chain.roleAddress = role => role === 'settlement' ? address : undefined;
  h.ctx.chain.wallet = (() => ({ chain: {}, prepareTransactionRequest: async () => ({}), signTransaction: async () => { signed++; return bytes; } })) as never;
  h.ctx.chain.client = {
    getTransactionReceipt: async () => { if (!receipt) throw Object.assign(new Error('missing'), { name: 'TransactionReceiptNotFoundError' }); return receipt; },
    sendRawTransaction: async ({ serializedTransaction }: any) => { expect(serializedTransaction).toBe(bytes); broadcasts++; receipt = { status: 'success', logs: [{ address: h.ctx.cfg.chain.usdg, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: address, to: recipient } }), data: encodeAbiParameters([{ type: 'uint256' }], [38_000n]) }] }; return hash; },
    waitForTransactionReceipt: async () => { throw new Error('receipt wait interrupted after transfer'); },
  } as never;
  try {
    await expect(runPayouts(h.ctx)).rejects.toThrow('interrupted');
    expect(await h.ctx.db.select().from(networkPayoutDispatch)).toHaveLength(1);
    await runPayouts(h.ctx); await runPayouts(h.ctx);
    expect(broadcasts).toBe(1); expect(signed).toBe(1);
    const [pay] = await h.ctx.db.select().from(payouts); expect(pay.usdg).toBe(38_000n); expect(pay.status).toBe('paid');
    const [invoice] = await h.ctx.db.select().from(settlements); expect(invoice.paidTx).toBe(hash);
  } finally { h.ctx.chain.client = client; h.ctx.chain.wallet = wallet; h.ctx.chain.roleAddress = roleAddress; }
});
test('legacy pending payouts cannot bypass anchored receipt accounting', async () => {
  await h.ctx.db.insert(payouts).values({ id: 'legacy', providerId: 'host', usdg: 100n, to: recipient, status: 'pending' });
  await h.ctx.db.insert(settlements).values({ providerId: 'host', period: '2020-01-01T00', tokens: 1n, upstream: 100_000_000n, fee: 0n, usdgOwed: 100n, payoutId: 'legacy' });
  await expect(runPayouts(h.ctx)).rejects.toThrow('does not reconcile with anchored invoices');
  expect(await h.ctx.db.select().from(networkPayoutDispatch)).toHaveLength(0);
});
test('dashboard exact net is supplied only for authenticated operator mode', async () => {
  await generation('band', 50_000_000_000n); await accrueNetworkHours(h.ctx, accrualAt);
  const pub = await networkPayoutDashboard(h.ctx, 'host', true, false, earningsBand);
  expect(pub.network_payout).not.toHaveProperty('accrued_net_usdg_units');
  const own = await networkPayoutDashboard(h.ctx, 'host', true, true, earningsBand); expect(own.network_payout!.accrued_net_usdg_units).toBe('47500');
});
function burnFixture() {
  h.ctx.cfg.networkPayouts.burnEnabled = true;
  let swaps = 0, burns = 0, failBurn = false;
  let op = { usdgIn: 0n, amount: 0n, burned: false, swapTx: null as Hex | null, burnTx: null as Hex | null };
  const chain = { remaining: async () => 1_000_000_000n, operation: async () => ({ ...op }), swap: async (_id: Hex, amount: bigint) => { if (op.usdgIn) throw new Error('duplicate swap'); swaps++; op = { ...op, usdgIn: amount, amount: 10n ** 18n, swapTx: ('0x' + 'a'.repeat(64)) as Hex }; }, burn: async () => { if (failBurn) throw new Error('burn unavailable'); if (op.burned) throw new Error('duplicate burn'); burns++; op = { ...op, burned: true, burnTx: ('0x' + 'b'.repeat(64)) as Hex }; } };
  const quote = (async () => ({ quoted: true, minOut: 10n ** 18n })) as never;
  return { chain, quote, counts: () => ({ swaps, burns }), fail: (v: boolean) => { failBurn = v; }, forgetState: async () => { await h.ctx.db.update(networkFeeLedger).set({ status: 'accrued', swapTx: null, burnTx: null, anyrAmount: null }); } };
}
async function fees() { await generation('fee', 40_000_000_000_000n); await accrueNetworkHours(h.ctx, accrualAt); }
test('burn happy path, public totals and links, idempotent repetition', async () => {
  await fees(); const b = burnFixture(); await runNetworkFeeBurn(h.ctx, b); await runNetworkFeeBurn(h.ctx, b);
  expect(b.counts()).toEqual({ swaps: 1, burns: 1 }); const [row] = await h.ctx.db.select().from(networkFeeLedger); expect(row.status).toBe('burned'); expect(row.swapTx).toBeTruthy(); expect(row.burnTx).toBeTruthy();
  const data = (await (await h.request('/api/v1/network/burns')).json()).data; expect(data.totals.burned_anyr_units).toBe((10n ** 18n).toString()); expect(data.recent[0].burn_url).toContain('/tx/'); expect(data.recent[0]).not.toHaveProperty('gross_pico');
});
test('oracle refusal skips without a swap; daily/per-run cap and open-hour guards', async () => {
  await fees(); const b = burnFixture(); const refuse = (async () => ({ skipped: 'floor oracle refused' })) as never;
  expect(await runNetworkFeeBurn(h.ctx, { chain: b.chain, quote: refuse })).toMatchObject({ skipped: 'floor oracle refused' }); expect(b.counts()).toEqual({ swaps: 0, burns: 0 });
  await runNetworkFeeBurn(h.ctx, { ...b, chain: { ...b.chain, remaining: async () => 0n } }); expect(b.counts().swaps).toBe(0);
  await h.ctx.db.update(networkFeeLedger).set({ period: new Date().toISOString().slice(0, 13) }); await runNetworkFeeBurn(h.ctx, b); expect(b.counts().swaps).toBe(0);
});
test('swap without burn recovers even with oracle unavailable; lost database result reconciles on-chain state', async () => {
  await fees(); const b = burnFixture(); b.fail(true); await expect(runNetworkFeeBurn(h.ctx, b)).rejects.toThrow('burn unavailable'); expect(b.counts()).toEqual({ swaps: 1, burns: 0 });
  b.fail(false); await b.forgetState(); await runNetworkFeeBurn(h.ctx, { chain: b.chain, quote: (async () => { throw new Error('must not quote a completed swap'); }) as never });
  await b.forgetState(); await runNetworkFeeBurn(h.ctx, b); expect(b.counts()).toEqual({ swaps: 1, burns: 1 });
});
test('real production loader starts with both flags on and isolated settlement and keeper workers', () => {
  const base = { NODE_ENV: 'production', ANYROUTE_ENV: 'production', RUNTIME_ROLE: 'worker', WORKER_JOBS: 'settlement', AUTO_MIGRATE: 'false', HOST: '0.0.0.0', APP_SECRET: 'fixture-'.repeat(6), ADMIN_TOKEN: 'fixture-admin-'.repeat(3), PUBLIC_BASE_URL: 'https://router.example', DATABASE_URL: 'postgres://fixture:fixture-only-credential@localhost/test', REDIS_URL: 'redis://:fixture-only-credential@localhost:6379', CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ANYR_STAKING_ADDRESS: address, BUYBACK_ORACLE_ADDRESS: oracle, NETWORK_FEE_BURN_ADDRESS: burner, NETWORK_FEE_BURN_ENABLED: 'true', SETTLEMENT_PRIVATE_KEY: '0x' + '1'.repeat(64), ...env };
  expect(loadConfig(base).networkPayouts).toMatchObject({ enabled: true, burnEnabled: true, feeBps: 500 });
  expect(loadConfig({ ...base, WORKER_JOBS: 'network-fee-burn', SETTLEMENT_PRIVATE_KEY: '', KEEPER_PRIVATE_KEY: '0x' + '2'.repeat(64) }).workerJobs).toEqual(['network-fee-burn']);
  for (const change of [{ SANCTIONS_SCREENING_ENABLED: 'false' }, { HOST_ANCHOR_ENABLED: 'false' }, { BUYBACK_ORACLE_ADDRESS: '' }, { NETWORK_FEE_BURN_ADDRESS: '' }, { SETTLEMENT_PRIVATE_KEY: '' }]) expect(() => loadConfig({ ...base, ...change })).toThrow();
});
