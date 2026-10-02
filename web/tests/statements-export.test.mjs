import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { canonicalJson } from '../lib/verify.js';
import { parseStatement, statementReconciles, verifyStatement } from '../lib/statements.js';
import { exportAccount, EXPORT_PARTS, EXPORT_EXCLUSIONS, withoutSecrets } from '../lib/account-export.js';
import { TASKS, ACCOUNT_GROUPS, ACCOUNT_SECTIONS } from '../lib/site-map.js';
const payload = { type:'anyroute.statement.v1', month:'2026-09', opening_balance:'9007199.254740993123', deposits:'1.000000000001',refunds:'0.000000000017',usage:'0.000000000007',fees:'0.000000000003',other_changes:'-0.000000000002',closing_balance:'9007200.254740993129',usage_by_model:[{id:'model',amount:'0.000000000007'}],usage_by_key_agent:[{id:'key-hash',amount:'0.000000000007'}],usage_by_lane:[{id:'attested',amount:'0.000000000007'}],movements_by_kind:[{id:'deposit',amount:'1.000000000001'},{id:'refund',amount:'0.000000000017'},{id:'usage',amount:'-0.000000000007'},{id:'fee',amount:'-0.000000000003'},{id:'adjustment',amount:'-0.000000000002'}] };
test('canonical statement signing uses the receipt verifier and exact arithmetic', async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');const x=publicKey.export({format:'jwk'}).x;const kid=createHash('sha256').update(Buffer.from(x,'base64url')).digest('hex').slice(0,16);
  const statement={payload,alg:'Ed25519',key_id:kid,sig:sign(null,Buffer.from(canonicalJson(payload)),privateKey).toString('base64')};
  const options={keys:{keys:[{kty:'OKP',crv:'Ed25519',x,kid}]}};
  assert.deepEqual(parseStatement(JSON.stringify({data:statement})),statement);
  assert.equal(statementReconciles(payload),true);assert.equal((await verifyStatement(statement,options)).valid,true);
  assert.equal((await verifyStatement({...statement,payload:{...payload,closing_balance:'0'}},options)).valid,false);
  assert.equal(statementReconciles({...payload,usage_by_lane:[]}),false);
  assert.equal(statementReconciles({...payload,fees:0.1}),false);
  assert.throws(()=>parseStatement('{}'));
});
const denied = status => Object.assign(new Error('Unavailable'),{status});
function requestFixture({ errors={}, cycle=false }={}) {
  const paths=[];
  const request=async(path,{signal}={})=>{
    signal?.throwIfAborted();paths.push(path);const u=new URL(path,'https://router.example'),p=u.pathname;
    if(errors[p]) throw denied(errors[p]);
    if(p==='/api/v1/key') return {data:{hash:'own-hash',key:'credential-sentinel',deposit:{key_hash:'deposit-hash'}}};
    if(p==='/api/v1/credits') return {data:{balance:1}};
    if(p==='/api/v1/keys') return {data:[{hash:'own-hash',name:'Account key'}]};
    if(p==='/api/v1/agents') return {data:[{key_hash:'own-hash',policies:[{policy:{caps:{day_usd:2}}}]}]};
    if(p==='/api/v1/agents/me') return {data:{key_hash:'own-hash',policy:{caps:{}}}};
    if(p.endsWith('/events')) return {data:[{id:u.searchParams.has('cursor')?'event-2':'event-1'}],next_cursor:u.searchParams.has('cursor')?null:'events-next'};
    if(p==='/api/v1/sessions') return {data:[{id:u.searchParams.has('before')?'session-2':'session-1',secret:'credential-sentinel'}],next:u.searchParams.has('before')?null:'sessions-next'};
    if(p==='/api/v1/sessions/current') return {data:{id:'own-session'}};
    if(p==='/api/v1/agents/approvals') return {data:[{status:u.searchParams.get('status')}]};
    if(p==='/api/v1/activity') return {data:[{id:u.searchParams.has('cursor')?'call-2':'call-1'}],scope:'key',next_cursor:cycle?'stuck':u.searchParams.has('cursor')?null:'activity-next'};
    if(p.startsWith('/api/v1/statements/')) return {data:{payload:{month:p.slice(-7),account_created_at:'2026-07-15T00:00:00Z'},sig:'signature',key_id:'key-id'}};
    if(p==='/api/v1/agreements') return {data:[{id:u.searchParams.has('cursor')?'agreement-2':'agreement-1'}],next_cursor:u.searchParams.has('cursor')?null:'agreements-next'};
    if(p.endsWith('/profile')) return {data:{id:'profile-slug',visibility:'unlisted'}};
    throw new Error('Unexpected path '+path);
  };
  return {request,paths};
}
const now=new Date('2026-09-20T00:00:00Z');
test('one bundle includes every category, all paged records, every approval status and creation-to-current statements',async()=>{
  const {request,paths}=requestFixture();const progress=[];const bundle=await exportAccount(request,{now,onProgress:p=>progress.push(p)});
  assert.deepEqual(Object.keys(bundle.data),EXPORT_PARTS);assert.deepEqual(Object.keys(bundle.manifest.parts),EXPORT_PARTS);assert.deepEqual(bundle.manifest.included,EXPORT_PARTS);
  assert.deepEqual(bundle.data.activity.data.map(r=>r.id),['call-1','call-2']);assert.equal(bundle.data.activity.scope,'key');
  assert.equal(bundle.data.sessions.data.length,2);assert.equal(bundle.data.agreements.data.length,2);assert.equal(bundle.data.policy_events.data[0].data.length,2);
  assert.equal(bundle.data.approvals.data.length,5);assert.match(bundle.manifest.parts.approvals.limit,/100/);
  assert.deepEqual(bundle.data.statements.data.map(r=>r.payload.month),['2026-09','2026-08','2026-07']);
  assert.equal(bundle.data.agent_profiles.data[0].data.visibility,'unlisted');assert.equal(bundle.manifest.inventory_url,'/keep/');
  assert.equal(paths.filter(p=>p.startsWith('/api/v1/activity')).every(p=>p.includes('to=2026-09-20')),true);
  assert.equal(JSON.stringify(bundle).includes('credential-sentinel'),false);assert.equal(progress.at(-1).completed,10);
  assert.deepEqual(bundle.manifest.excluded,EXPORT_EXCLUSIONS);
});
test('access and disabled features are visible, own-agent/session fallback preserves existing scopes',async()=>{
  const {request}=requestFixture({errors:{'/api/v1/keys':403,'/api/v1/agents':403,'/api/v1/sessions':403,'/api/v1/statements/2026-09':404,'/api/v1/agreements':403,'/api/v1/agents/own-hash/events':403,'/api/v1/agents/own-hash/profile':403}});
  const b=await exportAccount(request,{now});assert.equal(b.manifest.parts.keys.status,'unavailable');assert.equal(b.manifest.parts.statements.http_status,404);assert.equal(b.data.sessions.data.id,'own-session');
  assert.equal(b.data.rulebooks.data.key_hash,'own-hash');assert.equal(b.data.policy_events.unavailable[0].http_status,403);assert.equal(b.data.agent_profiles.unavailable[0].http_status,403);assert.ok(!b.manifest.included.includes('statements'));
});
test('cancel prevents completion, failures are surfaced and unchanged cursors are rejected',async()=>{
  const ac=new AbortController();const {request}=requestFixture();let count=0;
  await assert.rejects(exportAccount(async(...args)=>{const r=await request(...args);if(++count===2)ac.abort();return r;},{now,signal:ac.signal}),{name:'AbortError'});
  for(const status of [401,429,500]) await assert.rejects(exportAccount(requestFixture({errors:{'/api/v1/key':status}}).request,{now}),{status});
  await assert.rejects(exportAccount(requestFixture({cycle:true}).request,{now}),/cursor did not advance/);
});
test('secret stripping keeps key metadata and navigation uses the account map',()=>{
  assert.deepEqual(withoutSecrets({key:'credential',keys:[{hash:'hash',key_hash:'hash',secret:'credential',deposit:{key_hash:'chain-hash'}}]}),{keys:[{hash:'hash',key_hash:'hash',deposit:{key_hash:'chain-hash'}}]});
  for(const [id,group,hash] of [['statements','Money','statements'],['account-export','Account','export-data']]){assert.ok(ACCOUNT_GROUPS.find(g=>g.title===group).ids.includes(id));assert.equal(ACCOUNT_SECTIONS.find(s=>s.taskId===id).hash,hash);assert.equal(TASKS.find(t=>t.id===id).menu,false);}
});
