import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {listDocs,loadDoc,parseReadme,resolveSpecHref,sealStatusJson,specVersion,statusState,REPO_URL} from '../lib/seal-spec.js';
import {liveRows} from '../lib/seal-live.js';

const SPEC=fileURLToPath(new URL('../../spec/',import.meta.url));
const WEB=fileURLToPath(new URL('../',import.meta.url));
const readme=fs.readFileSync(SPEC+'README.md','utf8');

const FIXTURE=`# SEAL

Intro paragraph.

## Lanes

A lane is a floor.

| Lane | Path | Who can run it | Payment |
| :--- | :--- | :--- | :--- |
| \`public\` | TLS | Any provider | Key |

## Guarantees (design targets)

Targets, not claims.

| | Target |
| :--- | :--- |
| G1 | **Attested execution.** Served by an enclave. |

## Parties

| Symbol | Party | Learns | Does not learn |
| :--- | :--- | :--- | :--- |
| U | User | Everything | |

## Honest limits

These hold for the design.

* Trust rests on silicon.
* Timing is out of scope.

## Status of this repository

"Implemented" means code with tests.

| Part | Spec | Status | Where |
| :--- | :--- | :--- | :--- |
| Sidecar | 0001 | Implemented | [\`sidecar/\`](../sidecar) |
| Gateway | 0002 | Implemented, off by default; non-streaming only | [\`src/ohttp/\`](../src/ohttp) |
| Anchoring | 0001, 0004 | Contract function exists; the service is planned | |
| Log | 0001 | Planned | |
`;

test('the spec folder lists the README, the numbered documents in order and the changelog',()=>{
 const docs=listDocs(SPEC);
 assert.equal(docs[0].file,'README.md');assert.equal(docs[0].url,'/spec/');assert.equal(docs[0].shortTitle,'Overview');
 assert.equal(docs.at(-1).file,'CHANGELOG.md');assert.equal(docs.at(-1).url,'/spec/changelog/');
 const numbered=docs.filter(d=>d.number);
 assert.ok(numbered.length>=5);
 assert.deepEqual(numbered.map(d=>d.number),[...numbered.map(d=>d.number)].sort());
 for(const d of numbered){assert.equal(d.url,`/spec/${d.file.replace(/\.md$/,'')}/`);assert.ok(d.title.startsWith(`SEAL ${d.number}:`));assert.ok(d.shortTitle&&!d.shortTitle.startsWith('SEAL'));}
});

test('links between spec documents go to /spec pages, repository paths to GitHub, the rest stays',()=>{
 const docs=listDocs(SPEC);
 assert.deepEqual(resolveSpecHref('0001-attestation.md',docs),{href:'/spec/0001-attestation/',external:false});
 assert.deepEqual(resolveSpecHref('README.md#honest-limits',docs),{href:'/spec/#honest-limits',external:false});
 assert.deepEqual(resolveSpecHref('CHANGELOG.md',docs),{href:'/spec/changelog/',external:false});
 assert.deepEqual(resolveSpecHref('LICENSE',docs),{href:`${REPO_URL}/blob/main/spec/LICENSE`,external:true});
 assert.deepEqual(resolveSpecHref('../src/services/attestor.ts',docs),{href:`${REPO_URL}/blob/main/src/services/attestor.ts`,external:true});
 assert.deepEqual(resolveSpecHref('../deploy/seal/',docs),{href:`${REPO_URL}/blob/main/deploy/seal`,external:true});
 assert.deepEqual(resolveSpecHref('../LICENSE',docs),{href:`${REPO_URL}/blob/main/LICENSE`,external:true});
 assert.deepEqual(resolveSpecHref('#lanes',docs),{href:'#lanes',external:false});
 assert.deepEqual(resolveSpecHref('https://semver.org/',docs),{href:'https://semver.org/',external:true});
 assert.equal(resolveSpecHref('../../outside',docs),null);
});

