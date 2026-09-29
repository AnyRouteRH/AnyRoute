import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_MODELS,ROUTE_PREFIX,baseModelId,createBody,draftToRoute,emptyDraft,moveItem,paramSummary,parseStop,patchBody,policySummary,routeToDraft,sampleRoutes,slugify,snippet,stopToText} from '../lib/saved-routes.js';

const LLAMA='meta-llama/llama-3.3-70b-instruct',QWEN='qwen/qwen3-32b';
const draft=(patch={})=>({...emptyDraft(),slug:'fast-chat',name:'Fast chat',models:[QWEN,LLAMA],...patch});

test('slugs are suggested from names and kept inside the router pattern',()=>{
 assert.equal(slugify('Support Chat — EU!'),'support-chat-eu');
 assert.equal(slugify('  Crème brûlée  '),'creme-brulee');
 assert.equal(slugify('x'.repeat(60)).length,48);
 assert.equal(slugify('a'.repeat(47)+' b'),'a'.repeat(47));
 assert.equal(slugify('---'),'');
});

test('model order moves one step and ignores out-of-range moves',()=>{
 const list=['a','b','c'];
 assert.deepEqual(moveItem(list,1,-1),['b','a','c']);
 assert.deepEqual(moveItem(list,1,1),['a','c','b']);
 assert.equal(moveItem(list,0,-1),list);assert.equal(moveItem(list,2,1),list);
 assert.deepEqual(list,['a','b','c']);
 assert.equal(baseModelId(LLAMA+':floor:free'),LLAMA);
});

test('a complete draft becomes the router config: empty fields are omitted, not sent as zero',()=>{
 const r=draftToRoute(draft({sort:'price',allowFallbacks:false,zdr:true,maxPrompt:'1',maxCompletion:' 2.5 ',params:{...emptyDraft().params,temperature:'0.2',max_tokens:'512'},stop:'END, \\n\\n'}),{catalogIds:new Set([QWEN,LLAMA])});
 assert.equal(r.ok,true);
 assert.deepEqual(r.config,{models:[QWEN,LLAMA],provider:{sort:'price',allow_fallbacks:false,zdr:true,max_price:{prompt:1,completion:2.5}},params:{temperature:0.2,max_tokens:512,stop:['END','\n\n']}});
 const bare=draftToRoute(draft());
 assert.deepEqual(bare.config,{models:[QWEN,LLAMA]});
 assert.equal(draftToRoute(draft({name:'  '})).name,'fast-chat');
 assert.deepEqual(createBody(bare),{slug:'fast-chat',name:'Fast chat',description:'',config:{models:[QWEN,LLAMA]}});
});

test('invalid drafts name each field and never reach the API',()=>{
 const r=draftToRoute(draft({slug:'Bad Slug',name:'n'.repeat(81),description:'d'.repeat(281),models:[],maxPrompt:'-1',params:{...emptyDraft().params,temperature:'3',max_tokens:'1.5'},stop:'a,b,c,d,e'}));
 assert.equal(r.ok,false);
 for(const k of ['slug','name','description','models','maxPrompt','temperature','max_tokens','stop'])assert.ok(r.errors[k],k);
 assert.match(draftToRoute(draft({models:Array.from({length:MAX_MODELS+1},(_,i)=>'m/'+i)})).errors.models,/at most 8/);
 assert.match(draftToRoute(draft({models:[LLAMA,LLAMA]})).errors.models,/once/);
 assert.match(draftToRoute(draft({models:['@route/other']})).errors.models,/another route/);
 assert.match(draftToRoute(draft({models:[LLAMA,'acme/gone']}),{catalogIds:new Set([LLAMA])}).errors.models,/acme\/gone/);
 assert.equal(draftToRoute(draft({models:[LLAMA+':nitro']}),{catalogIds:new Set([LLAMA])}).ok,true);
});

