import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,streamChat} from '../lib/api.js';
import {LANE,LANE_HEADER,MODELS_PATH,SWITCH_KEY,attestedModels,bareHost,createPrivateStore,fetchPrivacyLabel,labelText,laneHeaders,laneIsProven,normalizeLabel,privacyPath,receiptLane,safeUrl,torState} from '../lib/private-mode.js';

const model=(id,lanes=['public','attested'])=>({id,name:id,lanes});
const memory=()=>{const m=new Map();return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>void m.set(k,String(v)),removeItem:k=>void m.delete(k),m}};
const tick=()=>new Promise(r=>setTimeout(r,0));
const ADDRESS='a'.repeat(56)+'.onion';

// ---------------------------------------------------------------- the lane

test('the switch puts every request on the attested lane, and off adds nothing',()=>{
 assert.deepEqual(laneHeaders(true),{[LANE_HEADER]:'attested'});
 assert.equal(LANE_HEADER,'x-anyroute-lane');
 assert.deepEqual(laneHeaders(false),{});
 assert.equal(MODELS_PATH,'/api/v1/models?lane=attested');
});

test('the lane header reaches the chat request through the same transport the Harness uses',async()=>{
 const seen=[];
 const real=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{seen.push({url:String(url),headers:init.headers});return new Response('data: {"id":"g1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})};
 try{
  const store=createPrivateStore({request:async()=>({data:[]}),storage:memory(),host:()=>'x'});
  await streamChat({key:'k',body:{model:'m',messages:[]},headers:{'x-title':'Anyroute Harness',...store.headers()}});
  store.setOn(true);
  await streamChat({key:'k',body:{model:'m',messages:[]},headers:{'x-title':'Anyroute Harness',...store.headers()}});
 }finally{globalThis.fetch=real}
 assert.equal(seen.length,2);
 assert.equal(seen[0].headers[LANE_HEADER],undefined);
 assert.equal(seen[1].headers[LANE_HEADER],'attested');
 assert.equal(seen[1].headers['x-title'],'Anyroute Harness');
});

test('the model list is the attested list, and only models the router says can run on that lane',async()=>{
 const asked=[];
 const store=createPrivateStore({request:async path=>{asked.push(path);return path===MODELS_PATH?{data:[model('a/one'),model('b/two',['public']),{id:'c/three'},model('d/four',['public','attested','unlinkable'])]}:{data:{}}},storage:memory(),host:()=>'router.example'});
 assert.equal(store.get().on,false);
 assert.equal(store.get().models,null);
 store.setOn(true);
 assert.equal(store.get().models,null,'while the list loads there is nothing to pick');
 await tick();
 assert.ok(asked.includes(MODELS_PATH));
 assert.deepEqual(store.get().models.map(m=>m.id),['a/one','d/four'],'a router that ignored ?lane= cannot widen the list');
 assert.deepEqual(store.headers(),{'x-anyroute-lane':'attested'});
 store.setOn(false);
 assert.equal(store.get().models,null);
 assert.deepEqual(store.headers(),{});
});

test('if the attested list cannot be loaded nothing can be picked, and retry asks again',async()=>{
 let fail=true;
 const store=createPrivateStore({request:async path=>{if(path===MODELS_PATH&&fail)throw new ApiError(503,'The router is busy.','error');return path===MODELS_PATH?{data:[model('a/one')]}:{data:{}}},storage:memory(),host:()=>'x'});
 store.setOn(true);await tick();
 assert.deepEqual(store.get().models,[]);
 assert.equal(store.get().error,'The router is busy.');
 assert.deepEqual(store.headers(),{'x-anyroute-lane':'attested'},'the lane stays on while the list is missing');
 fail=false;store.retry();await tick();
 assert.equal(store.get().error,'');
 assert.deepEqual(store.get().models.map(m=>m.id),['a/one']);
});

test('an answer that arrives after the switch was turned off is ignored',async()=>{
 let release;
 const store=createPrivateStore({request:path=>path===MODELS_PATH?new Promise(r=>{release=()=>r({data:[model('late/model')]})}):Promise.resolve({data:{}}),storage:memory(),host:()=>'x'});
 store.setOn(true);store.setOn(false);
 release();await tick();
 assert.equal(store.get().on,false);
 assert.equal(store.get().models,null);
});

test('the choice is remembered on this device and restored, and nothing else is stored',async()=>{
 const storage=memory();
 const a=createPrivateStore({request:async()=>({data:[model('a/one')]}),storage,host:()=>'x'});
 a.setOn(true);
 assert.equal(storage.m.get(SWITCH_KEY),'1');
 assert.deepEqual([...storage.m.keys()],[SWITCH_KEY]);
 const b=createPrivateStore({request:async()=>({data:[model('a/one')]}),storage,host:()=>'x'});
 assert.equal(b.get().on,false);
 b.init();await tick();
 assert.equal(b.get().on,true);
 assert.equal(b.get().models.length,1);
 b.setOn(false);
 assert.equal(storage.m.has(SWITCH_KEY),false);
});

test('subscribers hear every change',async()=>{
 const store=createPrivateStore({request:async()=>({data:[]}),storage:memory(),host:()=>'x'});
 let n=0;const off=store.subscribe(()=>n++);
 store.setOn(true);await tick();off();
 const seen=n;store.setOn(false);
 assert.ok(seen>=2);assert.equal(n,seen);
});

// ---------------------------------------------------------------- the onion address

test('the onion address is read from the status and compared with the page host',()=>{
 const status={data:{onion:{address:ADDRESS,url:'http://'+ADDRESS},lanes:{unlinkable:{available:true,via:['onion']}}}};
 assert.deepEqual(torState(status,ADDRESS),{address:ADDRESS,onOnion:true,unlinkableViaOnion:true,url:'http://'+ADDRESS});
 assert.equal(torState(status,ADDRESS+':80').onOnion,true);
 assert.equal(torState(status,'Router.Example').onOnion,false);
 assert.equal(torState({data:{onion:null}},ADDRESS).onOnion,false);
 assert.equal(torState({data:{onion:{address:'not-an-onion'}}},'not-an-onion').address,null);
 assert.equal(torState({data:{onion:{address:ADDRESS},lanes:{unlinkable:{available:true,via:['ohttp']}}}},'x').unlinkableViaOnion,false);
 assert.equal(torState({data:{onion:{address:ADDRESS},lanes:{unlinkable:{available:false,via:['onion']}}}},'x').unlinkableViaOnion,false);
 assert.equal(bareHost('HTTP://Abc.onion:8080/harness/'),'abc.onion');
});

test('the status is read when the switch turns on, and a failing status hides the Tor notice, not the lane',async()=>{
 const status={data:{onion:{address:ADDRESS},lanes:{unlinkable:{available:true,via:['onion']}}}};
 const store=createPrivateStore({request:async path=>path===MODELS_PATH?{data:[model('a/one')]}:status,storage:memory(),host:()=>ADDRESS});
 store.setOn(true);await tick();
 assert.equal(store.get().tor.onOnion,true);
 const broken=createPrivateStore({request:async path=>{if(path===MODELS_PATH)return{data:[model('a/one')]};throw new Error('down')},storage:memory(),host:()=>ADDRESS});
 broken.setOn(true);await tick();
 assert.equal(broken.get().tor,null);
 assert.equal(broken.get().models.length,1);
});

// ---------------------------------------------------------------- the privacy label and its fallback

const doc={receipt_id:'gen_1',lane:'attested',label:{prompt_readers:'The router reads it to route; the model host cannot',network:'Your address is visible to the router',payment:{text:'API key on your account'},stored:['hashes','token counts'],hardware:'Attested TDX'},summary:['Ran on attested hardware.','The router still reads the prompt to route it.'],verify_url:'/verify/?p=phala'};

test('a privacy label is read bare or inside data, in the contract order',()=>{
 for(const body of [doc,{data:doc}]){
  const l=normalizeLabel(body);
  assert.equal(l.lane,'attested');
  assert.deepEqual(l.rows.map(r=>r.key),['prompt_readers','network','payment','stored','hardware']);
  assert.equal(l.rows[2].text,'API key on your account');
  assert.equal(l.rows[3].text,'hashes, token counts');
  assert.equal(l.summary.length,2);
  assert.equal(l.verifyUrl,'/verify/?p=phala');
 }
});

test('the label as the router builds it: facets are objects with text, the document sits in data',()=>{
 const real={data:{receipt_id:'gen_2',lane:'unlinkable',label:{prompt_readers:{text:'AnyRoute read it in memory',access:'attested_enclave'},network:{text:'Hidden by Tor'},payment:{text:'A blind token',kind:'blind_token'},stored:{text:'Hashes and counts'},hardware:{text:'Attested TDX'}},summary:['a','b','c','d','e'],short:'x',verify_url:'/verify/?r=gen_2'}};
 const l=normalizeLabel(real);
 assert.equal(l.lane,'unlinkable');
 assert.deepEqual(l.rows.map(r=>r.text),['AnyRoute read it in memory','Hidden by Tor','A blind token','Hashes and counts','Attested TDX']);
 assert.equal(l.rows[1].title,'Who saw your address');
 assert.equal(l.verifyUrl,'/verify/?r=gen_2');
 assert.equal(normalizeLabel({...real,data:{...real.data,verify_url:null}}).verifyUrl,'');
});

test('a label the router did not fully send shows only what it sent, and junk is not a label',()=>{
 const l=normalizeLabel({lane:'public',label:{network:'x',hardware:''}});
 assert.deepEqual(l.rows.map(r=>r.key),['network']);
 assert.equal(normalizeLabel(null),null);
 assert.equal(normalizeLabel({}),null);
 assert.equal(normalizeLabel({label:{}}),null);
 assert.equal(normalizeLabel({label:'attested'}),null);
 assert.equal(normalizeLabel({error:{message:'nope'}}),null);
 assert.equal(labelText({nested:{a:1}}),'');
 assert.equal(labelText('router_memory'),'Router memory');
 assert.equal(labelText(['token-counts','hashes']),'Token counts, hashes');
 assert.equal(labelText('Your address is visible to the router'),'Your address is visible to the router');
 assert.equal(labelText('a\u0000b\n\nc'),'a b c');
 assert.equal(normalizeLabel({...doc,summary:Array.from({length:9},(_,i)=>'line '+i)}).summary.length,5);
});

test('only safe links are followed from a label',()=>{
 assert.equal(safeUrl('/verify/?p=x'),'/verify/?p=x');
 assert.equal(safeUrl('https://example.org/a'),'https://example.org/a');
 for(const bad of ['javascript:alert(1)','//evil.example/x','/\\evil.example','data:text/html,x','','  ',null,42])assert.equal(safeUrl(bad),'');
 assert.equal(normalizeLabel({...doc,verify_url:'javascript:alert(1)'}).verifyUrl,'');
});

test('the label is fetched from the receipt privacy endpoint',async()=>{
 const asked=[];
 const r=await fetchPrivacyLabel('gen_1',async path=>{asked.push(path);return{data:doc}});
 assert.deepEqual(asked,['/api/v1/receipts/gen_1/privacy']);
 assert.equal(privacyPath('a b/c'),'/api/v1/receipts/a%20b%2Fc/privacy');
 assert.equal(r.label.lane,'attested');
});

test('without the endpoint, or when it fails, the reply falls back to the lane and receipt link',async()=>{
 const status=code=>fetchPrivacyLabel('gen_1',async()=>{throw new ApiError(code,'x','error')});
 for(const code of [404,405,501])assert.deepEqual(await status(code),{label:null,reason:'absent'});
 for(const code of [0,401,429,500,503])assert.deepEqual(await status(code),{label:null,reason:'unavailable'});
 assert.deepEqual(await fetchPrivacyLabel('gen_1',async()=>{throw new Error('offline')}),{label:null,reason:'unavailable'});
 assert.deepEqual(await fetchPrivacyLabel('gen_1',async()=>({data:{ok:true}})),{label:null,reason:''});
 // what the fallback shows comes from the signed receipt the reply already carries
 const receipt={id:'gen_1',payload:{disclosure:'attested'},v2:{claims:{lane:'attested',disclosure:'attested'}}};
 assert.deepEqual(receiptLane(receipt),{lane:'attested',disclosure:'attested'});
 assert.deepEqual(receiptLane({id:'g',payload:{disclosure:'policy'}}),{lane:'',disclosure:'policy'});
 assert.deepEqual(receiptLane(null),{lane:'',disclosure:''});
});

test('a reply counts as proven hardware only when its receipt says so',()=>{
 assert.equal(LANE,'attested');
 assert.equal(laneIsProven('attested'),true);
 assert.equal(laneIsProven('unlinkable'),true);
 assert.equal(laneIsProven('public'),false);
 assert.equal(laneIsProven(''),false);
});
