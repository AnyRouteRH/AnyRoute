import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryError,MAX_CHATS,MAX_BYTES,createHistory,memoryStorage,restoreLanes,snapshotLanes,titleOf} from '../lib/private-history.js';
import {replyFacts} from '../lib/harness.js';

const ROUNDS=100_000; // the lowest count a vault may declare; keeps these fast
const PASS='correct horse battery staple';
const SECRET='the launch code is swordfish';
const open=(storage=memoryStorage())=>({storage,history:createHistory({storage,iterations:ROUNDS})});
const chat=(id,text=SECRET)=>({id,title:text.slice(0,30),lanes:[{modelId:'m/one',messages:[{id:'u1',role:'user',text,files:[]},{id:'a1',role:'assistant',text:'noted',model:'m/one'}]}]});
const b64=bytes=>Buffer.from(bytes).toString('base64');
const code=fn=>fn.then(()=>null,e=>e instanceof HistoryError?e.code:'other:'+e?.message);

test('a history survives a lock and comes back with the same passphrase',async()=>{
 const {storage,history}=open();
 assert.equal(await history.exists(),false);
 await history.create(PASS);
 assert.equal(history.unlocked,true);
 await history.put(chat('c1'));
 await history.put(chat('c2','second chat'));
 assert.deepEqual(history.list().map(c=>c.id),['c2','c1']);
 history.lock();
 assert.equal(history.unlocked,false);
 assert.deepEqual(history.list(),[]);
 assert.throws(()=>history.get('c1'),{code:'locked'});
 assert.equal(await code(history.put(chat('c3'))),'locked');
 // a new page load: another instance over the same storage
 const again=createHistory({storage,iterations:ROUNDS});
 assert.equal(await again.exists(),true);
 await again.unlock(PASS);
 assert.deepEqual(again.get('c1'),{...chat('c1'),at:again.get('c1').at});
 assert.equal(again.list().find(c=>c.id==='c1').turns,1);
});

test('what is stored is ciphertext: no text, title or count in the clear',async()=>{
 const {storage,history}=open();
 await history.create(PASS);
 await history.put(chat('chat-canary-1')); // '-' is not a base64 character, so the id cannot appear in ciphertext by chance
 const record=await storage.get();
 assert.deepEqual(Object.keys(record).sort(),['ct','iterations','iv','kdf','salt','v']);
 assert.equal(record.kdf,'PBKDF2-SHA256');
 assert.equal(record.iterations,ROUNDS);
 const raw=JSON.stringify(record);
 for(const needle of [SECRET,'swordfish','chat-canary-1','noted','m/one','assistant',PASS])assert.equal(raw.includes(needle),false,needle);
 assert.equal(Buffer.from(record.iv,'base64').length,12);
 assert.equal(Buffer.from(record.salt,'base64').length,16);
});

test('every write uses a fresh IV and the same salt',async()=>{
 const {storage,history}=open();
 await history.create(PASS);
 const first=await storage.get();
 await history.put(chat('c1'));
 const second=await storage.get();
 await history.put(chat('c1','edited'));
 const third=await storage.get();
 assert.equal(new Set([first.iv,second.iv,third.iv]).size,3);
 assert.equal(new Set([first.salt,second.salt,third.salt]).size,1);
 assert.notEqual(second.ct,third.ct);
});

test('a wrong passphrase opens nothing, changes nothing, and does not lock out the right one',async()=>{
 const {storage,history}=open();
 await history.create(PASS);
 await history.put(chat('c1'));
 history.lock();
 const before=JSON.stringify(await storage.get());
 for(const wrong of ['wrong passphrase','','correct horse battery stapl',PASS.toUpperCase()]){
  assert.equal(await code(history.unlock(wrong)),'wrong_passphrase');
  assert.equal(history.unlocked,false);
  assert.deepEqual(history.list(),[]);
 }
 assert.equal(JSON.stringify(await storage.get()),before);
 await history.unlock(PASS);
 assert.equal(history.list().length,1);
});

