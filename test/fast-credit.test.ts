import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encodeEventTopics, encodeAbiParameters, type Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { pollChain, processEvents } from "../src/chain/indexer.ts";
import { CreditsAbi } from "../src/chain/abis.ts";
import { chainCursor, escrowDeposits, keys, kv, ledger } from "../src/db/schema.ts";
import { ensureAccount, balanceOf, post, reserve, verifyInvariants } from "../src/ledger/ledger.ts";
import { anyrPricing, clearEscrowPriceCache, escrowAccountId, pollEscrow } from "../src/pay/escrow.ts";
import { fastCreditAlertChecks, fastCreditFields } from "../src/pay/fast-credit-state.ts";
import { computeSpentLeaves } from "../src/services/settlement.ts";
import { runAlertNotifier } from "../src/services/alerts.ts";
import { ADDR, fakeTx, NVDA, startRouter, type Harness } from "./helpers.ts";
import type { DecodedLog } from "../src/chain/service.ts";
const ESCROW = '0x00000000000000000000000000000000000e5c20';
const FEED = '0x00000000000000000000000000000000000fee01';
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const env = { FAST_CREDIT_ENABLED: 'true', ESCROW_ADDRESS: ESCROW, ESCROW_START_BLOCK: '1', CHAIN_START_BLOCK: '1', CHAIN_CONFIRMATIONS: '1', ESCROW_HAIRCUT_BPS: '0', ESCROW_TOKENS: JSON.stringify([{ symbol: 'NVDA', address: NVDA, decimals: 18, feed: FEED }]) };
let h: Harness;
beforeAll(async () => { h = await startRouter({ env }); clearEscrowPriceCache(); h.chain.escrowFinalLag = 50n; h.chain.feedReading = { answer: 100n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now()/1000) }; });
afterAll(async () => h?.close());
const send = (n: number, block: bigint, raw = 10n ** 18n) => { const t = { token: NVDA as Hex, from: wallet(n), value: raw, txHash: fakeTx(), logIndex: 0, blockNumber: block }; h.chain.escrowLogs.push(t); return t; };
const bal = async (n: number) => (await balanceOf(h.ctx.db, escrowAccountId(wallet(n)))).balance;

describe('escrow fast credits', () => {
  test('threshold, account cap, fixed price, remainder and idempotency', async () => {
    const t = send(1, 95n);
    await pollEscrow(h.ctx); expect(await bal(1)).toBe(0n);
    h.chain.escrowHead = 104n;
    await pollEscrow(h.ctx); expect(await bal(1)).toBe(25_000_000_000_000n);
    send(1, 95n);
    await pollEscrow(h.ctx); expect(await bal(1)).toBe(25_000_000_000_000n);
    const [row] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash));
    expect(row.status).toBe('provisional');
    h.chain.feedReading = { answer: 200n * 10n ** 8n, decimals: 8, updatedAt: Math.floor(Date.now()/1000) }; clearEscrowPriceCache();
    h.chain.escrowFinalLag = 0n;
    await pollEscrow(h.ctx); expect(await bal(1)).toBe(300_000_000_000_000n); // First fixed at 100, second priced at finality at 200.
    await pollEscrow(h.ctx); expect(await bal(1)).toBe(300_000_000_000_000n);
    const [final] = await h.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash, t.txHash));
    expect(final).toMatchObject({ status: 'credited', reviewReason: null, price18: (100n*10n**18n).toString() });
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
  });
  test('global cap spans accounts; excess remains pending until finality', async () => {
    h.chain.escrowHead = 200n; h.chain.escrowFinalLag = 80n;
    for(let i=10;i<21;i++) send(i, 180n);
    await pollEscrow(h.ctx);
    expect(await bal(19)).toBe(25_000_000_000_000n); expect(await bal(20)).toBe(0n);
    expect((await fastCreditFields(h.ctx, escrowAccountId(wallet(10)))).fast_credit?.settling_usd).toBe(25);
    h.chain.escrowFinalLag = 0n; await pollEscrow(h.ctx);
    expect(await bal(20)).toBe(200_000_000_000_000n);
  });
  test('orphan reversal is once; spent funds go negative and block new reservations; ops deduplicates', async () => {
    h.chain.escrowHead = 300n; h.chain.escrowFinalLag = 80n;
    const t = send(30, 280n);
    await pollEscrow(h.ctx);
    await post(h.ctx.db, { accountId: escrowAccountId(wallet(30)), amount: -25_000_000_000_000n, kind: 'usage', ref: 'fast-credit-spent' });
    h.chain.reorg(280n, logs => logs.filter(l => l.txHash !== t.txHash));
    await pollEscrow(h.ctx); await pollEscrow(h.ctx);
    expect(await bal(30)).toBe(-25_000_000_000_000n);
    await expect(reserve(h.ctx.db, { id: 'fast-credit-blocked', accountId: escrowAccountId(wallet(30)), amount: 1n })).rejects.toMatchObject({ status: 402 });
    const reversals = await h.ctx.db.select().from(ledger).where(eq(ledger.ref, `escrow-reversal:${t.txHash}:0`)); expect(reversals.length).toBe(1);
    let notices=0; const evaluate = () => fastCreditAlertChecks(h.ctx); h.ctx.cfg.alerts.webhookUrl='https://alerts.example/receiver';
    const fetcher = (async () => { notices++; return new Response('', { status: 200 }); }) as typeof fetch;
    await runAlertNotifier(h.ctx, { evaluate, now: () => 1000000, sustainMs: 0, fetch: fetcher });
    await runAlertNotifier(h.ctx, { evaluate, now: () => 1060000, sustainMs: 0, fetch: fetcher });
    expect(notices).toBe(1);
  });
  test('bad receipt, unavailable rate and changed canonical hash cannot get early funds', async () => {
    const t = send(31, 285n); h.chain.escrowReverted.add(t.txHash);
    await pollEscrow(h.ctx); expect(await bal(31)).toBe(0n);
    const p = send(32, 286n); h.chain.feedReading=null; clearEscrowPriceCache();
    await pollEscrow(h.ctx); expect(await bal(32)).toBe(0n);
    h.chain.feedReading={ answer: 100n*10n**8n, decimals:8, updatedAt:Math.floor(Date.now()/1000) }; clearEscrowPriceCache();
    h.chain.reorg(286n, logs => logs.filter(l => l.txHash !== p.txHash));
    await pollEscrow(h.ctx); expect(await bal(32)).toBe(0n);
  });
  test('disabling drains existing credits without issuing new ones', async () => {
    h.chain.escrowHead=400n; h.chain.escrowFinalLag=80n;
    send(40,380n); await pollEscrow(h.ctx); expect(await bal(40)).toBe(25_000_000_000_000n);
    h.ctx.cfg.fastCredit.enabled=false; send(41,381n); await pollEscrow(h.ctx); expect(await bal(41)).toBe(0n);
    h.chain.escrowFinalLag=0n; await pollEscrow(h.ctx); expect(await bal(40)).toBe(100_000_000_000_000n);
    h.ctx.cfg.fastCredit.enabled=true;
  });
});