test('the README parser reads lanes, targets, parties, limits and every status row',()=>{
 const r=parseReadme(FIXTURE);
 assert.deepEqual(r.lanes.map(({md,...x})=>x),[{lane:'public',path:'TLS',who_can_run_it:'Any provider',payment:'Key'}]);
 assert.deepEqual(r.lanesNote,['A lane is a floor.']);
 assert.deepEqual(r.guarantees.map(({md,...x})=>x),[{id:'G1',name:'Attested execution',target:'Served by an enclave.'}]);
 assert.deepEqual(r.parties.map(({md,...x})=>x),[{symbol:'U',party:'User',learns:'Everything',does_not_learn:''}]);
 assert.deepEqual(r.honestLimits.map(l=>l.text),['Trust rests on silicon.','Timing is out of scope.']);
 assert.deepEqual(r.statusNote,['"Implemented" means code with tests.']);
 assert.deepEqual(r.status.map(({md,...x})=>x),[
  {part:'Sidecar',spec:['0001'],status:'Implemented',state:'implemented',off_by_default:false,where:[{text:'sidecar/',path:'../sidecar'}]},
  {part:'Gateway',spec:['0002'],status:'Implemented, off by default; non-streaming only',state:'implemented',off_by_default:true,where:[{text:'src/ohttp/',path:'../src/ohttp'}]},
  {part:'Anchoring',spec:['0001','0004'],status:'Contract function exists; the service is planned',state:'partial',off_by_default:false,where:[]},
  {part:'Log',spec:['0001'],status:'Planned',state:'planned',off_by_default:false,where:[]},
 ]);
 assert.throws(()=>parseReadme('# SEAL\n\n## Lanes\n'),/Status of this repository/);
 assert.equal(statusState('Implemented; `unlinkable` needs switching on'),'implemented');
 assert.equal(statusState('Planned'),'planned');
});