test('a changed or damaged record is refused, never half-read',async()=>{
 const {storage,history}=open();
 await history.create(PASS);
 await history.put(chat('c1'));
 history.lock();
 const good=await storage.get();
 // one flipped bit in the ciphertext fails authentication
 const bytes=Buffer.from(good.ct,'base64');bytes[3]^=1;
 await storage.set({...good,ct:b64(bytes)});
 assert.equal(await code(history.unlock(PASS)),'wrong_passphrase');
 // a record that is not the expected shape is unreadable, not a wrong passphrase
 for(const bad of [{...good,v:2},{...good,kdf:'other'},{...good,iterations:5},{...good,iterations:1e12},{...good,salt:7},{ct:good.ct}]){
  await storage.set(bad);
  assert.equal(await code(history.unlock(PASS)),'unreadable');
 }
 // the same record with its count changed derives another key
 await storage.set({...good,iterations:good.iterations+1});
 assert.equal(await code(history.unlock(PASS)),'wrong_passphrase');
 await storage.set(good);
 await history.unlock(PASS);
});

test('forget deletes the vault, the key and the chats, and can be called at any time',async()=>{
 const {storage,history}=open();
 assert.equal(await code(history.forget()),null,'nothing to forget is not an error');
 await history.create(PASS);
 await history.put(chat('c1'));
 await history.forget();
 assert.equal(await storage.get(),null);
 assert.equal(await history.exists(),false);
 assert.equal(history.unlocked,false);
 assert.deepEqual(history.list(),[]);
 assert.equal(await code(history.unlock(PASS)),'no_vault');
 assert.equal(await code(history.put(chat('c2'))),'locked');
 // a write that was still queued cannot bring it back
 await history.create(PASS);
 const late=history.put(chat('c3'));
 await history.forget();
 await late;
 assert.equal(await storage.get(),null);
 assert.equal(await code(history.put(chat('c4'))),'locked');
 // and a fresh start works
 await history.create('another passphrase');
 assert.equal(history.list().length,0);
});

test('a new vault needs a real passphrase and never replaces an existing one',async()=>{
 const {storage,history}=open();
 assert.equal(await code(history.create('short')),'weak_passphrase');
 assert.equal(await code(history.create('')),'weak_passphrase');
 assert.equal(await storage.get(),null);
 await history.create(PASS);
 const held=JSON.stringify(await storage.get());
 assert.equal(await code(history.create('a different passphrase')),'exists');
 assert.equal(JSON.stringify(await storage.get()),held);
});

test('a passphrase is compared as Unicode text, not bytes of one spelling',async()=>{
 const {history}=open();
 await history.create('café au lait');
 history.lock();
 await history.unlock('café au lait');
 assert.equal(history.unlocked,true);
});

test('deleting one conversation, and the limits on how much is kept',async()=>{
 const {history}=open();
 await history.create(PASS);
 await history.put(chat('c1'));await history.put(chat('c2'));
 await history.remove('c1');
 assert.deepEqual(history.list().map(c=>c.id),['c2']);
 for(let i=0;i<MAX_CHATS+5;i++)await history.put(chat('n'+i,'note '+i));
 assert.equal(history.list().length,MAX_CHATS);
 assert.equal(history.list()[0].id,'n'+(MAX_CHATS+4),'the oldest go first');
 const huge={id:'big',title:'big',lanes:[{modelId:'m',messages:[{id:'u',role:'user',text:'x'.repeat(MAX_BYTES+1),files:[]}]}]};
 assert.equal(await code(history.put(huge)),'too_large');
 assert.equal(history.get('big'),null);
});

