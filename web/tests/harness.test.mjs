import test from 'node:test';
import assert from 'node:assert/strict';
import {CAPS,applyChunk,blankReply,buildRequest,capCounts,catalogueCounts,defaultSettings,evalArithmetic,filterCatalog,formatContext,formatPrice,groupByMaker,ignoredSettings,makerOf,matchScore,normalizeModel,parseTools,pcm16ToWav,replyFacts,routeAsModel,sampleToolResult,supportFor,toWire,TOOL_PRESETS} from '../lib/harness.js';
import {parseBlocks,parseInline,safeHref} from '../lib/markdown.js';

const raw=(id,o={})=>({id,name:o.name||id,context_length:o.ctx??128000,architecture:{input_modalities:o.in||['text'],output_modalities:o.out||['text']},pricing:{prompt:String(o.p??0.000001),completion:String(o.c??0.000002)},supported_parameters:o.params||['max_tokens','temperature','stream'],disclosure:o.disclosure?{best:o.disclosure}:undefined,top_provider:{max_completion_tokens:o.maxOut??null}});
const mini0=()=>buildRequest({model:byId('openai/gpt-4o-mini'),settings:{...defaultSettings(),tools:true,toolChoice:'required'},messages:[]}).body;
const catalogue=[
 raw('anthropic/claude-sonnet-5',{name:'Claude Sonnet 5',in:['text','image','file'],params:['max_tokens','temperature','top_p','tools','tool_choice','reasoning','include_reasoning','response_format','structured_outputs','stop'],p:0.000003,c:0.000015,ctx:1000000}),
 raw('openai/gpt-4o-mini',{name:'GPT-4o-mini',in:['text','image'],params:['max_tokens','temperature','tools','response_format','web_search_options','seed'],p:0.00000015,c:0.0000006}),
 raw('qwen/qwen2.5-0.5b-instruct',{name:'Qwen2.5 0.5B Instruct',disclosure:'attested',ctx:4096,p:0.00000002,c:0.00000004}),
 raw('google/gemini-3-pro-image',{name:'Gemini 3 Pro Image',in:['text','image'],out:['image','text']}),
 raw('openai/gpt-audio',{name:'GPT Audio',out:['text','audio'],params:['max_tokens','temperature','reasoning_effort','reasoning','verbosity']}),
 raw('claude-opus-5.5',{name:'Claude Opus 5.5',params:['max_tokens','tools']}),
].map(normalizeModel);
const byId=id=>catalogue.find(m=>m.id===id);

test('capabilities come straight from the catalogue: modalities, declared parameters and disclosure',()=>{
 const sonnet=byId('anthropic/claude-sonnet-5');
 assert.deepEqual([...sonnet.caps].sort(),['files','json','reasoning','tools','vision']);
 assert.deepEqual([...byId('qwen/qwen2.5-0.5b-instruct').caps],['attested']);
 assert.ok(byId('google/gemini-3-pro-image').caps.has('imageOut'));
 assert.ok(byId('openai/gpt-audio').caps.has('audioOut')&&byId('openai/gpt-audio').caps.has('reasoning'));
 assert.ok(byId('openai/gpt-4o-mini').caps.has('web'));
 assert.equal(CAPS.length,10);
 assert.equal(sonnet.inPrice,3);assert.equal(sonnet.outPrice,15);assert.equal(sonnet.makerLabel,'Anthropic');
});

test('makers fold variants and read ids without a slash',()=>{
 assert.equal(makerOf('~openai/gpt-6'),'openai');assert.equal(makerOf('meta/llama-4'),'meta-llama');
 assert.equal(makerOf('claude-opus-5.5'),'anthropic');assert.equal(makerOf('gpt-6-sol'),'openai');assert.equal(makerOf('glm-5.2-fast'),'z-ai');
 assert.equal(makerOf('@route/fast-cheap'),'@route');
 assert.equal(byId('claude-opus-5.5').makerLabel,'Anthropic');
});

test('the capability filter keeps only models with every chosen chip, and counts follow the other filters',()=>{
 assert.deepEqual(filterCatalog(catalogue,{caps:['vision','tools']}).map(m=>m.id).sort(),['anthropic/claude-sonnet-5','openai/gpt-4o-mini']);
 assert.deepEqual(filterCatalog(catalogue,{caps:['vision','tools','reasoning']}).map(m=>m.id),['anthropic/claude-sonnet-5']);
 assert.deepEqual(filterCatalog(catalogue,{caps:['attested']}).map(m=>m.id),['qwen/qwen2.5-0.5b-instruct']);
 assert.equal(filterCatalog(catalogue,{caps:['audioOut','vision']}).length,0);
 const counts=capCounts(catalogue,{caps:['vision']});
 assert.equal(counts.vision,3);assert.equal(counts.tools,2);assert.equal(counts.attested,0);
 assert.deepEqual(catalogueCounts(catalogue),{models:6,makers:4,tools:3,vision:3});
});

