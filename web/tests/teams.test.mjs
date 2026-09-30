import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {
 GENESIS,ROLES,ROLE_INFO,SAMPLE_TEAM_ID,actionLabel,actorLabel,assignableRoles,atLeast,auditPage,canManage,b64urlToBuffer,b64urlToBytes,bytesToB64url,canonicalJson,
 credentialCreateOptions,credentialGetOptions,detailText,dispositionName,encodeAssertion,encodeRegistration,exportCsv,exportJsonl,extractInvite,hourlyRoots,
 inviteRoles,joinLink,keyRoles,merkleRoot,normalizeRole,pageCount,parseBudget,parseExport,passkeyError,roleCan,roleLabel,sampleAuditEntries,sealEntries,
 validateInvite,verifyChain,verifyExport,verifyRoots,
} from '../lib/teams.js';

const spec=JSON.parse(fs.readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
const docs=fs.readFileSync(new URL('../app/docs/page.jsx',import.meta.url),'utf8');
const TEAM='team_0123456789abcdef01234567';

// An independent implementation of the router's chain rule, with node:crypto instead of WebCrypto.
const canon=(v)=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter((k)=>v[k]!==undefined).map((k)=>[k,canon(v[k])])):v;
const link=(prev,e)=>createHash('sha256').update(Buffer.from(prev,'hex')).update(JSON.stringify(canon({team:e.team,seq:e.seq,at:e.at,actor:e.actor,action:e.action,target:e.target,detail:e.detail})),'utf8').digest('hex');
function chain(team,raw){let prev='0'.repeat(64);return raw.map((e)=>{const x={team,...e};const hash=link(prev,x);const out={...x,prev_hash:prev,hash};prev=hash;return out;});}
const RAW=[
 {seq:1,at:'2026-09-30T13:05:00.000Z',actor:'key:0123456789abcdef',action:'team.create',target:'team:'+TEAM,detail:{name:'Lab'}},
 {seq:2,at:'2026-09-30T13:06:10.000Z',actor:'key:0123456789abcdef',action:'invite.create',target:'invite:ab12cd',detail:{role:'dev',method:'passkey',ttl_hours:72}},
 {seq:3,at:'2026-09-30T13:40:00.000Z',actor:'passkey:tp_1a2b3c',action:'member.join',target:'principal:tp_1a2b3c',detail:{kind:'passkey',role:'dev'}},
 {seq:4,at:'2026-09-30T14:02:00.000Z',actor:'wallet:0x00000000000000000000000000000000000000aa',action:'budget.set',target:'team:'+TEAM,detail:{budget_usd:250,note:'a "quoted", comma'}},
 {seq:5,at:'2026-09-30T14:30:00.000Z',actor:'passkey:tp_1a2b3c',action:'key.create',target:'key:fedcba9876543210',detail:{limit_usd:20,role:'agent',models:['a','b']}},
];
// RFC 6962 by the book, for the hourly roots.
const H=(...p)=>{const h=createHash('sha256');for(const x of p)h.update(x);return h.digest();};
function rfc6962(leaves){if(leaves.length===1)return H(Buffer.from([0]),leaves[0]);let k=1;while(k*2<leaves.length)k*=2;return H(Buffer.from([1]),rfc6962(leaves.slice(0,k)),rfc6962(leaves.slice(k)));}

test('base64url round-trips any bytes, matches Node, and refuses what is not base64url',()=>{
 for(let n=0;n<40;n++){
  const bytes=randomBytes(n);
  const s=bytesToB64url(bytes);
  assert.equal(s,bytes.toString('base64url'));
  assert.deepEqual(Buffer.from(b64urlToBytes(s)),bytes);
  const buf=b64urlToBuffer(s);
  assert.ok(buf instanceof ArrayBuffer);assert.equal(buf.byteLength,n);
 }
 const big=new Uint8Array(20);big.set([1,2,3],10);
 assert.equal(bytesToB64url(big.subarray(10,13)),'AQID','a view encodes only its own bytes');
 assert.equal(bytesToB64url(Uint8Array.of(1,2,3).buffer),'AQID');
 assert.deepEqual([...b64urlToBytes('AQID==')],[1,2,3],'trailing padding is tolerated');
 assert.throws(()=>b64urlToBytes('a+b/'),/base64url/);
 assert.throws(()=>b64urlToBytes('abcde'),/base64url/);
});

