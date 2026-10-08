import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {aboutRequestLabel,buildCommit,inventoryPath,loadInventory,parseInventory,sha256Hex,sourceUrl,tablesByCategory} from '../lib/keep.js';
import {checkpointUrl,logState,proofUrl} from '../lib/keep-log.js';

const WEB=fileURLToPath(new URL('../',import.meta.url));
const FILE=WEB+'app/keep/inventory.generated.json';
const inv=loadInventory(FILE);
const {doc}=inv;
const DIGEST='ab'.repeat(32);

test('the inventory the page is built from loads, and its hash is that of the exact bytes',()=>{
 assert.equal(doc.format,'anyroute.data-inventory/1');
 assert.equal(inv.sha256,sha256Hex(fs.readFileSync(FILE,'utf8')));
 assert.match(inv.sha256,/^[0-9a-f]{64}$/);
 assert.equal(inventoryPath(),FILE);
 assert.throws(()=>parseInventory('{"format":"other"}'),/unknown format/);
 assert.throws(()=>parseInventory(JSON.stringify({format:'anyroute.data-inventory/1',postgres:{tables:[]}})),/no tables/);
 assert.throws(()=>parseInventory(JSON.stringify({format:'anyroute.data-inventory/1',postgres:{tables:[{}]}})),/no summary/);
});

test('the file is canonical JSON: no whitespace between tokens, keys sorted',()=>{
 const canon=(v)=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
 assert.equal(inv.text,JSON.stringify(canon(JSON.parse(inv.text))));
});

test('every table has a category, a purpose, a retention note and described columns',()=>{
 const ids=doc.categories.map(c=>c.id);
 assert.deepEqual(ids,['request','billing','receipts','keys','providers','chain','operations']);
 assert.ok(doc.postgres.tables.length>=50);
 for(const t of doc.postgres.tables){
  assert.ok(ids.includes(t.category),t.name);
  assert.ok(t.purpose.length>8&&t.retention.length>8,t.name);
  assert.ok(t.columns.length>0,t.name);
  for(const c of t.columns){
   assert.ok(c.purpose.length>=4&&c.type,`${t.name}.${c.name}`);
   assert.ok(['yes','aggregate','no'].includes(c.about_request),`${t.name}.${c.name}`);
  }
 }
 const grouped=tablesByCategory(doc);
 assert.equal(grouped.reduce((n,g)=>n+g.tables.length,0),doc.postgres.tables.length);
 assert.deepEqual(grouped.map(g=>g.id),ids);
 assert.equal(doc.summary.counts.tables,doc.postgres.tables.length);
 assert.equal(doc.summary.counts.columns,doc.postgres.tables.reduce((n,t)=>n+t.columns.length,0));
});

test('a column that looks like request content or an address carries a written review that names its flags',()=>{
 let reviewed=0;
 for(const t of doc.postgres.tables)for(const c of t.columns){
  if(c.flags){reviewed++;assert.ok(c.review,`${t.name}.${c.name}`);assert.deepEqual(c.review.covers,c.flags,`${t.name}.${c.name}`);assert.ok(c.review.why.length>40);}
  else assert.equal(c.review,undefined,`${t.name}.${c.name}`);
 }
 assert.equal(reviewed,doc.summary.counts.reviewed_columns);
 assert.ok(reviewed>30);
});

