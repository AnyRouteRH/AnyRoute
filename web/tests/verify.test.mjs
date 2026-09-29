import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {attestationPath,base64ToBytes,bytesToHex,canonicalJson,describeAttestation,hexToBytes,isEnclaveReceipt,keccak256,parseReceiptInput,providerIdFromSearch,relativeTime,shortDigest,teeLabel,verifyHref,verifyMerkleProof,verifyReceipt} from '../lib/verify.js';

// Recorded evidence shared with the SDK packages (a TDX deployment's attestation, receipt and the router's record of it).
const fx=(name)=>fs.readFileSync(new URL(`../../packages/client/test/fixtures/${name}`,import.meta.url),'utf8');
const json=(name)=>JSON.parse(fx(name));
const router=()=>json('router-attestation.json');
const NOW=Date.parse('2026-09-29T08:30:00Z');
const utf8=(s)=>new TextEncoder().encode(s);

test('the provider id comes from the query string and nothing else is trusted',()=>{
 assert.equal(providerIdFromSearch('?p=example-provider'),'example-provider');
 assert.equal(providerIdFromSearch('?provider=abc_1.2'),'abc_1.2');
 assert.equal(providerIdFromSearch(''),'');
 assert.equal(providerIdFromSearch('?p='),'');
 for(const bad of ['?p=../etc','?p=a b','?p=<script>','?p=%2F..','?p=-x'])assert.equal(providerIdFromSearch(bad),'',bad);
 assert.equal(providerIdFromSearch('?p='+'a'.repeat(129)),'');
 assert.equal(verifyHref('a b'),'/verify/?p=a%20b');
 assert.equal(attestationPath('a/b'),'/api/v1/attestation/a%2Fb');
});