test('every row of the real status table is parsed, with its status exactly as the spec states it',()=>{
 const r=parseReadme(readme);
 const section=readme.split(/^## /m).find(s=>s.startsWith('Status of this repository'));
 const lines=section.split('\n').filter(l=>l.startsWith('|')).slice(2);
 assert.ok(lines.length>=20);
 assert.equal(r.status.length,lines.length);
 const numbers=new Set(listDocs(SPEC).map(d=>d.number).filter(Boolean));
 r.status.forEach((row,i)=>{
  const cells=lines[i].replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
  assert.equal(row.md.status,cells[2]);assert.equal(row.md.part,cells[0]);
  assert.ok(row.part&&row.status,`row ${i}`);
  assert.ok(row.spec.length&&row.spec.every(n=>numbers.has(n)),`row ${i} names spec documents that exist`);
  assert.ok(['implemented','planned','partial'].includes(row.state));
 });
 assert.ok(r.status.some(x=>x.state==='implemented')&&r.status.some(x=>x.state==='planned'));
 assert.equal(r.lanes.length,3);assert.deepEqual(r.lanes.map(l=>l.lane),['public','attested','unlinkable']);
 assert.ok(r.guarantees.length>=8&&r.guarantees.every(g=>/^G\d+$/.test(g.id)&&g.name&&g.target));
 assert.ok(r.parties.length>=5&&r.parties.every(p=>p.symbol&&p.party));
 assert.ok(r.honestLimits.length>=5);
});

test('the changelog gives the latest released version and whether unreleased changes are listed',()=>{
 assert.deepEqual(specVersion('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n\n## [0.2.0] - 2026-10-01\n\n## [0.1.0] - 2026-09-29\n'),{version:'0.2.0',date:'2026-10-01',unreleased:true});
 assert.deepEqual(specVersion('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-29\n'),{version:'0.1.0',date:'2026-09-29',unreleased:false});
 const real=specVersion(fs.readFileSync(SPEC+'CHANGELOG.md','utf8'));
 assert.match(real.version,/^\d+\.\d+\.\d+/);
});

test('status.json carries lanes, targets, parties, limits and status rows as plain data',()=>{
 const j=sealStatusJson(SPEC);
 assert.equal(j.object,'seal.status');assert.equal(j.spec.license,'Apache-2.0');assert.match(j.spec.version,/^\d+\.\d+\.\d+/);
 assert.equal(j.live,'/api/v1/status');
 assert.ok(j.meaning.length&&j.lanes.length===3&&j.guarantees.length&&j.parties.length&&j.honest_limits.length);
 assert.equal(j.status.length,parseReadme(readme).status.length);
 const text=JSON.stringify(j);
 assert.ok(!text.includes('"md"'),'no Markdown source in the JSON');
 assert.ok(!/\*\*|\]\(/.test(text),'no Markdown syntax in the JSON');
 for(const row of j.status){
  assert.ok(row.spec.every(s=>s.url?.startsWith('/spec/')));
  assert.ok(row.where.every(w=>w.url?.startsWith(`${REPO_URL}/blob/main/`)));
 }
 assert.deepEqual(JSON.parse(text),j);
});

test('a document page has its title, summary, anchors and version',()=>{
 const doc=loadDoc('0001-attestation',SPEC);
 assert.equal(doc.number,'0001');assert.ok(doc.title.startsWith('SEAL 0001'));
 assert.ok(doc.description.length>40&&doc.description.length<=221);
 assert.ok(doc.headings.some(h=>h.level===2));assert.match(doc.version.version,/^\d+\.\d+\.\d+/);
 assert.equal(loadDoc('no-such-doc',SPEC),null);
});

const STATUS={lanes:{public:{available:true,models:376,endpoints:396,attested_bonus:1.25},attested:{available:true,models:1,endpoints:23,attested_bonus:1},unlinkable:{available:false,models:0,endpoints:0,attested_bonus:1},weight:'uptime * quality * attested_bonus / price^2'},onion:{address:'wtck5wjpvkqaonegi4cer6rt64dy56evbmroymvfomroagvtxfu2nmqd.onion',url:'http://wtck5wjpvkqaonegi4cer6rt64dy56evbmroymvfomroagvtxfu2nmqd.onion'},receipts:{key_id:'b601dced5883ffdc',rotation_days:7,anchor_interval_ms:3600000},chain:{chain_id:4663,explorer:'https://robinhoodchain.blockscout.com',contracts:{credits:null,receiptAnchor:null,staking:null}}};

test('the live panel shows only what the status reports, and says when something is off',()=>{
 const rows=Object.fromEntries(liveRows(STATUS).map(r=>[r.name,r]));
 assert.equal(rows['Public lane'].value,'Available · 376 models');
 assert.equal(rows['Attested lane'].value,'Available · 1 model');
 assert.equal(rows['Unlinkable lane'].value,'Not switched on here');
 assert.equal(rows['Onion service'].value,STATUS.onion.address);
 assert.equal(rows['Receipt signing key'].value,'b601dced5883ffdc');
 assert.equal(rows['Receipt roots'].value,'Every hour; posting on chain not switched on here');
 assert.equal(rows['Chain contracts'].value,'Not switched on here');
 const anchor='0x'+'ab'.repeat(20);
 const on=Object.fromEntries(liveRows({...STATUS,onion:null,chain:{...STATUS.chain,contracts:{receiptAnchor:anchor,credits:null}}}).map(r=>[r.name,r]));
 assert.equal(on['Onion service'].value,'Not switched on here');
 assert.equal(on['Receipt roots'].value,'Every hour; anchor contract configured');
 assert.deepEqual(on['Chain contracts'].contracts,[{name:'receiptAnchor',address:anchor,href:`https://robinhoodchain.blockscout.com/address/${anchor}`}]);
 // An older router without these fields: nothing is guessed.
 const bare=liveRows({});
 assert.equal(bare.length,7);
 assert.ok(bare.every(r=>r.value==='Not reported'&&r.state==='unknown'));
 assert.equal(liveRows(null).length,7);
 assert.equal(liveRows({lanes:{public:{available:true}}})[0].value,'Available');
});

test('the SEAL pages avoid wording that does not describe something real',()=>{
 const files=['app/seal/page.jsx','app/seal/SealLive.jsx','app/spec/SpecDoc.jsx','app/spec/page.jsx','app/spec/[doc]/page.jsx','lib/seal-live.js'];
 for(const f of files){
  const src=fs.readFileSync(WEB+f,'utf8');
  assert.ok(!/\b(demo|mock|mocked|simulated|placeholder|local build)\b/i.test(src),`${f} uses a word public copy avoids`);
 }
 // The status the page shows comes from the spec, never from the page's own text (the words are only defined there).
 const page=fs.readFileSync(WEB+'app/seal/page.jsx','utf8');
 assert.ok(!/(?<!<strong)>\s*(Implemented|Planned)\s*</.test(page));
});