test('editing round-trips the form fields and carries API-only settings through untouched',()=>{
 const route={slug:'tuned',name:'Tuned',description:'d',config:{models:[QWEN],provider:{sort:'latency',zdr:true,only:['alpha'],max_price:{prompt:1,request:0.01}},params:{temperature:0.3,seed:7,stop:['END'],reasoning:{effort:'low'}}}};
 const d=routeToDraft(route);
 assert.equal(d.sort,'latency');assert.equal(d.zdr,true);assert.equal(d.allowFallbacks,true);assert.equal(d.maxPrompt,'1');assert.equal(d.params.temperature,'0.3');assert.equal(d.stop,'END');
 assert.deepEqual(d.extraProvider,{only:['alpha']});assert.deepEqual(d.extraParams,{seed:7,reasoning:{effort:'low'}});
 const r=draftToRoute(d);
 assert.deepEqual(r.config,route.config);
 assert.deepEqual(patchBody(r,'tuned'),{name:'Tuned',description:'d',config:{models:[QWEN],provider:route.config.provider,params:route.config.params}});
 // Clearing every policy field sends null so the router drops those sections; a new slug renames.
 const cleared=draftToRoute({...routeToDraft({slug:'plain',name:'Plain',config:{models:[QWEN],provider:{zdr:true},params:{top_p:0.5}}}),zdr:false,params:emptyDraft().params,slug:'plain-2'});
 assert.deepEqual(patchBody(cleared,'plain'),{slug:'plain-2',name:'Plain',description:'',config:{models:[QWEN],provider:null,params:null}});
});

test('stop sequences escape newlines both ways; a comma inside one stays an API-only value',()=>{
 assert.deepEqual(parseStop('END, \\n\\n,  ').value,['END','\n\n']);
 assert.equal(parseStop('').value,undefined);
 assert.match(parseStop('x'.repeat(33)).error,/32/);
 assert.equal(stopToText(['END','\n\n','a\\b']),'END, \\n\\n, a\\\\b');
 assert.deepEqual(parseStop(stopToText(['END','\n\n','a\\b'])).value,['END','\n\n','a\\b']);
 const d=routeToDraft({slug:'s',name:'s',config:{models:[QWEN],params:{stop:['a,b']}}});
 assert.equal(d.stop,'');assert.deepEqual(draftToRoute(d).config.params,{stop:['a,b']});
});

test('summaries describe the policy and defaults in short labels',()=>{
 assert.deepEqual(policySummary({models:[QWEN]}),['Balanced provider choice']);
 assert.deepEqual(policySummary({provider:{sort:'price',allow_fallbacks:false,zdr:true,data_collection:'deny',only:['alpha','beta'],max_price:{prompt:1,completion:2}}}),['Cheapest provider first','No provider fallback','Zero data retention','No data collection','Only: alpha, beta','≤ $1.00 in · $2.00 out /1M']);
 assert.deepEqual(paramSummary({params:{temperature:0.2,max_tokens:4096,stop:['a','b'],seed:7}}),['temp 0.2','max 4,096','stop ×2','seed 7']);
 assert.deepEqual(paramSummary({}),[]);
});

test('the snippet calls the route through the OpenAI SDK without embedding a key',()=>{
 for(const lang of ['js','python']){
  const s=snippet('fast-chat','https://router.test/',lang);
  assert.ok(s.includes('"@route/fast-chat"'));assert.ok(s.includes('https://router.test/api/v1'));
  assert.ok(s.includes('ANYROUTE_API_KEY'));assert.doesNotMatch(s,/sk-ar-v1-/);
 }
 assert.match(snippet('fast-chat','',"js"),/from "openai"/);
});

test('sample routes are labelled, valid and hold no prompt text',()=>{
 for(const r of sampleRoutes){
  assert.equal(r.sample,true);assert.match(r.description,/^Sample route/);
  const d=routeToDraft(r);assert.equal(draftToRoute(d).ok,true);assert.deepEqual(draftToRoute(d).config,r.config);
  for(const k of ['messages','system','prompt'])assert.equal(k in (r.config.params||{}),false);
  assert.doesNotMatch(JSON.stringify(r.config),/"(messages|system|content)"/);
 }
 assert.equal(ROUTE_PREFIX,'@route/');
});