test('the server options become what navigator.credentials needs, and credentials become the JSON bodies',()=>{
 const create={challenge:'AQID',rp:{id:'router.example',name:'Anyroute'},user:{id:'BAUG',name:'member',displayName:'Member'},pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-8},{type:'public-key',alg:-257}],timeout:60000,attestation:'none',authenticatorSelection:{residentKey:'required',userVerification:'preferred'}};
 const o=credentialCreateOptions(create);
 assert.ok(o.challenge instanceof ArrayBuffer);assert.deepEqual([...new Uint8Array(o.challenge)],[1,2,3]);
 assert.deepEqual([...new Uint8Array(o.user.id)],[4,5,6]);
 assert.equal(o.user.name,'member');assert.deepEqual(o.rp,create.rp);assert.deepEqual(o.pubKeyCredParams,create.pubKeyCredParams);
 assert.equal(o.attestation,'none');assert.deepEqual(o.authenticatorSelection,create.authenticatorSelection);
 assert.equal(create.challenge,'AQID','the input is not changed');
 const ex=credentialCreateOptions({...create,excludeCredentials:[{type:'public-key',id:'BwgJ'}]});
 assert.deepEqual([...new Uint8Array(ex.excludeCredentials[0].id)],[7,8,9]);

 const get=credentialGetOptions({challenge:'CgsM',rpId:'router.example',allowCredentials:[],userVerification:'preferred',timeout:60000});
 assert.deepEqual([...new Uint8Array(get.challenge)],[10,11,12]);
 assert.deepEqual(get.allowCredentials,[],'discoverable passkeys: an empty list stays empty');
 assert.equal(get.rpId,'router.example');
 assert.deepEqual([...new Uint8Array(credentialGetOptions({challenge:'AA',allowCredentials:[{type:'public-key',id:'AQID'}]}).allowCredentials[0].id)],[1,2,3]);

 const ab=(...b)=>Uint8Array.from(b).buffer;
 const reg=encodeRegistration({id:'AQID',rawId:ab(1,2,3),type:'public-key',response:{clientDataJSON:ab(123,125),attestationObject:ab(0xa0)}});
 assert.deepEqual(reg,{id:'AQID',rawId:'AQID',type:'public-key',response:{clientDataJSON:'e30',attestationObject:'oA'}});
 const asr=encodeAssertion({id:'AQID',rawId:ab(1,2,3),type:'public-key',response:{clientDataJSON:ab(123,125),authenticatorData:ab(5),signature:ab(0x30,0x01),userHandle:ab(4,5,6)}});
 assert.deepEqual(asr,{id:'AQID',response:{clientDataJSON:'e30',authenticatorData:'BQ',signature:'MAE',userHandle:'BAUG'}});
 assert.equal(encodeAssertion({rawId:ab(1),response:{clientDataJSON:ab(1),authenticatorData:ab(1),signature:ab(1),userHandle:null}}).response.userHandle,undefined,'no userHandle when the authenticator gives none');
 assert.equal(encodeAssertion({rawId:ab(9),response:{clientDataJSON:ab(1),authenticatorData:ab(1),signature:ab(1)}}).id,'CQ','the id falls back to rawId');
 assert.match(passkeyError({name:'NotAllowedError'}),/closed or timed out/);
 assert.match(passkeyError({name:'InvalidStateError'}),/already holds/);
 assert.equal(passkeyError(new Error('boom')),'boom');
});

