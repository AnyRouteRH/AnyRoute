import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { startRouter, type Harness } from './helpers.ts';
import { accounts, keys, ledger, generations, teamMembers } from '../src/db/schema.ts';
import { loadConfig } from '../src/config.ts';
import { readStatement, reconcile, statementMonth } from '../src/statements/read.ts';
import { verifyReceipt } from '../web/lib/verify.js';
import { verifyStatement } from '../web/lib/statements.js';
let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { STATEMENTS_ENABLED: 'true', AGENT_POLICY_ENABLED: 'true' } }); });
afterAll(async () => { await h?.close(); });
const may = '2026-05', at = new Date('2026-05-12T00:00:00Z');
async function fixture() {
  const owner = await h.fundedKey();
  const [k] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, owner.hash));
  await h.ctx.db.update(accounts).set({ createdAt: new Date('2026-04-15T00:00:00Z') }).where(eq(accounts.id, k.accountId));
  return { owner, k };
}
async function child(owner: { auth: Record<string,string> }) {
  const r = await h.request('/api/v1/keys', { method: 'POST', headers: owner.auth, json: { name: 'Budget agent' } });
  expect(r.status).toBe(201); const j = await r.json(); return { hash: j.data.hash, auth: { authorization: 'Bearer ' + j.key } };
}
const fetchStatement = async (auth: Record<string,string>, month=may) => {
  const r = await h.request('/api/v1/statements/' + month, { headers: auth }); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); return (await r.json()).data;
};
test('ledger totals, fee classification and all usage groups reconcile exactly across UTC boundaries', async () => {
  const { owner, k } = await fixture(), agent = await child(owner);
  const id = 'statement-' + owner.hash.slice(0,12);
  const usage = 9007199254740993123n;
  // Increase credits enough to keep the append-only balance invariant valid.
  const entries = [
    ['open','credit',usage + 1000000000000n,new Date('2026-04-30T23:59:59.999Z'),owner.hash,null],
    ['deposit','deposit',1000000000001n,new Date('2026-05-01T00:00:00Z'),owner.hash,null],
    ['usage','usage',-usage,at,agent.hash,id+'-call'],
    ['usage2','usage',-7n,at,owner.hash,null],
    ['refund','refund',17n,at,agent.hash,id+'-call'],
    ['fee','routing_fee',-3n,at,owner.hash,null],
    ['adjust','adjustment',-2n,at,null,null],
    ['next','deposit',500n,new Date('2026-06-01T00:00:00Z'),owner.hash,null],
  ] as const;
  await h.ctx.db.insert(generations).values([{ id:id+'-call',accountId:k.accountId,keyHash:agent.hash,modelId:'model/one',providerId:'provider',mode:'prepaid',cost:usage,receipt:{ lane:'attested' },ts:at },{id:id+'-zero',accountId:k.accountId,keyHash:owner.hash,modelId:'model/two',providerId:'provider',mode:'cache',cost:0n,ts:at},{id:id+'-next',accountId:k.accountId,keyHash:owner.hash,modelId:'model/two',providerId:'provider',mode:'prepaid',ts:new Date('2026-06-01T00:00:00Z')}]);
  for(const [suffix,kind,amount,createdAt,keyHash,generationId] of entries) await h.ctx.db.insert(ledger).values({id:id+'-'+suffix,ref:id+'-'+suffix,accountId:k.accountId,keyHash,amount,kind,createdAt,generationId});
  const signed = await fetchStatement(owner.auth), p=signed.payload;
  expect(p).toMatchObject({ scope:'account', deposits:'1.000000000001', refunds:'0.000000000017', usage:'9007199.25474099313', fees:'0.000000000003', other_changes:'-0.000000000002', calls:'2', so_far:false });
  expect(p.usage_by_model).toEqual([{id:null,amount:'0.000000000007'},{id:'model/one',amount:'9007199.254740993123'}]);
  expect(p.usage_by_lane).toEqual([{id:null,amount:'0.000000000007'},{id:'attested',amount:'9007199.254740993123'}]);
  const sum = await h.ctx.db.execute(sql`select sum(amount)::text total from ledger where account_id=${k.accountId} and created_at < '2026-06-01T00:00:00Z'`);
  const rows=(sum as any).rows ?? sum;
  const { picoToUsdString } = await import('../src/lib/money.ts'); expect(p.closing_balance).toBe(picoToUsdString(BigInt(rows[0].total)));
  expect(await h.ctx.signer.verify(p,signed.sig,signed.key_id)).toBe(true);
  const published=await h.ctx.signer.jwks();
  expect((await verifyReceipt(signed,{keys:published})).valid).toBe(true);
  expect((await verifyStatement(signed,{keys:published})).valid).toBe(true);
  expect((await verifyStatement({...signed,payload:{...p,deposits:'999'}},{keys:published})).valid).toBe(false);
  const own=(await fetchStatement(agent.auth)).payload;
  expect(own.scope).toBe('key'); expect(own.key_hash).toBe(agent.hash);expect(own.deposits).toBe('0'); expect(own.calls).toBe('1'); expect(own.usage_by_key_agent).toHaveLength(1); expect(own.fees).toBe('0');
  const other=await fixture();expect((await fetchStatement(other.owner.auth)).payload.usage).toBe('0');
});
test('ordinary, team owner/admin and session scope follows Activity rules',async()=>{
  const {owner,k}=await fixture(), admin=await child(owner), peer=await child(owner);
  await h.ctx.db.update(keys).set({teamId:'statement-team-'+owner.hash.slice(0,8)}).where(eq(keys.keyHash,admin.hash));
  await h.ctx.db.insert(teamMembers).values({teamId:'statement-team-'+owner.hash.slice(0,8),keyHash:admin.hash,role:'admin'});
  const id='scope-'+owner.hash.slice(0,12);
  await h.ctx.db.insert(ledger).values({id,ref:id,accountId:k.accountId,keyHash:peer.hash,kind:'deposit',amount:9n,createdAt:at});
  expect((await fetchStatement(admin.auth)).payload).toMatchObject({scope:'account',deposits:'0.000000000009'});
  expect((await fetchStatement(peer.auth)).payload.scope).toBe('key');
  await h.ctx.db.update(teamMembers).set({role:'owner'}).where(eq(teamMembers.keyHash,admin.hash));expect((await fetchStatement(admin.auth)).payload.scope).toBe('account');
  const session=(await (await h.request('/api/v1/sessions',{method:'POST',headers:owner.auth,json:{budget_usd:1}})).json()).data;
  // Even a session key with management metadata must stay key-scoped.
  await h.ctx.db.update(keys).set({management:true}).where(eq(keys.keyHash,session.key_hash));
  expect((await fetchStatement({authorization:'Bearer '+session.key})).payload).toMatchObject({scope:'key',deposits:'0'});
});
test('month validation, existence and enabled guard; no auth bypass',async()=>{
  const {owner}=await fixture();
  expect((await h.request('/api/v1/statements/'+may)).status).toBe(401);
  for(const month of ['2026-00','2026-13','2026-5','0000-01']) expect((await h.request('/api/v1/statements/'+month,{headers:owner.auth})).status).toBe(400);
  for(const month of ['2026-03','9999-01']) expect((await h.request('/api/v1/statements/'+month,{headers:owner.auth})).status).toBe(404);
  expect((await fetchStatement(owner.auth,'2026-04')).payload.month).toBe('2026-04');
  expect((await h.request('/api/v1/statements/'+may+'?format=csv',{headers:owner.auth})).status).toBe(400);
  await h.ctx.db.update(keys).set({disabled:true}).where(eq(keys.keyHash,owner.hash));expect((await h.request('/api/v1/statements/'+may,{headers:owner.auth})).status).toBe(401);
  const off=await startRouter();try{const key=await off.fundedKey();expect(off.ctx.cfg.statementsEnabled).toBe(false);expect((await off.request('/api/v1/statements/'+may,{headers:key.auth})).status).toBe(404);}finally{await off.close();}
});
test('current month is so far, uses UTC and excludes later ledger entries',async()=>{
  const {k}=await fixture();const current=await readStatement(h.ctx,k,'2026-04',new Date('2026-04-20T00:00:00Z'));
  expect(current.payload.so_far).toBe(true);expect(current.payload.to_exclusive).toBe('2026-04-20T00:00:00.000Z');expect(current.payload.reconciliation.difference).toBe('0');
  expect(statementMonth('2026-02',new Date('2026-03-15')).to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  expect(()=>reconcile({opening:'1',closing:'2',deposits:'0',refunds:'0',usage:'0',fees:'0',other:'0'})).toThrow('reconciliation');
});
test('real production config loader starts with statements enabled',()=>{
  const address='0x'+'1'.repeat(40);
  const cfg=loadConfig({NODE_ENV:'production',ANYROUTE_ENV:'production',RUNTIME_ROLE:'api',AUTO_MIGRATE:'false',HOST:'0.0.0.0',APP_SECRET:'fixture-'.repeat(6),ADMIN_TOKEN:'fixture-admin-'.repeat(3),PUBLIC_BASE_URL:'https://router.example',DATABASE_URL:'postgres://fixture:fixture-only-credential@localhost/statements',REDIS_URL:'redis://:fixture-only-credential@localhost:6379',CREDITS_ADDRESS:address,CALLPAY_ADDRESS:address,PROVIDER_BOND_ADDRESS:address,RECEIPT_ANCHOR_ADDRESS:address,ROUTER_PRIVATE_KEY:'0x'+'3'.repeat(64),STATEMENTS_ENABLED:'true'});
  expect(cfg.production).toBe(true);expect(cfg.statementsEnabled).toBe(true);
});