test('search is fuzzy on name, id and maker, and relevance leads the sort',()=>{
 assert.deepEqual(filterCatalog(catalogue,{query:'gpt4o'}).map(m=>m.id),['openai/gpt-4o-mini']);
 assert.equal(filterCatalog(catalogue,{query:'anthropic'}).length,2);
 assert.equal(filterCatalog(catalogue,{query:'claude opus'})[0].id,'claude-opus-5.5');
 assert.equal(matchScore(byId('openai/gpt-4o-mini'),'zzz'),null);
 assert.equal(filterCatalog(catalogue,{query:'  '}).length,6);
});

test('sorts: popular makers first, cheapest by blended price, context largest first; groups follow the sort',()=>{
 assert.equal(filterCatalog(catalogue,{sort:'cheapest'})[0].id,'qwen/qwen2.5-0.5b-instruct');
 assert.equal(filterCatalog(catalogue,{sort:'context'})[0].id,'anthropic/claude-sonnet-5');
 const popular=filterCatalog(catalogue,{sort:'popular'});
 assert.equal(popular[0].maker,'anthropic');
 assert.deepEqual(groupByMaker(popular).map(g=>g.label),['Anthropic','OpenAI','Google','Qwen']);
});

test('prices and context read compactly',()=>{
 assert.equal(formatPrice(0),'free');assert.equal(formatPrice(3),'$3');assert.equal(formatPrice(0.15),'$0.15');assert.equal(formatPrice(0.002),'$0.002');assert.equal(formatPrice(150),'$150');
 assert.equal(formatContext(128000),'125K');assert.equal(formatContext(1000000),'1M');assert.equal(formatContext(1048576),'1M');assert.equal(formatContext(2500000),'2.5M');
});

test('parameter gating: a setting the model does not declare is never sent',()=>{
 const everything={...defaultSettings(),reasoning:true,effort:'high',web:true,format:'json',tools:true,toolChoice:'required',imageOut:true,audioOut:false,temperature:0.3,topP:0.9,maxTokens:500,seed:7,stop:'END, STOP',verbosity:'low'};
 const qwen=buildRequest({model:byId('qwen/qwen2.5-0.5b-instruct'),settings:everything,messages:[{role:'user',text:'hi'}]}).body;
 assert.deepEqual(Object.keys(qwen).sort(),['max_tokens','messages','model','temperature']);
 const sonnet=buildRequest({model:byId('anthropic/claude-sonnet-5'),settings:everything,system:'Be brief.',messages:[{role:'user',text:'hi'}]}).body;
 assert.deepEqual(sonnet.reasoning,{effort:'high'});assert.equal(sonnet.include_reasoning,true);
 assert.deepEqual(sonnet.response_format,{type:'json_object'});
 assert.equal(sonnet.tools[0].function.name,'get_weather');assert.equal(sonnet.tool_choice,'required');assert.equal(mini0().tool_choice,undefined);
 assert.deepEqual(sonnet.stop,['END','STOP']);assert.equal(sonnet.top_p,0.9);assert.equal(sonnet.seed,undefined);assert.equal(sonnet.web_search_options,undefined);assert.equal(sonnet.verbosity,undefined);
 assert.deepEqual(sonnet.messages[0],{role:'system',content:'Be brief.'});
 const mini=buildRequest({model:byId('openai/gpt-4o-mini'),settings:everything,messages:[]}).body;
 assert.deepEqual(mini.web_search_options,{search_context_size:'medium'});assert.equal(mini.seed,7);assert.equal(mini.reasoning,undefined);
 const audio=buildRequest({model:byId('openai/gpt-audio'),settings:{...everything,imageOut:false,audioOut:true},messages:[]}).body;
 assert.deepEqual(audio.modalities,['text','audio']);assert.equal(audio.audio.format,'pcm16');assert.equal(audio.verbosity,'low');assert.deepEqual(audio.reasoning,{effort:'high'});
 assert.deepEqual(buildRequest({model:byId('google/gemini-3-pro-image'),settings:everything,messages:[]}).body.modalities,['image','text']);
 assert.deepEqual(ignoredSettings(byId('qwen/qwen2.5-0.5b-instruct'),everything),['reasoning','web search','JSON mode','function tools','image output','top_p','seed','stop','verbosity']);
});