test('canonicalJson sorts keys at every depth, keeps array order and drops undefined',()=>{
 assert.equal(canonicalJson({b:1,a:{d:[3,{z:1,y:2}],c:null},u:undefined}),'{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
 assert.equal(canonicalJson([{b:2,a:1},'x']),'[{"a":1,"b":2},"x"]');
 assert.equal(canonicalJson('s'),'"s"');
 assert.equal(canonicalJson({é:1,e:2,Z:3}),'{"Z":3,"e":2,"é":1}','code-unit order, as Object.keys().sort()');
 for(const e of RAW)assert.equal(canonicalJson(e),JSON.stringify(canon(e)));
});

test('verifyChain recomputes a chain made independently and names the first broken entry',async()=>{
 const good=chain(TEAM,RAW);
 const ok=await verifyChain(good,{team:TEAM,head:{seq:5,hash:good[4].hash}});
 assert.deepEqual({ok:ok.ok,checked:ok.checked,head:ok.head,first:ok.first,last:ok.last},{ok:true,checked:5,head:good[4].hash,first:1,last:5});
 assert.equal((await verifyChain(good.map(({team,...e})=>e),{team:TEAM})).ok,true,'the team id can come from the caller');
 assert.equal((await verifyChain([],{})).ok,true);

 const tampered=good.map((e)=>e.seq===3?{...e,detail:{...e.detail,role:'admin'}}:e);
 let r=await verifyChain(tampered,{team:TEAM});
 assert.equal(r.ok,false);assert.equal(r.seq,3);assert.equal(r.reason,'hash');assert.equal(r.checked,2);

 const reordered=[good[0],good[2],good[1],good[3],good[4]];
 r=await verifyChain(reordered,{team:TEAM});
 assert.equal(r.ok,false);assert.equal(r.seq,3);assert.equal(r.reason,'order');

 const relabelled=[good[0],{...good[2],seq:2},{...good[1],seq:3},good[3],good[4]];
 r=await verifyChain(relabelled,{team:TEAM});
 assert.equal(r.ok,false);assert.equal(r.seq,2,'renumbering a moved entry still breaks it');

 r=await verifyChain([good[0],good[1],good[3],good[4]],{team:TEAM});
 assert.equal(r.seq,4);assert.equal(r.reason,'order','a removed entry');
 r=await verifyChain(good.slice(1),{team:TEAM});
 assert.equal(r.seq,2);assert.equal(r.reason,'link','the first entry must follow the genesis');
 assert.equal((await verifyChain(good.slice(1),{team:TEAM,genesis:good[0].hash})).ok,true,'a later start with its own genesis');
 r=await verifyChain(good.map((e)=>e.seq===4?{...e,prev_hash:GENESIS}:e),{team:TEAM});
 assert.equal(r.seq,4);assert.equal(r.reason,'link');
 r=await verifyChain(good.map(({team,...e})=>e),{team:'team_other'});
 assert.equal(r.seq,1);assert.equal(r.reason,'hash','the hash covers the team id');
 r=await verifyChain(good.map((e)=>e.seq===2?{...e,team:'team_other'}:e),{team:TEAM});
 assert.equal(r.seq,2);assert.equal(r.reason,'hash','an entry moved from another organisation does not fit');
 r=await verifyChain(good,{team:TEAM,head:{seq:5,hash:'f'.repeat(64)}});
 assert.equal(r.reason,'head');
 r=await verifyChain(good,{team:TEAM,head:{seq:7,hash:'f'.repeat(64)}});
 assert.equal(r.reason,'missing');assert.equal(r.seq,6);

 const sealed=await sealEntries(TEAM,RAW);
 assert.deepEqual(sealed,good,'sealEntries writes the same chain the router does');
});

test('hourly roots are RFC 6962 trees over the raw entry hashes, and a changed root is caught',async()=>{
 const good=chain(TEAM,RAW);
 for(let n=1;n<=good.length;n++){
  const hs=good.slice(0,n).map((e)=>e.hash);
  assert.equal(await merkleRoot(hs),rfc6962(hs.map((h)=>Buffer.from(h,'hex'))).toString('hex'),`root of ${n}`);
 }
 assert.equal(await merkleRoot([]),createHash('sha256').digest('hex'));
 const roots=await hourlyRoots(good);
 assert.deepEqual(roots.map((r)=>[r.hour,r.first_seq,r.last_seq,r.count]),[['2026-09-30T13:00:00Z',1,3,3],['2026-09-30T14:00:00Z',4,5,2]]);
 assert.deepEqual(await verifyRoots(good,roots),{ok:true,checked:2});
 assert.equal((await verifyRoots(good,[{...roots[1],root:'0'.repeat(64)}])).reason,'root');
 assert.equal((await verifyRoots(good,[{...roots[0],count:2}])).reason,'count');
 assert.equal((await verifyRoots(good.slice(0,4),roots)).reason,'missing');
 assert.equal((await verifyRoots(good,[{...roots[0],last_seq:4,count:4}])).reason,'hour');
});

test('parseExport reads the JSONL and CSV exports, and verifyExport checks them end to end',async()=>{
 const good=chain(TEAM,RAW);
 const jsonl=await exportJsonl(TEAM,good,'2026-09-30T15:00:00Z');
 const lines=jsonl.trim().split('\n').map((l)=>JSON.parse(l));
 assert.deepEqual(Object.keys(lines[0]),['type','format','team','genesis','hash','entries','head','exported_at']);
 assert.equal(lines[0].format,'anyroute.audit.v1');assert.equal(lines[0].head,good[4].hash);assert.equal(lines.at(-1).type,'root');
 const p=parseExport(jsonl);
 assert.equal(p.format,'jsonl');assert.equal(p.header.team,TEAM);assert.equal(p.header.entries,5);
 assert.deepEqual(p.entries,good);assert.equal(p.roots.length,2);assert.equal(p.roots[0].type,undefined);
 assert.deepEqual(await verifyExport(p),{ok:true,team:TEAM,checked:5,head:good[4].hash,roots:2});
 assert.equal(parseExport('﻿'+jsonl.replace(/\n/g,'\r\n')).entries.length,5,'BOM and CRLF are fine');

 const edited=parseExport(jsonl.replace('"budget_usd":250','"budget_usd":2500'));
 const bad=await verifyExport(edited);
 assert.equal(bad.ok,false);assert.equal(bad.seq,4);
 const short=parseExport(jsonl.split('\n').filter((l)=>!l.includes('"seq":5,')).join('\n'));
 assert.equal((await verifyExport(short)).reason,'count');
 const cut=await exportJsonl(TEAM,good.slice(0,4));
 assert.equal((await verifyExport(parseExport(cut))).ok,true,'a shorter log is valid on its own');
 const lying=parseExport(cut.replace(/"head":"[0-9a-f]+"/,`"head":"${good[4].hash}"`));
 assert.equal((await verifyExport(lying)).reason,'head');

 assert.throws(()=>parseExport(jsonl+'{nope\n'),/Line 9 is not JSON/);
 assert.throws(()=>parseExport(jsonl+'{"type":"other"}\n'),/unknown type/);
 assert.throws(()=>parseExport(jsonl.split('\n').slice(1).join('\n')),/no header/);
 assert.throws(()=>parseExport(jsonl.replace('anyroute.audit.v1','other.v9')),/format/);

 const csv=exportCsv(good);
 assert.ok(csv.startsWith('team,seq,at,actor,action,target,detail,prev_hash,hash\r\n'));
 assert.match(csv,/"\{""budget_usd"":250,""note"":""a \\""quoted\\"", comma""\}"/,'RFC 4180 quoting of the canonical detail');
 const c=parseExport(csv);
 assert.equal(c.format,'csv');assert.equal(c.header,null);
 assert.deepEqual(c.entries,good);
 assert.deepEqual(await verifyExport(c),{ok:true,team:TEAM,checked:5,head:good[4].hash,roots:0});
 assert.equal((await verifyExport(parseExport(csv.replace(',key.create,',',key.disable,')))).seq,5);
 assert.throws(()=>parseExport(csv.replace(/\r\n$/,',x\r\n')),/cells/);
 assert.throws(()=>parseExport(csv+'"open'),/quoted/);

 const sample=await sealEntries(SAMPLE_TEAM_ID,sampleAuditEntries);
 assert.equal((await verifyExport(parseExport(await exportJsonl(SAMPLE_TEAM_ID,sample)))).ok,true,'the sample log verifies');
});

test('roles: rank, labels, what each can do and what each may hand out',()=>{
 assert.deepEqual(ROLES,['owner','admin','dev','viewer','agent']);
 for(const r of ROLES){assert.ok(ROLE_INFO[r].label);assert.ok(roleCan(r).length);}
 assert.equal(normalizeRole('member'),'dev','legacy member is dev');
 assert.equal(normalizeRole('root'),null);
 assert.equal(roleLabel('member'),'Developer');assert.equal(roleLabel('dev'),'Developer');
 assert.ok(atLeast('owner','admin'));assert.ok(atLeast('admin','admin'));assert.ok(!atLeast('dev','admin'));
 assert.ok(atLeast('member','dev'));assert.ok(atLeast('viewer','viewer'));
 assert.ok(!atLeast('agent','viewer'),'an agent is below every organisation role');
 assert.ok(!atLeast(undefined,'viewer'));
 assert.deepEqual(assignableRoles('owner'),ROLES);
 assert.deepEqual(assignableRoles('admin'),['dev','viewer','agent'],'an admin never grants its own rank');
 assert.deepEqual(assignableRoles('dev'),[]);
 // The router's rule: the owner changes anything; an admin changes only keys and members below its own role.
 assert.ok(canManage('owner','owner'));assert.ok(canManage('owner','admin'));
 assert.ok(canManage('admin','dev'));assert.ok(canManage('admin','member'));assert.ok(canManage('admin','agent'));
 assert.ok(!canManage('admin','admin'));assert.ok(!canManage('admin','owner'));assert.ok(!canManage('dev','viewer'));
 assert.deepEqual(inviteRoles('owner'),['admin','dev','viewer'],'agents are keys, never invited');
 assert.deepEqual(inviteRoles('admin'),['dev','viewer'],'an admin invites below its own rank');
 assert.deepEqual(inviteRoles('viewer'),[]);
 assert.deepEqual(keyRoles('dev'),['dev','viewer','agent']);assert.deepEqual(keyRoles('admin'),['admin','dev','viewer','agent']);assert.deepEqual(keyRoles('viewer'),[]);
 assert.equal(validateInvite({role:'dev',method:'passkey',ttl:'72'},'admin'),'');
 assert.match(validateInvite({role:'admin',method:'any',ttl:'72'},'admin'),/role/,'an admin cannot invite an admin');
 assert.match(validateInvite({role:'agent',method:'any',ttl:'72'},'owner'),/role/);
 assert.match(validateInvite({role:'dev',method:'email',ttl:'72'},'owner'),/signs in/);
 assert.match(validateInvite({role:'dev',method:'any',ttl:'169'},'owner'),/168/);
 assert.match(validateInvite({role:'dev',method:'any',ttl:'1.5'},'owner'),/168/);
});

test('invites, budgets, paging and audit labels',()=>{
 const code='ar-inv-'+'a1'.repeat(24);
 assert.equal(extractInvite(code),code);
 assert.equal(extractInvite(`https://router.example/dashboard/?join=${code}#teams`),code);
 assert.equal(extractInvite('ar-inv-short'),'');
 assert.equal(joinLink(code,'https://router.example'),`https://router.example/dashboard/?join=${code}#teams`);
 assert.deepEqual(parseBudget(''),{ok:true,value:null});
 assert.deepEqual(parseBudget(' 12.5 '),{ok:true,value:12.5});
 assert.equal(parseBudget('-1').ok,false);assert.equal(parseBudget('abc').ok,false);
 assert.deepEqual(auditPage(120,0,50),{after:70,limit:50});
 assert.deepEqual(auditPage(120,1,50),{after:20,limit:50});
 assert.deepEqual(auditPage(120,2,50),{after:0,limit:20});
 assert.deepEqual(auditPage(0,0,50),{after:0,limit:0});
 assert.equal(pageCount(120,50),3);assert.equal(pageCount(0,50),1);
 assert.equal(actorLabel('key:0123456789abcdef'),'Key 0123456789abcdef');
 assert.equal(actorLabel('passkey:tp_1a2b3c'),'Passkey tp_1a2b3c');
 assert.equal(actorLabel('wallet:0x00000000000000000000000000000000000000aa'),'Wallet 0x0000…00aa');
 assert.equal(actorLabel('system'),'system');
 assert.equal(actionLabel('member.join'),'Member joined');assert.equal(actionLabel('member.restore'),'Member restored');assert.equal(actionLabel('new.thing'),'new.thing');
 assert.equal(detailText({role:'dev',method:'passkey',models:['a','b'],previous:null}),'method: passkey · models: a, b · previous: none · role: dev');
 assert.equal(detailText(null),'');
 assert.equal(dispositionName('attachment; filename="anyroute-audit-team_x.jsonl"'),'anyroute-audit-team_x.jsonl');
 assert.equal(dispositionName("attachment; filename*=UTF-8''anyroute-audit-team_x.csv"),'anyroute-audit-team_x.csv');
 assert.equal(dispositionName(null),'');
});

test('the organisation endpoints are in the OpenAPI document and the docs explain them',()=>{
 const pub=[['/api/v1/teams/join/challenge','post'],['/api/v1/teams/join','post'],['/api/v1/teams/{id}/sign-in/challenge','post'],['/api/v1/teams/{id}/sign-in','post']];
 const keyed=[['/api/v1/teams','post'],['/api/v1/teams','get'],['/api/v1/teams/{id}','get'],['/api/v1/teams/{id}','patch'],['/api/v1/teams/{id}/members/{hash}','put'],['/api/v1/teams/{id}/owner/challenge','post'],['/api/v1/teams/{id}/owner','post'],['/api/v1/teams/{id}/invites','post'],['/api/v1/teams/{id}/principals/{pid}','patch'],['/api/v1/teams/{id}/principals/{pid}','delete'],['/api/v1/teams/{id}/audit','get'],['/api/v1/teams/{id}/audit/roots','get'],['/api/v1/teams/{id}/audit/export','get']];
 assert.ok(spec.tags.some((t)=>t.name==='Teams'));
 for(const [path,method] of [...pub,...keyed]){
  const op=spec.paths[path]?.[method];
  assert.ok(op,`${method.toUpperCase()} ${path}`);
  assert.deepEqual(op.tags,['Teams']);
 }
 for(const [path,method] of pub)assert.equal(spec.paths[path][method].security,undefined,`${path} needs no key`);
 for(const [path,method] of keyed){assert.deepEqual(spec.paths[path][method].security,[{BearerAuth:[]}],`${path} needs a key`);assert.ok(spec.paths[path][method].responses['401']);}
 const exp=spec.paths['/api/v1/teams/{id}/audit/export'].get.responses['200'];
 assert.ok(exp.content['application/x-ndjson']&&exp.content['text/csv'],'the media types the router sends');assert.ok(exp.headers['Content-Disposition']);
 assert.match(spec.paths['/api/v1/teams/{id}/owner'].post.description,/0x1626ba7e/);
 assert.deepEqual(spec.components.schemas.TeamInviteRequest.properties.role.enum,['admin','dev','viewer']);
 assert.deepEqual(spec.components.schemas.TeamAuditEntry.required,['team','seq','at','actor','action','target','detail','prev_hash','hash']);
 assert.ok(spec.components.schemas.TeamAuditEntry.properties.action.enum.includes('member.restore'));
 assert.ok(spec.components.schemas.KeyCreateRequest.properties.role);
 assert.match(spec.info.description,/organisations/);
 assert.match(docs,/<a href="#teams">/);
 assert.match(docs,/id="teams"/);
 assert.match(docs,/node scripts\/verify-audit\.mjs/);
 assert.match(docs,/EIP-1271/);
});