test('history never touches the network or the Harness\'s plain storage',async()=>{
 const calls=[];
 const real={fetch:globalThis.fetch,ls:Object.getOwnPropertyDescriptor(globalThis,'localStorage'),ss:Object.getOwnPropertyDescriptor(globalThis,'sessionStorage')};
 const spy=name=>new Proxy({},{get:(_,k)=>(...a)=>{calls.push(name+'.'+String(k));}});
 globalThis.fetch=async(...a)=>{calls.push('fetch');throw new Error('no network')};
 Object.defineProperty(globalThis,'localStorage',{value:spy('localStorage'),configurable:true});
 Object.defineProperty(globalThis,'sessionStorage',{value:spy('sessionStorage'),configurable:true});
 try{
  const {history}=open();
  await history.create(PASS);await history.put(chat('c1'));history.lock();await history.unlock(PASS);await history.remove('c1');await history.forget();
 }finally{
  globalThis.fetch=real.fetch;
  for(const [k,d] of [['localStorage',real.ls],['sessionStorage',real.ss]])d?Object.defineProperty(globalThis,k,d):delete globalThis[k];
 }
 assert.deepEqual(calls,[]);
});

// ---------------------------------------------------------------- what is kept of a conversation

const image={id:'f1',kind:'image',name:'diagram.png',size:10,url:'data:image/png;base64,AAAA'};
const lanes=[{id:'l0',modelId:'m/one',messages:[
 {id:'u1',role:'user',text:'  What is in this picture?  ',attachments:[image]},
 {id:'a1',role:'assistant',model:'m/one',status:'done',text:'A diagram.',provider:'phala',ms:812,usage:{prompt_tokens:12,completion_tokens:5,cost:0.00042,extra:{a:1}},reasoning:'private thoughts',images:['data:image/png;base64,BBBB'],receipt:{id:'gen_9',payload:{disclosure:'attested'},v2:{claims:{lane:'attested',disclosure:'attested'}}}},
 {id:'u2',role:'user',text:'Call the tool',attachments:[]},
 {id:'a2',role:'assistant',model:'m/one',status:'done',text:'',toolCalls:[{id:'t1',name:'get_weather',arguments:'{}'}]},
 {id:'t1',role:'tool',toolCallId:'t1',name:'get_weather',text:'sunny'},
 {id:'u3',role:'user',text:'Again',attachments:[]},
 {id:'a3',role:'assistant',model:'m/one',status:'error',text:'',error:'Rate limited.'},
]}];

test('a snapshot keeps the words and the receipt, and drops attachments, reasoning, tool traffic and failures',()=>{
 const snap=snapshotLanes(lanes);
 const text=JSON.stringify(snap);
 assert.deepEqual(snap[0].messages.map(m=>m.id),['u1','a1','u2','u3']);
 assert.deepEqual(snap[0].messages[0].files,['diagram.png']);
 for(const gone of ['data:image','AAAA','BBBB','private thoughts','get_weather','sunny','Rate limited'])assert.equal(text.includes(gone),false,gone);
 assert.equal(titleOf(lanes),'What is in this picture?');
 assert.equal(titleOf([]),'Untitled');
});

test('a restored conversation renders like the original: same receipt, tokens and cost',()=>{
 const back=restoreLanes(snapshotLanes(lanes));
 assert.equal(back[0].id,'l0');
 assert.equal(back[0].modelId,'m/one');
 const reply=back[0].messages.find(m=>m.id==='a1');
 assert.equal(reply.status,'done');
 assert.deepEqual(replyFacts(reply),{tokensIn:12,tokensOut:5,reasoningTokens:0,cost:0.00042,disclosure:'attested',receiptId:'gen_9',provider:'phala'});
 assert.deepEqual(back[0].messages[0].attachments,[],'nothing is resent from a restored attachment');
 assert.equal(restoreLanes(null)[0].messages.length,0);
 const two=restoreLanes([{modelId:'a',messages:[]},{modelId:'b',messages:[]}],()=>'xyz');
 assert.deepEqual(two.map(l=>l.id),['l0','lxyz']);
});

test('a conversation goes through the vault and back unchanged',async()=>{
 const {history}=open();
 await history.create(PASS);
 await history.put({id:'c1',title:titleOf(lanes),lanes:snapshotLanes(lanes)});
 history.lock();
 await history.unlock(PASS);
 assert.deepEqual(restoreLanes(history.get('c1').lanes),restoreLanes(snapshotLanes(lanes)));
});
