import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {CHARACTER_PREFIX,ID_RE,cardFromPng,cardSummary,characterModel,characterSummary,chatPreviewBody,clientSnippet,exportPath,greetingsOf,isPng,normalizeCard,parseCardFile,readPngText,sampleCharacters,sillyTavernSnippet} from '../lib/characters.js';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');

// A minimal valid PNG (1x1 RGBA) with tEXt chunks, CRC32 and all, written here so the reader is tested against real bytes.
const CRC=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=(buf)=>{let c=0xffffffff;for(const b of buf)c=CRC[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'latin1'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);};
const png=(texts)=>{
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
 return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),...texts.map(([k,v])=>chunk('tEXt',Buffer.concat([Buffer.from(k,'latin1'),Buffer.from([0]),Buffer.isBuffer(v)?v:Buffer.from(v,'latin1')]))),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]));
};
const b64=(obj)=>Buffer.from(JSON.stringify(obj),'utf8').toString('base64');
const V2={spec:'chara_card_v2',spec_version:'2.0',data:{name:'Zoë Café ☕',description:'Déjà vu, 日本語 and 🚀',first_mes:'Bonjour, {{user}}!',alternate_greetings:['Salut.','Ça va?'],tags:['français','sci-fi'],creator:'someone',character_book:{entries:[{keys:['café'],content:'x'}]},extensions:{depth_prompt:{depth:4}}}};
const V3={spec:'chara_card_v3',spec_version:'3.0',data:{...V2.data,name:'Mira V3',nickname:'Mira',assets:[{type:'icon',uri:'ccdefault:',name:'main',ext:'png'}]}};