test('defaults send nothing optional, and reasoning off is explicit only when chosen',()=>{
 const body=buildRequest({model:byId('anthropic/claude-sonnet-5'),messages:[{role:'user',text:'hi'}]}).body;
 assert.deepEqual(Object.keys(body).sort(),['messages','model']);
 assert.deepEqual(buildRequest({model:byId('anthropic/claude-sonnet-5'),settings:{...defaultSettings(),reasoning:false},messages:[]}).body.reasoning,{enabled:false});
 assert.match(buildRequest({model:byId('anthropic/claude-sonnet-5'),settings:{...defaultSettings(),tools:true,toolsText:'{nope'},messages:[]}).error,/not valid JSON/);
 assert.match(buildRequest({model:byId('anthropic/claude-sonnet-5'),settings:{...defaultSettings(),format:'schema',schema:'[1'},messages:[]}).error,/schema/);
 const schema=buildRequest({model:byId('anthropic/claude-sonnet-5'),settings:{...defaultSettings(),format:'schema'},messages:[]}).body.response_format;
 assert.equal(schema.type,'json_schema');assert.equal(schema.json_schema.name,'answer');assert.equal(schema.json_schema.strict,true);
 assert.equal(buildRequest({model:byId('openai/gpt-4o-mini'),settings:{...defaultSettings(),format:'schema'},messages:[]}).body.response_format,undefined);
});

test('attachments go out in the OpenAI format only to models that read them',()=>{
 const msg={role:'user',text:'What is this?',attachments:[{kind:'image',url:'data:image/png;base64,AAAA',name:'a.png'},{kind:'file',url:'data:application/pdf;base64,BBBB',name:'b.pdf'}]};
 assert.deepEqual(toWire(msg,byId('anthropic/claude-sonnet-5')).content,[{type:'text',text:'What is this?'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}},{type:'file',file:{filename:'b.pdf',file_data:'data:application/pdf;base64,BBBB'}}]);
 const mini=buildRequest({model:byId('openai/gpt-4o-mini'),messages:[msg]});
 assert.equal(mini.body.messages[0].content.length,2);assert.match(mini.notes[0],/1 file left out/);
 const qwen=buildRequest({model:byId('qwen/qwen2.5-0.5b-instruct'),messages:[msg]});
 assert.equal(qwen.body.messages[0].content,'What is this?');assert.equal(qwen.notes.length,2);
 assert.equal(supportFor(byId('qwen/qwen2.5-0.5b-instruct')).images,false);
});

test('the manual tool loop round-trips: assistant tool calls, then tool results',()=>{
 const history=[{role:'user',text:'Weather in Lisbon?'},{role:'assistant',text:'',toolCalls:[{id:'call_1',name:'get_weather',arguments:'{"city":"Lisbon"}'}]},{role:'tool',toolCallId:'call_1',text:'{"temperature":21}'},{role:'assistant',text:'',status:'error'}];
 const {body}=buildRequest({model:byId('anthropic/claude-sonnet-5'),messages:history});
 assert.equal(body.messages.length,3);
 assert.deepEqual(body.messages[1],{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'get_weather',arguments:'{"city":"Lisbon"}'}}]});
 assert.deepEqual(body.messages[2],{role:'tool',tool_call_id:'call_1',content:'{"temperature":21}'});
 assert.equal(parseTools(JSON.stringify(TOOL_PRESETS.calculator)).tools.length,1);
 assert.match(parseTools('[{"function":{"name":"bad name"}}]').error,/function name/);
 assert.equal(evalArithmetic('(12.5 * 4) / 3').toFixed(4),'16.6667');assert.equal(evalArithmetic('2^3^2'),512);assert.equal(evalArithmetic('-(2+3)*2'),-10);
 for(const bad of ['alert(1)','2+','','1/0'])assert.equal(evalArithmetic(bad),null);
 assert.equal(sampleToolResult({name:'calculator',arguments:'{"expression":"6*7"}'}),'{"result":42}');
 assert.match(sampleToolResult({name:'get_weather',arguments:'{"city":"Porto"}'}),/Porto/);
});