test('the summary claims no prompt or answer text only when no column is reviewed as holding any, and states the exceptions',()=>{
 const holders=doc.postgres.tables.flatMap(t=>t.columns.filter(c=>c.review?.verdict==='holds-request-text').map(c=>`${t.name}.${c.name}`));
 const addresses=doc.postgres.tables.flatMap(t=>t.columns.filter(c=>c.review?.verdict==='network-address'||/^(inet|cidr|macaddr8?)$/.test(c.type)).map(c=>`${t.name}.${c.name}`));
 const claims=/We store no prompt or answer text/.test(doc.summary.headline);
 assert.equal(claims,holders.length===0);
 assert.equal(doc.summary.facts.some(f=>/No table has a column for a network address/.test(f)),addresses.length===0);
 const caveats=JSON.stringify(doc.summary.caveats);
 assert.match(caveats,/response cache/);
 assert.match(caveats,/generations\.attempts/);
 assert.match(caveats,/apps\.url and apps\.title/);
 assert.match(doc.summary.reads,/reads the text of a request in memory/);
 // Everything in the summary that the data does not hold is absent: no claim about logs beyond what the log section states.
 assert.ok(doc.outside_postgres.logs.never_records.length>=3);
 assert.ok(doc.outside_postgres.logs.caveats.length>=2);
});

test('the Redis section lists every family with a lifetime, marks the ones that contain a caller address, and says where answer text can be kept',()=>{
 const fam=doc.outside_postgres.redis.families;
 assert.ok(fam.length>=20);
 for(const f of fam){assert.ok(f.key&&f.purpose&&f.ttl&&f.holds,f.key);assert.ok(f.evidence.length>0,f.key);}
 const address=fam.filter(f=>f.holds==='address');
 assert.ok(address.length>=9);
 for(const f of address)assert.match(f.ttl,/^(61|3,601) seconds/,f.key);
 assert.deepEqual(fam.filter(f=>f.request_text==='answer-text').map(f=>f.key),['idempotency:<sha256>','cache:<sha256>','x402paid:<sha256>']);
 assert.match(JSON.stringify(doc.summary.facts),/between 61 seconds and 3,601 seconds/);
});

test('every place a request body or a caller address is read is listed with what is kept',()=>{
 const {body_readers:bodies,address_readers:addr}=doc.outside_postgres;
 assert.ok(bodies.some(r=>r.file==='src/api/chat.ts'&&r.carries==='prompt-or-answer'));
 assert.ok(addr.some(r=>r.file==='src/api/common.ts'));
 for(const r of [...bodies,...addr]){assert.ok(r.reads&&r.then&&r.kept&&r.file,r.file);assert.ok(r.evidence.length>0,r.file);}
});

test('the commit comes from the build setting, else git, else nowhere, and is marked when the tree has changes',()=>{
 const sha='3edb1be5f599f884c1ccd9ba90215622147d3514';
 assert.deepEqual(buildCommit({ANYROUTE_BUILD_COMMIT:sha.toUpperCase()},()=>{throw new Error('no git')}),{sha,source:'build setting',dirty:false});
 assert.equal(buildCommit({ANYROUTE_BUILD_COMMIT:'not a commit'},()=>sha),null);
 const git=(dirty)=>(args)=>args[0]==='rev-parse'?sha+'\n':dirty;
 assert.deepEqual(buildCommit({},git('')),{sha,source:'git',dirty:false});
 assert.deepEqual(buildCommit({},git(' M web/app/keep/page.jsx\n')),{sha,source:'git',dirty:true});
 assert.equal(buildCommit({},()=>{throw new Error('not a repository')}),null);
 assert.equal(buildCommit({},()=>'garbage'),null);
 assert.equal(sourceUrl('src/privacy/inventory.ts'),'https://github.com/AnyRouteRH/AnyRoute/blob/main/src/privacy/inventory.ts');
 assert.equal(aboutRequestLabel('aggregate'),'Summed from requests');
});

