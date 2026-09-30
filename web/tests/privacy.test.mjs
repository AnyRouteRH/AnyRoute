import test from 'node:test';
import assert from 'node:assert/strict';
import {describePrivacy,isReceiptId,privacyHref,privacyPath,receiptIdFromSearch} from '../lib/privacy.js';

const label=(over={})=>({
 receipt_id:'gen-1',lane:'attested',
 label:{
  prompt_readers:{text:'AnyRoute’s router read the prompt in memory to route it.'},
  network:{text:'AnyRoute’s servers saw the network address your request arrived from.'},
  payment:{text:'Paid from the balance of an API key.'},
  stored:{text:'AnyRoute’s database kept a record of this call.'},
  hardware:{text:'Attested hardware.'},
 },
 summary:['a','b','c','d','e'],short:'Read by: router + proven enclave',verify_url:'https://r.example/verify?r=gen-1',...over,
});

test('the receipt id comes from the query string and nothing else is trusted',()=>{
 assert.equal(receiptIdFromSearch('?r=gen-1790461071-M1D5SJxd7YpD5A'),'gen-1790461071-M1D5SJxd7YpD5A');
 assert.equal(receiptIdFromSearch('?receipt=gen_1.2'),'gen_1.2');
 assert.equal(receiptIdFromSearch(''),'');
 assert.equal(receiptIdFromSearch('?r='),'');
 for(const bad of ['?r=../etc','?r=a b','?r=<script>','?r=%2F..','?r=-x'])assert.equal(receiptIdFromSearch(bad),'',bad);
 assert.equal(receiptIdFromSearch('?r='+'a'.repeat(129)),'');
 assert.equal(isReceiptId('gen-1'),true);
 assert.equal(isReceiptId('gen 1'),false);
 assert.equal(isReceiptId(undefined),false);
 assert.equal(privacyPath('gen-1'),'/api/v1/receipts/gen-1/privacy');
 assert.equal(privacyPath('a/b'),'/api/v1/receipts/a%2Fb/privacy');
 assert.equal(privacyHref('gen-1'),'/verify/?r=gen-1');
});

test('the label is laid out in the order the page reads it, with the router’s own sentences',()=>{
 const v=describePrivacy({data:label()});
 assert.equal(v.id,'gen-1');
 assert.equal(v.lane,'Attested lane');
 assert.deepEqual(v.summary,['a','b','c','d','e']);
 assert.deepEqual(v.rows.map((r)=>r.key),['prompt_readers','network','payment','stored','hardware']);
 assert.deepEqual(v.rows.map((r)=>r.title),['Who could read the request','Who saw your address','How it was paid','What was kept','What hardware answered']);
 assert.match(v.rows[0].text,/read the prompt in memory/);
 assert.deepEqual(describePrivacy(label()),v,'a bare label is accepted too');
});

test('a receipt with no lane, and a label with pieces missing, are shown as they are',()=>{
 assert.equal(describePrivacy({data:label({lane:null})}).lane,'Lane not recorded in this receipt');
 assert.equal(describePrivacy({data:label({lane:'unlinkable'})}).lane,'Unlinkable lane');
 const partial=describePrivacy({data:label({label:{network:{text:'seen'},payment:{}},receipt_id:'bad id'})});
 assert.deepEqual(partial.rows.map((r)=>r.key),['network']);
 assert.equal(partial.id,'','an id that is not a plain token is dropped');
});

test('anything that is not a label is refused, and long text is cut',()=>{
 for(const bad of [null,undefined,5,'x',[],{},{data:{}},{data:{summary:[],label:{}}},{data:{summary:'no',label:{}}},{data:{summary:['a'],label:null}},{error:{type:'not_found'}}])assert.equal(describePrivacy(bad),null);
 const long=describePrivacy({data:label({summary:['x'.repeat(900),'', 5,'ok','1','2','3'],label:{network:{text:'y'.repeat(5000)}}})});
 assert.equal(long.summary.length,5);
 assert.equal(long.summary[0].length,400);
 assert.equal(long.rows[0].text.length,1600);
});


test('output usage is rendered from the label, including unfamiliar units, without inventing missing fields',()=>{
 for(const unit of ['token','image_mp','video_sec','audio_sec','call','gpu_sec','future_unit']){
  const text=`Output metered in ${unit}; content retention not established.`;
  const doc=label();doc.label.output={unit_type:unit,units:2,text};
  const view=describePrivacy(doc);
  assert.deepEqual(view.rows[0],{key:'output',title:'Output and usage',text});
  assert.equal(view.rows.length,6);
 }
 assert.equal(describePrivacy(label()).rows.length,5);
});