test('an attested record reads as attested, with what the router checked and nothing more',()=>{
 const v=describeAttestation(router(),NOW);
 assert.equal(v.status,'attested');
 assert.equal(v.verdict.tone,'ok');
 assert.match(v.verdict.text,/did not contact the provider/);
 assert.equal(v.rows.tee.value,'Intel TDX (confidential virtual machine)');
 assert.equal(v.rows.tee.state,'known'); // reported by the router, not a claim this page verified
 assert.equal(v.rows.verifiers.state,'yes');
 assert.equal(v.rows.verifiers.value.length,2);
 assert.equal(v.rows.lastVerified.relative,'10 min ago');
 assert.deepEqual(v.measurement.digests.map((d)=>d.key),['image','compose','model']);
 assert.equal(v.measurement.currentlyAttested,true);
 assert.equal(v.measurement.digests[2].value,router().measurement.model_digest);
 const state=Object.fromEntries(v.checks.map((c)=>[c.id,c.state]));
 assert.deepEqual(state,{quote_verified:'yes',digests_bound_to_quote:'yes',transparency_log_entry:'no',transparency_log_checkpoint_signature:'no',registered_on_chain:'no'});
 // Nothing was found in a log and nothing is on chain, and the page says so.
 assert.equal(v.transparencyLog.state,'no');
 assert.match(v.transparencyLog.text,/No transparency-log entry/);
 assert.equal(v.registry.state,'no');
 assert.match(v.registry.text,/Not registered on chain/);
 // The router's own list of gaps is kept, and the page adds that it never looked at the provider.
 assert.ok(v.notChecked.length>=router().not_checked.length+1);
 assert.match(v.notChecked.at(-1),/router's record/);
});

test('unverified stays unverified: no time, no verifiers, no hardware, whatever else the record holds',()=>{
 for(const reason of ['no_attestation','last_attempt_failed','attestation_stale','simulated_evidence_refused',undefined]){
  const rec={...router(),status:'unverified',reason,attested_at:null,attestation_hash:null,verifiers:['dcap'],tee:'tdx',checks:{...router().checks,quote_verified:false,digests_bound_to_quote:false}};
  const v=describeAttestation(rec,NOW);
  assert.equal(v.status,'unverified');
  assert.equal(v.verdict.tone,'bad');
  assert.equal(v.verdict.label,'Unverified');
  assert.match(v.verdict.text,/not be read as a privacy guarantee|nothing here should be read/i);
  assert.equal(v.rows.tee.state,'unknown');
  assert.equal(v.rows.tee.value,'Not established');
  assert.deepEqual(v.rows.verifiers.value,[]);
  assert.equal(v.rows.verifiers.state,'no');
  assert.equal(v.rows.lastVerified.value,'');
  assert.equal(v.rows.lastVerified.state,'no');
  assert.equal(v.checks.find((c)=>c.id==='quote_verified').state,'no');
 }
 assert.match(describeAttestation({status:'unverified',reason:'attestation_stale'}).verdict.text,/too old/);
 assert.match(describeAttestation({status:'unverified',reason:'last_attempt_failed'}).verdict.text,/failed/);
});

test('flags that contradict an unverified status are not believed',()=>{
 const rec={...router(),status:'unverified',reason:'attestation_stale',attested_at:null};
 rec.measurement.attested_now=true; // stale or inconsistent data
 assert.equal(rec.checks.quote_verified,true);
 const v=describeAttestation(rec,NOW);
 assert.equal(v.measurement.currentlyAttested,false);
 assert.equal(v.checks.find((c)=>c.id==='quote_verified').state,'no');
 assert.equal(v.checks.find((c)=>c.id==='digests_bound_to_quote').state,'no');
});

test('anything unrecognised, missing or hostile is unverified',()=>{
 for(const bad of [undefined,null,{},{status:'ATTESTED'},{status:'verified'},{status:'attested-ish'},'attested',42]){
  const v=describeAttestation(bad,NOW);
  assert.equal(v.status,'unverified',JSON.stringify(bad));
  assert.equal(v.verdict.tone,'bad');
 }
 // Markup in a field is data: it is returned as a string for React to escape, never interpreted here.
 const v=describeAttestation({...router(),tee:'<img src=x onerror=alert(1)>'},NOW);
 assert.equal(v.rows.tee.value,'<img src=x onerror=alert(1)>');
});

test('simulated evidence is shown as simulated, never as attested',()=>{
 const v=describeAttestation({...router(),status:'simulated',tee:'dev',measurement:null},NOW);
 assert.equal(v.status,'simulated');
 assert.equal(v.verdict.tone,'warn');
 assert.match(v.verdict.text,/nothing about it is private or verified/);
 assert.equal(v.rows.tee.state,'simulated');
 assert.equal(v.rows.verifiers.state,'no');
 assert.equal(v.measurement.recorded,false);
});

test('a measurement that is not currently attested is flagged as last seen',()=>{
 const rec=router();rec.status='unverified';rec.reason='attestation_stale';rec.measurement.attested_now=false;
 const v=describeAttestation(rec,NOW);
 assert.equal(v.measurement.recorded,true);
 assert.equal(v.measurement.currentlyAttested,false);
 assert.equal(describeAttestation({...router(),measurement:null},NOW).measurement.recorded,false);
});

test('transparency log and registry states are stated exactly',()=>{
 const withLog=(log)=>{const r=router();r.measurement.transparency_log={...r.measurement.transparency_log,...log};return describeAttestation(r,NOW).transparencyLog;};
 assert.equal(withLog({found:true,inclusion_verified:true,checkpoint_signature_verified:true,log_index:7}).state,'yes');
 assert.equal(withLog({found:true,inclusion_verified:true,checkpoint_signature_verified:false}).state,'partial');
 assert.match(withLog({found:true,inclusion_verified:true,checkpoint_signature_verified:false}).text,/signature over the checkpoint was not/);
 assert.match(withLog({found:true,inclusion_verified:false}).text,/has not been verified/);
 assert.equal(withLog({found:false,inclusion_verified:true}).state,'no'); // a stray flag without an entry is not a pass
 const withReg=(state)=>{const r=router();r.measurement.registry={...r.measurement.registry,state};return describeAttestation(r,NOW).registry;};
 assert.equal(withReg('registered').state,'yes');
 assert.equal(withReg('revoked').state,'bad');
 assert.equal(withReg('submitted_unconfirmed').state,'partial');
 for(const s of ['calldata_ready_not_submitted','not_submitted','not_recorded','something_new'])assert.equal(withReg(s).state,'no',s);
});

test('small formatters',()=>{
 assert.equal(relativeTime('2026-09-29T08:29:40Z',NOW),'just now');
 assert.equal(relativeTime('2026-09-29T07:31:00Z',NOW),'59 min ago');
 assert.equal(relativeTime('2026-09-29T02:30:00Z',NOW),'6 h ago');
 assert.equal(relativeTime('2026-09-26T08:30:00Z',NOW),'3 d ago');
 assert.equal(relativeTime('2026-10-29T08:30:00Z',NOW),'in the future');
 assert.equal(relativeTime('nonsense',NOW),'');
 assert.equal(relativeTime(null,NOW),'');
 assert.equal(shortDigest('0x'+'ab'.repeat(32)).length,'0x'.length+10+1+8);
 assert.equal(shortDigest('short'),'short');
 assert.equal(teeLabel('tdx'),'Intel TDX (confidential virtual machine)');
 assert.equal(teeLabel('sev-snp'),'AMD SEV-SNP (confidential virtual machine)');
 assert.equal(teeLabel(null),'Not reported');
 assert.equal(teeLabel('dev'),'None: simulated for development');
});

test('canonical JSON and Keccak-256 agree with the router on shared vectors',()=>{
 for(const c of json('canonical-vectors.json'))assert.equal(canonicalJson(JSON.parse(c.input)),c.expected,c.input);
 assert.equal(bytesToHex(keccak256(new Uint8Array())),'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
 assert.equal(bytesToHex(keccak256(utf8('abc'))),'4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
 assert.equal(bytesToHex(keccak256(utf8('a'.repeat(200)))),'96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d');
 assert.deepEqual(base64ToBytes('-_8'),new Uint8Array([251,255]));
 assert.throws(()=>hexToBytes('abc'));
});

const boundKey=()=>json('attest-boot.json').bindings.receipt_pubkey;
const status=(v,id)=>v.checks.find((c)=>c.id===id)?.status;

test('a real receipt verifies against the key its quote commits to; any change to it fails',async()=>{
 const r=json('receipt.json');
 const v=await verifyReceipt(r,{publicKeyHex:boundKey()});
 assert.equal(v.valid,true);
 assert.equal(status(v,'signature'),'pass');
 assert.equal(status(v,'leaf'),'pass');
 assert.equal(status(v,'anchor_proof'),'not_checked');
 assert.equal(v.anchor,'no_proof');
 assert.ok(v.notChecked.some((n)=>/on chain/.test(n)));
 for(const change of [{status:500},{usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}},{extra:1}]){
  const t=await verifyReceipt({...r,payload:{...r.payload,...change}},{publicKeyHex:boundKey()});
  assert.equal(t.valid,false);assert.equal(status(t,'signature'),'fail');
 }
 assert.equal((await verifyReceipt({...r,leaf:'0x'+'11'.repeat(32)},{publicKeyHex:boundKey()})).valid,false);
 assert.equal((await verifyReceipt({...r,key_id:'0000000000000000'},{publicKeyHex:boundKey()})).valid,false);
 assert.equal((await verifyReceipt(r,{publicKeyHex:'zz'})).valid,false);
 assert.equal(isEnclaveReceipt(r),true);
});

function routerKey(from='2026-09-01T00:00:00.000Z',to=null){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const x=publicKey.export({format:'jwk'}).x;
 const raw=Buffer.from(x,'base64url');
 const kid=createHash('sha256').update(raw).digest('hex').slice(0,16);
 return {kid,privateKey,jwk:{kty:'OKP',crv:'Ed25519',x,kid,use:'sig',alg:'EdDSA',valid_from:from,retired_at:to},sign(payload){const bytes=Buffer.from(canonicalJson(payload));const sig=sign(null,bytes,privateKey);const inner=keccak256(Buffer.concat([bytes,sig]));return {id:payload.id,payload,sig:sig.toString('base64'),key_id:kid,alg:'Ed25519',leaf:'0x'+bytesToHex(keccak256(inner))}}};
}
const payload={v:1,id:'gen-1',issued:'2026-09-15T10:00:00.000Z',model:'m',provider:'p',cost:'0.00001'};

test('router receipts verify against the published key list and only against it',async()=>{
 const k=routerKey(),other=routerKey();
 const r=k.sign(payload);
 const ok=await verifyReceipt(r,{keys:{keys:[k.jwk]}});
 assert.equal(ok.valid,true);assert.equal(status(ok,'key_window'),'pass');
 assert.equal((await verifyReceipt(r,{keys:[k.jwk]})).valid,true);
 assert.equal((await verifyReceipt(r,{keys:{keys:[other.jwk]}})).valid,false);
 assert.equal((await verifyReceipt(r,{keys:{keys:[]}})).valid,false);
 assert.match((await verifyReceipt(r,{keys:{keys:[]}})).checks.find((c)=>c.id==='key').detail,/not in the router's published key list/);
 const liar={...k.jwk,x:other.jwk.x};
 assert.equal(status(await verifyReceipt(r,{keys:[liar]}),'key'),'fail');
 assert.equal((await verifyReceipt({...r,payload:{...r.payload,cost:'0'}},{keys:[k.jwk]})).valid,false);
});

test('a receipt dated outside its key window is flagged',async()=>{
 const k=routerKey('2026-09-01T00:00:00.000Z','2026-09-08T00:00:00.000Z');
 const late=await verifyReceipt(k.sign({...payload,issued:'2026-09-20T00:00:00.000Z'}),{keys:[k.jwk]});
 assert.equal(late.valid,false);assert.equal(status(late,'key_window'),'fail');
 assert.equal((await verifyReceipt(k.sign({...payload,issued:'2026-09-05T00:00:00.000Z'}),{keys:[k.jwk]})).valid,true);
});

test('a browser without Ed25519 says it did not check, and the receipt is not called valid',async()=>{
 const k=routerKey();
 const v=await verifyReceipt(k.sign(payload),{keys:[k.jwk],ed25519:async()=>{throw Object.assign(new Error('This browser cannot verify Ed25519 signatures.'),{unsupported:true})}});
 assert.equal(status(v,'signature'),'not_checked');
 assert.equal(v.valid,false);
});

test('anchor proofs are checked when present and a wrong one fails the receipt',async()=>{
 const k=routerKey();
 const r=k.sign(payload);
 const sibling=keccak256(new Uint8Array([9]));
 const leaf=hexToBytes(r.leaf);
 const [a,b]=Buffer.compare(leaf,sibling)<0?[leaf,sibling]:[sibling,leaf];
 const root='0x'+bytesToHex(keccak256(Buffer.concat([a,b])));
 const good=await verifyReceipt({...r,anchor:{root,proof:['0x'+bytesToHex(sibling)]}},{keys:[k.jwk]});
 assert.equal(good.anchor,'proof_valid');assert.equal(good.valid,true);
 const bad=await verifyReceipt({...r,anchor:{root,proof:['0x'+bytesToHex(keccak256(new Uint8Array([10])))]}},{keys:[k.jwk]});
 assert.equal(bad.anchor,'proof_invalid');assert.equal(bad.valid,false);
 assert.equal(verifyMerkleProof(r.leaf,[],r.leaf),true);
 assert.equal(verifyMerkleProof('nothex',[],root),false);
});

test('malformed receipts fail without throwing',async()=>{
 for(const bad of [null,{},{payload:{},sig:'',key_id:''},{payload:5,sig:'x',key_id:'y'},'text'])assert.equal((await verifyReceipt(bad,{keys:[]})).valid,false);
});

test('pasted input: a receipt, a chat response, or a lookup response',()=>{
 const r=json('receipt.json');
 assert.equal(parseReceiptInput(JSON.stringify(r)).receipt.sig,r.sig);
 assert.equal(parseReceiptInput(JSON.stringify({id:'x',choices:[],receipt:r})).receipt.key_id,r.key_id);
 assert.equal(parseReceiptInput(JSON.stringify({data:r})).receipt.key_id,r.key_id);
 assert.equal(parseReceiptInput(JSON.stringify({data:{receipt:r}})).receipt.key_id,r.key_id);
 assert.match(parseReceiptInput('').error,/Paste/);
 assert.match(parseReceiptInput('{nope').error,/valid JSON/);
 assert.match(parseReceiptInput('{"a":1}').error,/No receipt found/);
 assert.match(parseReceiptInput('[1,2]').error,/No receipt found/);
 assert.match(parseReceiptInput('null').error,/No receipt found/);
});