test('the transparency-log panel shows only what the router returns',()=>{
 assert.equal(proofUrl('','x'.repeat(64)),`/api/v1/tlog/proof?kind=data_inventory&sha256=${'x'.repeat(64)}`);
 assert.equal(proofUrl('https://r.example/',DIGEST),`https://r.example/api/v1/tlog/proof?kind=data_inventory&sha256=${DIGEST}`);
 assert.equal(checkpointUrl('https://r.example/'),'https://r.example/tlog/checkpoint');
 const entry={data:{kind:'data_inventory',sha256:DIGEST,index:7,checkpoint:{size:9,witnessed:true,cosigned_by:['w1','w2']}}};
 assert.deepEqual(logState(200,entry,DIGEST),{phase:'logged',index:7,checkpointSize:9,witnessed:true,cosignedBy:['w1','w2'],rekor:null});
 const anchored={data:{...entry.data,checkpoint:{...entry.data.checkpoint,rekor:{size:9,log_index:1234,entry_url:'https://rekor.example/api/v1/log/entries/u',search_url:'https://search.sigstore.dev/?logIndex=1234',verified:{inclusion:true}}}}};
 assert.deepEqual(logState(200,anchored,DIGEST).rekor,{logIndex:1234,entryUrl:'https://rekor.example/api/v1/log/entries/u',searchUrl:'https://search.sigstore.dev/?logIndex=1234',checkpointSize:9});
 // An anchor whose inclusion is not verified, or links that are not https, are not shown as a link.
 const unverified={data:{...entry.data,checkpoint:{size:9,rekor:{size:9,log_index:5,entry_url:'https://x.example/e',verified:{inclusion:false}}}}};
 assert.equal(logState(200,unverified,DIGEST).rekor,null);
 const plain={data:{...entry.data,checkpoint:{size:9,rekor:{size:9,log_index:5,entry_url:'javascript:alert(1)',search_url:'http://insecure.example',verified:{inclusion:true}}}}};
 assert.deepEqual(logState(200,plain,DIGEST).rekor,{logIndex:5,entryUrl:null,searchUrl:null,checkpointSize:9});
 assert.deepEqual(logState(404,{error:{type:'not_logged'}},DIGEST),{phase:'not_logged'});
 assert.deepEqual(logState(404,{error:{type:'not_found'}},DIGEST),{phase:'no_log'});
 assert.equal(logState(500,null,DIGEST).phase,'error');
 assert.equal(logState(200,{data:{...entry.data,sha256:'cd'.repeat(32)}},DIGEST).phase,'error');
 assert.equal(logState(200,{data:{...entry.data,kind:'receipt_key'}},DIGEST).phase,'error');
 assert.equal(logState(200,entry,'short').phase,'error');
});

test('the developer docs explain the inventory, its hash and the log entry',()=>{
 const docs=fs.readFileSync(WEB+'app/docs/page.jsx','utf8');
 assert.match(docs,/<a href="#keep">What we keep<\/a>/);
 assert.match(docs,/<h2 id="keep">/);
 assert.match(docs,/GET \/keep\/inventory\.json/);
 assert.match(docs,/TLOG_DATA_INVENTORY/);
 assert.match(docs,/data_inventory/);
});

test('the page, its route and its panel read the generated inventory and use no wording the site avoids',()=>{
 const page=fs.readFileSync(WEB+'app/keep/page.jsx','utf8');
 const route=fs.readFileSync(WEB+'app/keep/inventory.json/route.js','utf8');
 assert.match(route,/dynamic = "force-static"/);
 assert.match(route,/loadInventory\(\)\.text/);
 assert.match(page,/loadInventory\(\)/);
 assert.match(page,/summary\.headline/);
 assert.match(page,/<KeepLog digest=\{sha256\} \/>/);
 for(const file of ['page.jsx','KeepLog.jsx','KeepFilter.jsx']){
  const src=fs.readFileSync(WEB+'app/keep/'+file,'utf8').replace(/sourceUrl\("[^"]*"\)/g,'').replace(/^\s*\/\/.*$/gm,'');
  assert.doesNotMatch(src,/\b(demo|mock|placeholder|simulated|tested?|tests)\b/i,file);
 }
 assert.doesNotMatch(JSON.stringify([doc.summary,doc.categories]),/\b(demo|mock|placeholder|simulated|tested?)\b/i);
});
