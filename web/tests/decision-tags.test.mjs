import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {canonicalJson,orderDecisionTag,receiptDecisionTag,verifyReceipt} from '../lib/verify.js';

// B: decision tags on /verify. The order hash is the one the decision-receipt helpers and the SDKs compute (the same
// known vector as test/decision-tag.test.ts and integrations/robinhood-agents/decision_receipt.py).
const intent={symbol:'STOCK_A',side:'buy',quantity:'2',limit_price:'180.00',client_order_id:'7f3c'};
const TAG='sha256:c6a5490500b12be3787fadaa8d87982c369b158af7f5cdfdc8643b5177477c8d';
const OTHER='sha256:'+'ab'.repeat(32);
const read=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

test('an order pasted on the page hashes to the helpers’ known vector, whatever its key order or spacing',async()=>{
 assert.deepEqual(await orderDecisionTag(JSON.stringify(intent)),{tag:TAG});
 assert.deepEqual(await orderDecisionTag(JSON.stringify({client_order_id:'7f3c',limit_price:'180.00',quantity:'2',side:'buy',symbol:'STOCK_A'},null,2)),{tag:TAG});
 // A digest is taken as it is, in any case, with or without its prefix.
 assert.deepEqual(await orderDecisionTag(TAG.slice(7).toUpperCase()),{tag:TAG,digest:true});
 assert.deepEqual(await orderDecisionTag(` ${TAG} `),{tag:TAG,digest:true});
 // One field written differently is another order.
 assert.notEqual((await orderDecisionTag(JSON.stringify({...intent,quantity:2}))).tag,TAG);
 for(const bad of ['','  ','{"symbol":','[1,2]','"STOCK_A"','42','null'])assert.ok((await orderDecisionTag(bad)).error,bad);
});

test('a receipt’s tag is read from v1 or v2, and two different tags are flagged',()=>{
 assert.equal(receiptDecisionTag({payload:{model:'m'}}),null);
 assert.deepEqual(receiptDecisionTag({payload:{decision_tag:TAG}}),{tag:TAG,v1:TAG,v2:null,agree:true,wellFormed:true});
 assert.deepEqual(receiptDecisionTag({cose:'x'},{decision_tag:TAG}),{tag:TAG,v1:null,v2:TAG,agree:true,wellFormed:true});
 assert.equal(receiptDecisionTag({payload:{decision_tag:TAG},v2:{claims:{decision_tag:OTHER}}}).agree,false);
 // The decoded, signed claims win over the readable copy beside them.
 assert.equal(receiptDecisionTag({v2:{claims:{decision_tag:OTHER}}},{decision_tag:TAG}).tag,TAG);
});

// A router key and a minimal CBOR writer, enough to sign a v1 payload and a v2 COSE_Sign1 for one call.
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const x=publicKey.export({format:'jwk'}).x;
const kid=createHash('sha256').update(Buffer.from(x,'base64url')).digest('hex').slice(0,16);
const keys={keys:[{kty:'OKP',crv:'Ed25519',x,kid}]};
const head=(major,n)=>Buffer.from(n<24?[major<<5|n]:n<256?[major<<5|24,n]:[major<<5|25,n>>8,n&255]);
const cbor=v=>typeof v==='number'?(v>=0?head(0,v):head(1,-1-v)):typeof v==='string'?Buffer.concat([head(3,Buffer.byteLength(v)),Buffer.from(v)]):Buffer.isBuffer(v)?Buffer.concat([head(2,v.length),v]):v instanceof Map?Buffer.concat([head(5,v.size),...[...v].flatMap(([k,y])=>[cbor(k),cbor(y)])]):Buffer.concat([head(4,v.length),...v.map(cbor)]);
function receipt(v1Tag,v2Tag){
 const payload={v:1,id:'gen-1',issued:'2026-09-15T10:00:00.000Z',model:'m',provider:'p',...(v1Tag?{decision_tag:v1Tag}:{})};
 const sig=sign(null,Buffer.from(canonicalJson(payload)),privateKey).toString('base64');
 const prot=cbor(new Map([[1,-8],[4,Buffer.from(kid,'hex')]]));
 const claims=cbor(new Map([['v',2],['rid','gen-1'],...(v2Tag?[['decision_tag',v2Tag]]:[])]));
 const coseSig=sign(null,cbor(['Signature1',prot,Buffer.alloc(0),claims]),privateKey);
 const cose=Buffer.concat([Buffer.from([0xd2]),cbor([prot,new Map(),claims,coseSig])]).toString('base64');
 return {id:'gen-1',payload,sig,key_id:kid,v2:{cose}};
}
const checks=r=>Object.fromEntries(r.checks.map(c=>[c.id,c.status]));

test('a tagged receipt verifies and its signed claims carry the tag; v1 and v2 naming different tags fail',async()=>{
 const same=await verifyReceipt(receipt(TAG,TAG),{keys});
 assert.equal(same.valid,true);
 assert.equal(checks(same).decision_tag,undefined);
 assert.equal(receiptDecisionTag(receipt(TAG,TAG),same.claims).tag,TAG);
 const plain=await verifyReceipt(receipt(null,null),{keys});
 assert.equal(plain.valid,true);
 assert.equal(receiptDecisionTag(receipt(null,null),plain.claims),null);
 for(const [a,b] of [[TAG,OTHER],[TAG,null],[null,TAG]]){
  const mixed=await verifyReceipt(receipt(a,b),{keys});
  assert.equal(checks(mixed).signature,'pass');assert.equal(checks(mixed).v2_signature,'pass');
  assert.equal(checks(mixed).decision_tag,'fail');assert.equal(mixed.valid,false);
 }
});

test('the page shows the tag, hashes the order in the browser and says nothing is sent, in plain words',()=>{
 const page=read('components/Verify.jsx');
 assert.match(page,/function DecisionTag/);
 assert.match(page,/orderDecisionTag\(order\)/);
 assert.match(page,/receiptDecisionTag\(receipt,r\.claims\)/);
 assert.match(page,/the order is not sent anywhere/);
 // ?r=<id> fills the checker with that receipt, read from the public receipt route.
 assert.match(page,/'\/api\/v1\/receipts\/'\+encodeURIComponent\(rid\)/);
 const block=page.slice(page.indexOf('function DecisionTag'),page.indexOf('function ReceiptBox'));
 const visible=[...block.matchAll(/>([^<>{}]+)</g),...block.matchAll(/'([^'\n]{12,})'/g),...block.matchAll(/`([^`\n]{12,})`/g)].map(m=>m[1]).join(' ');
 assert.doesNotMatch(visible,/\b(?:demo|test|tested|local|mock|simulated|placeholder|fixture|earn|yield|APY|x402)\b/i);
 assert.doesNotMatch(visible,/\b(?:AAPL|TSLA|NVDA|MSFT|AMZN|GOOGL|META|SPY|QQQ)\b/);
});