test('a PNG card round trips: tEXt chunks with CRC32, base64 of UTF-8 JSON, ccv3 before chara',()=>{
 const bytes=png([['Software','test'],['chara',b64(V2)]]);
 assert.ok(isPng(bytes));
 const texts=readPngText(bytes);
 assert.deepEqual(Object.keys(texts),['Software','chara']);
 const {card,chunk:name}=cardFromPng(bytes);
 assert.equal(name,'chara');
 assert.equal(card.data.name,'Zoë Café ☕','UTF-8 survives the Latin-1 chunk');
 assert.equal(card.data.description,'Déjà vu, 日本語 and 🚀');
 assert.equal(card.spec,'chara_card_v2');
 const both=parseCardFile(png([['chara',b64(V2)],['ccv3',b64(V3)]]));
 assert.equal(both.source,'png');assert.equal(both.chunk,'ccv3');assert.equal(both.card.data.name,'Mira V3');assert.equal(both.card.spec_version,'3.0');
 const raw=parseCardFile(png([['chara',Buffer.from(JSON.stringify(V2),'utf8')]]));
 assert.equal(raw.card.data.name,'Zoë Café ☕','raw UTF-8 JSON in the chunk is read too');
 const url=parseCardFile(png([['chara',b64(V2).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')]]));
 assert.equal(url.card.data.description,V2.data.description,'URL-safe, unpadded base64');
 assert.throws(()=>cardFromPng(png([['Software','x']])),/no ccv3 or chara/);
 assert.throws(()=>parseCardFile(png([['chara','bm90IGpzb24=']])),/not a readable card/);
 assert.throws(()=>readPngText(new Uint8Array([1,2,3])),/Not a PNG/);
 assert.throws(()=>readPngText(bytes.slice(0,50)),/cut short/);
});

test('V1, V2 and V3 cards normalize to { spec, spec_version, data }',()=>{
 const v1=normalizeCard({name:'Old Timer',description:'d',personality:'p',scenario:'s',first_mes:'Hi',mes_example:'<START>',avatar:'none',chat:'x',create_date:'2023'});
 assert.equal(v1.spec,'chara_card_v2');assert.equal(v1.spec_version,'2.0');
 assert.equal(v1.data.first_mes,'Hi');assert.deepEqual(v1.data.alternate_greetings,[]);assert.deepEqual(v1.data.tags,[]);assert.deepEqual(v1.data.extensions,{});
 assert.equal(v1.data.avatar,undefined,'tool fields of a V1 card are dropped');assert.equal(v1.data.system_prompt,'');
 const legacy=normalizeCard({char_name:'Pyg',char_persona:'kind',world_scenario:'a room',char_greeting:'Hello',example_dialogue:'...'});
 assert.deepEqual([legacy.data.name,legacy.data.personality,legacy.data.scenario,legacy.data.first_mes,legacy.data.mes_example],['Pyg','kind','a room','Hello','...']);
 assert.equal(legacy.data.char_name,undefined);
 const v2=normalizeCard(V2);
 assert.deepEqual(v2.data.tags,['français','sci-fi']);assert.equal(v2.data.character_book.entries.length,1);assert.deepEqual(v2.data.extensions,{depth_prompt:{depth:4}});
 const v3=normalizeCard(V3);
 assert.equal(v3.spec,'chara_card_v3');assert.equal(v3.data.nickname,'Mira','V3 fields are kept');assert.equal(v3.data.assets.length,1);
 assert.deepEqual(normalizeCard({spec:'chara_card_v2',data:{name:'T',tags:[' a ','a','',3]}}).data.tags,['a']);
 assert.equal(normalizeCard({spec:'chara_card_v2',data:{name:'T'}}).data.character_book,undefined);
 assert.throws(()=>normalizeCard([]),/JSON object/);
 assert.throws(()=>normalizeCard({spec:'chara_card_v9',data:{name:'x'}}),/Unknown card spec/);
 assert.throws(()=>normalizeCard({spec:'chara_card_v2'}),/in data/);
 assert.throws(()=>normalizeCard({spec:'chara_card_v2',data:{name:'  '}}),/no name/);
 assert.throws(()=>normalizeCard({hello:1}),/not a character card/);
 assert.equal(parseCardFile(new TextEncoder().encode(JSON.stringify(V3))).source,'json');
 assert.throws(()=>parseCardFile(new TextEncoder().encode('{nope')),/neither JSON nor a PNG/);
 assert.throws(()=>parseCardFile(new Uint8Array(0)),/empty/);
});

test('summaries count greetings in the router order and name what a row holds',()=>{
 const card=normalizeCard(V2);
 assert.deepEqual(greetingsOf(card),['Bonjour, {{user}}!','Salut.','Ça va?']);
 assert.deepEqual(cardSummary(card),{name:'Zoë Café ☕',tags:['français','sci-fi'],spec:'Card V2',greetings:3,lorebook:1,creator:'someone'});
 const [mira,quill,sealed]=sampleCharacters;
 assert.deepEqual(characterSummary(mira),['Card V3','3 greetings','lorebook · 2 entries','hash 7c1e9a3f5b0d']);
 assert.deepEqual(characterSummary(quill),['Card V2','1 greeting','hash 2b4d6f8a0c1e']);
 assert.deepEqual(characterSummary(sealed),['Sealed card','encrypted on your device','hash e3c5a7f9b1d2']);
 for(const c of sampleCharacters){
  assert.ok(c.sample&&ID_RE.test(c.id)&&c.model===characterModel(c.id)&&c.model.startsWith(CHARACTER_PREFIX));
  assert.match(c.card_hash,/^[0-9a-f]{64}$/);
  assert.equal(!!c.card,c.visibility!=='private','only public and unlisted cards carry the card');
  if(c.visibility==='private')assert.equal(c.name,null);
 }
 assert.equal(exportPath(mira.id,'png',mira.spec),`/api/v1/characters/${mira.id}/export?format=png&spec=v3`);
 assert.equal(exportPath(quill.id,'json',quill.spec),`/api/v1/characters/${quill.id}/export?format=json&spec=v2`);
});

test('the chat preview body is one user turn, not streamed, with the greeting index only when it is not the first',()=>{
 assert.deepEqual(chatPreviewBody({message:'  Hello there  '}),{messages:[{role:'user',content:'Hello there'}],stream:false,max_tokens:300});
 assert.deepEqual(chatPreviewBody({message:'Hi',model:'qwen/qwen3-32b',greeting:2,userName:' Sam '}),{messages:[{role:'user',content:'Hi'}],stream:false,max_tokens:300,model:'qwen/qwen3-32b',greeting:2,user_name:'Sam'});
 assert.equal(chatPreviewBody({message:'Hi',greeting:0}).greeting,undefined);
 assert.throws(()=>chatPreviewBody({message:'   '}),/Write a message/);
});

test('SillyTavern connects with Chat Completion, the custom OpenAI-compatible source and @character/<id>',()=>{
 const st=sillyTavernSnippet('ch_3f9a1c7e5b2d8f0a4c6e1b3d','https://r.example/');
 assert.match(st,/Chat Completion Source:\s+Custom \(OpenAI-compatible\)/);
 assert.match(st,/https:\/\/r\.example\/api\/v1\n/);
 assert.match(st,/Model ID:\s+@character\/ch_3f9a1c7e5b2d8f0a4c6e1b3d/);
 assert.match(clientSnippet('ch_x','','qwen/qwen3-32b'),/model: "@character\/ch_x",\n  models: \["qwen\/qwen3-32b"\],/);
 assert.doesNotMatch(clientSnippet('ch_x',''),/models:/);
});

test('the API documents every character and memory endpoint, and the docs explain them',()=>{
 const ops=[['/api/v1/characters',['get','post']],['/api/v1/characters/{id}',['get','put','delete']],['/api/v1/characters/{id}/export',['get']],['/api/v1/characters/{id}/greetings',['get']],['/api/v1/characters/{id}/usage',['get']],['/api/v1/characters/{id}/chat',['post']],['/api/v1/characters/group/next',['post']]];
 for(const [path,methods] of ops)for(const m of methods)assert.deepEqual(spec.paths[path]?.[m]?.tags,['Characters'],`${m.toUpperCase()} ${path}`);
 const mem=[['/api/v1/memory',['get','post','delete']],['/api/v1/memory/{id}',['get','put','delete']],['/api/v1/memory/search',['post']]];
 for(const [path,methods] of mem)for(const m of methods){const op=spec.paths[path]?.[m];assert.deepEqual(op?.tags,['Memory'],`${m.toUpperCase()} ${path}`);assert.deepEqual(op.security,[{BearerAuth:[]}]);assert.ok(op.responses['401']);}
 for(const name of ['Characters','Memory'])assert.ok(spec.tags.some((t)=>t.name===name),name);
 const s=spec.components.schemas;
 assert.deepEqual(s.Character.properties.visibility.enum,['public','unlisted','private']);
 assert.equal(s.Character.properties.id.pattern,ID_RE.source);
 assert.equal(s.CharacterInput.properties.visibility.default,'unlisted');
 assert.deepEqual(s.MemoryInput.properties.kind.enum,['summary','fact','lorebook','state']);
 assert.equal(s.MemoryInput.properties.embedding_opt_in.const,true);
 const chat=spec.paths['/api/v1/characters/{id}/chat'].post;
 for(const h of ['X-Anyroute-Character','X-Anyroute-Character-Lane','X-Anyroute-Character-Note'])assert.ok(chat.responses['200'].headers[h],h);
 assert.ok(chat.responses['200'].content['text/event-stream']);
 assert.match(spec.components.schemas.ChatRequest.properties.model.description,/@character\/<id>/);
 assert.match(docs,/id="characters"/);assert.match(docs,/<a href="#characters">/);
 assert.match(docs,/Custom \(OpenAI-compatible\)/);
 assert.match(docs,/embedding_opt_in/);
});

test('no em dashes in the user-facing character text',()=>{
 for(const file of ['../components/features/Characters.jsx','../lib/characters.js'])
  assert.ok(!fs.readFileSync(new URL(file,import.meta.url),'utf8').includes('\u2014'),file);
});