test('off preserves legacy pending/final credit fields and creates no fast bookkeeping', async () => {
  const off=await startRouter({ env:{...env,FAST_CREDIT_ENABLED:'false'} });
  try { off.chain.escrowFinalLag=50n; off.chain.escrowLogs.push({ token:NVDA as Hex, from:wallet(50), value:10n**18n, txHash:fakeTx(), logIndex:0, blockNumber:90n });
    expect(await pollEscrow(off.ctx)).toMatchObject({ credited:0, seen:1 });
    expect(await fastCreditFields(off.ctx)).toEqual({});
    expect((await off.ctx.db.select().from(kv)).some(r=>r.key.startsWith('fast-credit:'))).toBe(false);
    off.chain.escrowFinalLag=0n; expect(await pollEscrow(off.ctx)).toMatchObject({ credited:1 });
  } finally { await off.close(); }
});

test('USDG receipt decoding, caps, final remainder, reorg and chain-backed settlement accounting', async () => {
  const u=await startRouter({ env:{...env,FAST_CREDIT_ACCOUNT_MAX_USD:'10',FAST_CREDIT_GLOBAL_MAX_USD:'15'} });
  try {
    u.chain.escrowFinalLag=50n;
    const kh='0x'+'a'.repeat(64), kh2='0x'+'b'.repeat(64);
    await ensureAccount(u.ctx.db,'fast-usdg'); await ensureAccount(u.ctx.db,'fast-usdg-two');
    for(const [keyHash,accountId,chainKeyHash] of [['fast-key','fast-usdg',kh],['fast-key-two','fast-usdg-two',kh2]]) await u.ctx.db.insert(keys).values({ keyHash,accountId,chainKeyHash,keyAddress:wallet(100),label:'sample' });
    const logs:DecodedLog[]=[{ contract:'credits',event:'Deposited',args:{keyHash:kh,amount:30_000_000n},txHash:fakeTx(),logIndex:0,blockNumber:95n },{ contract:'credits',event:'Deposited',args:{keyHash:kh2,amount:20_000_000n},txHash:fakeTx(),logIndex:0,blockNumber:95n }];
    u.chain.logs=async (from,to)=>logs.filter(l=>l.blockNumber>=from&&l.blockNumber<=to);
    const missing=new Set<string>(); let wrong=false;
    u.chain.client.getTransactionReceipt=(async ({hash}: {hash:Hex})=>{
      const e=logs.find(l=>l.txHash===hash); if(!e || missing.has(hash)) throw new (await import('viem')).TransactionReceiptNotFoundError({hash});
      return { status:'success',blockNumber:e.blockNumber,blockHash:await u.chain.blockHashAt(e.blockNumber), logs:[{ address:ADDR.credits,topics:encodeEventTopics({abi:CreditsAbi,eventName:'Deposited',args:{keyHash:e.args.keyHash as Hex,from:wallet(100)}}),data:encodeAbiParameters([{type:'uint256'}],[wrong?1n:BigInt(String(e.args.amount))]),transactionHash:e.txHash,logIndex:e.logIndex,blockNumber:e.blockNumber }] };
    }) as never;
    await pollChain(u.ctx); expect((await balanceOf(u.ctx.db,'fast-usdg')).balance).toBe(0n);
    u.chain.escrowHead=104n; wrong=true; await pollChain(u.ctx); expect((await balanceOf(u.ctx.db,'fast-usdg')).balance).toBe(0n);
    wrong=false; await Promise.all([pollChain(u.ctx),pollChain(u.ctx)]);
    expect((await balanceOf(u.ctx.db,'fast-usdg')).balance).toBe(10_000_000_000_000n); expect((await balanceOf(u.ctx.db,'fast-usdg-two')).balance).toBe(5_000_000_000_000n);
    missing.add(logs[1].txHash); await pollChain(u.ctx); expect((await balanceOf(u.ctx.db,'fast-usdg-two')).balance).toBe(0n);
    u.chain.escrowFinalLag=0n; await pollChain(u.ctx); await processEvents(u.ctx); await pollChain(u.ctx);
    expect((await balanceOf(u.ctx.db,'fast-usdg')).balance).toBe(30_000_000_000_000n);
    await post(u.ctx.db,{accountId:'fast-usdg',amount:-12_000_000_000_000n,kind:'usage',ref:'fast-usdg-usage'});
    const computed=await computeSpentLeaves(u.ctx); expect(computed.leaves.find(([hash])=>hash===kh)?.[1]).toBe(12_000_000n);
    expect((await verifyInvariants(u.ctx.db)).ok).toBe(true);
  } finally { await u.close(); }
});