test('the stream accumulator folds content, reasoning, tool call deltas, images, audio and the receipt',()=>{
 let r=blankReply();
 for(const ev of [
  {provider:'North Compute',choices:[{delta:{reasoning:'Think '}}]},{choices:[{delta:{reasoning:'hard.'}}]},
  {choices:[{delta:{content:'Hel'}}]},{choices:[{delta:{content:'lo'}}]},
  {choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'calc',arguments:'{"expr'}}]}}]},
  {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'ession":"1+1"}'}}]}}]},
  {choices:[{delta:{images:[{type:'image_url',image_url:{url:'data:image/png;base64,AA'}},{image_url:{url:'javascript:alert(1)'}}]}}]},
  {choices:[{delta:{audio:{data:'AAA',transcript:'Hi '}}}]},{choices:[{delta:{audio:{data:'BBB',transcript:'there'}},finish_reason:'tool_calls'}]},
  {choices:[],usage:{prompt_tokens:12,completion_tokens:30,cost:0.00042,completion_tokens_details:{reasoning_tokens:9}},receipt:{id:'gen-1',payload:{disclosure:'attested'}}},
 ])r=applyChunk(r,ev);
 assert.equal(r.text,'Hello');assert.equal(r.reasoning,'Think hard.');
 assert.deepEqual(r.toolCalls,[{id:'c1',name:'calc',arguments:'{"expression":"1+1"}'}]);
 assert.deepEqual(r.images,['data:image/png;base64,AA']);
 assert.deepEqual(r.audio,{data:'AAABBB',transcript:'Hi there',format:'pcm16'});
 assert.equal(r.finish,'tool_calls');assert.equal('model' in blankReply(),false);
 assert.deepEqual(replyFacts(r),{tokensIn:12,tokensOut:30,reasoningTokens:9,cost:0.00042,disclosure:'attested',receiptId:'gen-1',provider:'North Compute'});
});

test('streamed pcm16 audio becomes a playable WAV',()=>{
 const wav=pcm16ToWav(Buffer.from([1,0,2,0]).toString('base64'));
 assert.equal(wav.length,48);assert.equal(Buffer.from(wav.slice(0,4)).toString(),'RIFF');assert.equal(Buffer.from(wav.slice(8,12)).toString(),'WAVE');
 assert.equal(new DataView(wav.buffer).getUint32(24,true),24000);assert.equal(new DataView(wav.buffer).getUint32(40,true),4);
});

test('saved routes only claim what every one of their models supports',()=>{
 const map=new Map(catalogue.map(m=>[m.id,m]));
 const route=routeAsModel({slug:'fast-cheap',name:'Fast and cheap',config:{models:['anthropic/claude-sonnet-5','openai/gpt-4o-mini:nitro']}},map);
 assert.equal(route.id,'@route/fast-cheap');assert.equal(route.makerLabel,'Your routes');
 assert.ok(route.caps.has('vision')&&route.caps.has('tools')&&route.caps.has('json'));
 assert.ok(!route.caps.has('reasoning')&&!route.caps.has('files')&&!route.caps.has('web'));
 assert.equal(route.inPrice,3);
 assert.deepEqual(Object.keys(buildRequest({model:route,settings:{...defaultSettings(),seed:3,reasoning:true},messages:[]}).body).sort(),['messages','model']);
});

test('markdown: blocks, safe links, streaming code fences and nested spans terminate',()=>{
 const b=parseBlocks('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n```ts\nconst x = 1;');
 assert.deepEqual(b.map(x=>x.type),['heading','p','list','list','table','quote','code']);
 assert.equal(b[6].closed,false);assert.equal(b[6].lang,'ts');assert.equal(b[4].rows[0][1],'2');assert.equal(b[3].ordered,true);
 const spans=parseInline('A **signed *nested* key** and [docs](https://example.com) but not [x](javascript:alert(1)) or _this_ snake_case_name.');
 assert.deepEqual(spans.slice(0,4).map(s=>s.type),['text','strong','text','link']);
 assert.equal(spans[1].children[1].type,'em');assert.equal(spans[3].href,'https://example.com');
 assert.ok(!spans.some(s=>s.type==='link'&&/javascript/.test(s.href)));
 assert.ok(spans.some(s=>s.type==='em'&&s.children[0].text==='this'));assert.ok(spans.at(-1).text.includes('snake_case_name'));
 assert.equal(safeHref('javascript:alert(1)'),null);assert.equal(safeHref('https://a.b'),'https://a.b');
 const long='**a** '.repeat(200);assert.equal(parseInline(long).filter(s=>s.type==='strong').length,200);
});