test('production loader accepts enabled fast credit and validates thresholds/caps', () => {
  const address=wallet(100);
  const config=loadConfig({ NODE_ENV:'production',ANYROUTE_ENV:'production',RUNTIME_ROLE:'worker',WORKER_JOBS:'chain-indexer,escrow-indexer,alert-notifier',AUTO_MIGRATE:false,HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/test',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',CREDITS_ADDRESS:address,CALLPAY_ADDRESS:address,PROVIDER_BOND_ADDRESS:address,RECEIPT_ANCHOR_ADDRESS:address,FAST_CREDIT_ENABLED:true });
  expect(config.fastCredit).toEqual({ enabled:true,confirmations:10,accountMaxUsd:25,globalMaxUsd:250 });
  for(const env of [{FAST_CREDIT_CONFIRMATIONS:0},{FAST_CREDIT_ACCOUNT_MAX_USD:-1},{FAST_CREDIT_GLOBAL_MAX_USD:'NaN'}]) expect(()=>loadConfig(env)).toThrow();
});

test('ANYR early pricing freezes the rate and preserves its per-deposit ceiling', async () => {
  const anyr=wallet(999), usdg=loadConfig().chain.usdg;
  const legs=JSON.stringify([{key:{currency0:anyr,currency1:usdg,fee:3000,tickSpacing:60,hooks:wallet(0)},sign:1}]);
  const real=anyrPricing.twap;
  const a=await startRouter({env:{...env,ANYR_TOKEN_ADDRESS:anyr,ANYR_POOL_LEGS:legs,ANYR_ESCROW_HAIRCUT_BPS:'0',ANYR_ESCROW_MAX_USD_PER_DEPOSIT:'40'}});
  try {
    clearEscrowPriceCache();
    anyrPricing.twap=(async()=>({spot:.5,average:.5,conservative:.5,windowSeconds:1800,block:100,swaps:3})) as typeof real;
    a.chain.escrowFinalLag=50n;
    const t={token:anyr,from:wallet(90),value:1000n*10n**18n,txHash:fakeTx(),logIndex:0,blockNumber:90n};a.chain.escrowLogs.push(t);
    await pollEscrow(a.ctx); expect((await balanceOf(a.ctx.db,escrowAccountId(wallet(90)))).balance).toBe(25_000_000_000_000n);
    anyrPricing.twap=(async()=>{throw Error('price unavailable');}) as typeof real; clearEscrowPriceCache();
    a.chain.escrowFinalLag=0n; await pollEscrow(a.ctx);
    expect((await balanceOf(a.ctx.db,escrowAccountId(wallet(90)))).balance).toBe(40_000_000_000_000n);
    const [row]=await a.ctx.db.select().from(escrowDeposits).where(eq(escrowDeposits.txHash,t.txHash));
    expect(row.status).toBe('credited'); expect(row.reviewReason).toContain('ceiling'); expect(row.price18).toBe('500000000000000000');
    await pollEscrow(a.ctx); expect((await verifyInvariants(a.ctx.db)).ok).toBe(true);
  } finally { anyrPricing.twap=real; clearEscrowPriceCache(); await a.close(); }
});
