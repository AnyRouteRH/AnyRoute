import {TASKS} from '../lib/site-map.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {FEEDS,SLO_PATH,advisories,budgetView,describeSlo,formatPct,headline,latencyText,stripCells} from '../lib/status-slo.js';

const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const NOW=Date.parse('2026-09-30T12:00:00Z');
const DAY=86_400_000;

const lane=(name,over={})=>({lane:name,source:name==='public'?'request-aggregates':'dp-noised',target:name==='public'?0.995:0.99,state:'operational',
 windows:{'1h':{availability:1,eligible:10},'24h':{availability:0.9991,eligible:900},'7d':{availability:null,eligible:0},'30d':{availability:0.99956,eligible:9000}},
 latency_24h:{p50_ms:500,p95_ms:2500,measure:'x'},error_budget:{remaining:0.6,failures:18,allowed_failures:45,exhausted:false},
 daily:[{day:'2026-09-28',availability:null},{day:'2026-09-29',availability:0.97},{day:'2026-09-30',availability:0.999}],...over});

test('a share is truncated to two decimals, never rounded up',()=>{
 assert.equal(formatPct(1),'100%');
 assert.equal(formatPct(0.99956),'99.95%');
 assert.equal(formatPct(0.99999),'99.99%');
 assert.equal(formatPct(0.995),'99.5%');
 assert.equal(formatPct(0.9),'90%');
 for(const bad of [null,undefined,NaN,-1,'0.9'])assert.equal(formatPct(bad),'',String(bad));
});

test('latency reads as the top of its bucket',()=>{
 assert.equal(latencyText(500),'≤ 500 ms');
 assert.equal(latencyText(2500),'≤ 2.5 s');
 assert.equal(latencyText(10000),'≤ 10 s');
 assert.equal(latencyText(null),'');
});

test('each day is one solid bar: at target, a dip, a drop, or no data',()=>{
 const cells=stripCells([{day:'a',availability:0.999},{day:'b',availability:0.97},{day:'c',availability:0.5},{day:'d',availability:null}],0.995);
 assert.deepEqual(cells.map(c=>c.kind),['ok','dip','bad','none']);
 assert.match(cells[3].text,/no data/);
 assert.deepEqual(stripCells(undefined,0.99),[]);
});

test('the error budget shows the share left and never more than all of it',()=>{
 assert.deepEqual(budgetView({remaining:0.6,failures:18,allowed_failures:45,exhausted:false}).pct,60);
 const spent=budgetView({remaining:0,failures:80,allowed_failures:45,exhausted:true});
 assert.equal(spent.pct,0);assert.equal(spent.exhausted,true);assert.match(spent.text,/^Spent/);
 assert.equal(budgetView({remaining:null}).pct,null);
});

test('the headline names the lanes in trouble',()=>{
 assert.equal(headline([lane('public'),lane('attested')]).text,'All lanes operational');
 assert.equal(headline([lane('public',{state:'no_data'})]).tone,'none');
 const h=headline([lane('public',{state:'degraded'}),lane('attested',{state:'outage'})]);
 assert.equal(h.tone,'bad');assert.match(h.text,/Public and Attested are having an outage/);
});

test('the page view keeps private lanes marked as noisy and keeps suggestions out of history',()=>{
 const v=describeSlo({generated_at:'2026-09-30T12:00:00Z',lanes:[lane('public'),lane('attested')],surfaces:[{surface:'chat',state:'operational',windows:{'24h':{availability:0.999,errors:{server_error_rate:0.001}}},latency_24h:{p50_ms:250,p95_ms:1000}}],
  incidents:{open:[],recent:[{id:'inc_1',title:'Slow',status:'resolved',impact:'minor',lanes:['public'],surfaces:['chat'],started_at:'2026-09-29T10:00:00Z',resolved_at:'2026-09-29T11:00:00Z',updates:[{at:'2026-09-29T11:00:00Z',status:'resolved',text:'ok'}]}]}});
 assert.equal(v.lanes[0].noisy,false);assert.equal(v.lanes[1].noisy,true);
 assert.equal(v.lanes[0].headline,'99.95%');
 assert.equal(v.lanes[0].windows.find(w=>w.name==='7d').pct,'');
 assert.equal(v.surfaces[0].name,'Chat and Responses');assert.equal(v.surfaces[0].errors,'0.1%');
 assert.equal(v.history[0].anchor,'incident-inc_1');assert.equal(v.history[0].started,'2026-09-29 10:00 UTC');
 assert.equal(describeSlo(null),null);
});

test('attestation advisories: unverified providers, recent measurement changes and fresh failures',()=>{
 const iso=(ago)=>new Date(NOW-ago).toISOString();
 const out=advisories({providers:[
  {provider:'a',name:'A',status:'attested',last_measurement_change:{at:iso(2*DAY),changed:['compose_hash']},last_failure:null},
  {provider:'b',name:'B',status:'unverified',last_failure:{at:iso(1000)}},
  {provider:'c',name:'C',status:'attested',last_measurement_change:{at:iso(9*DAY),changed:['mrtd']},last_failure:{at:iso(3*3_600_000)}},
  {provider:'d',name:'D',status:'attested'},
 ]},NOW);
 assert.deepEqual(out.map(a=>[a.provider,a.tone]),[['a','warn'],['b','bad'],['c','warn']]);
 assert.match(out[0].text,/compose_hash/);
 assert.equal(advisories({providers:[]},NOW).length,0);
 for(const a of out)assert.doesNotMatch(a.text,/—/);
});

test('the page is wired: the board and proof-time on /status, relative API paths, feeds and the footer link',()=>{
 const page=read('app/status/page.jsx');
 assert.match(page,/<StatusBoard \/>/);assert.match(page,/<ProofTime \/>/);assert.match(page,/id="proof-time"/);
 assert.equal(SLO_PATH,'/api/v1/status/slo');assert.equal(FEEDS.atom,'/api/v1/status/incidents.atom');
 const board=read('components/StatusBoard.jsx');
 assert.doesNotMatch(board,/https?:\/\//,'the board names no host');
 assert.match(board,/REFRESH_MS/);
 const footer=read('components/Footer.jsx');
 assert.match(footer,/TASKS.filter/);
 assert.ok(TASKS.some(task=>task.id==='status'&&task.href==='/status/'));
 const css=read('components/StatusBoard.module.css');
 assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g,''),/\b(border(-(top|right|bottom|left|width|style|color))*|outline)\s*:/,'colour fields, not outlines');
 for(const f of ['app/status/page.jsx','components/StatusBoard.jsx','lib/status-slo.js'])assert.doesNotMatch(read(f).replace(/title: "[^"]*"/,''),/—/,`${f} has an em dash`);
});

test('the built page renders the status shell',{skip:!fs.existsSync(new URL('../out/status/index.html',import.meta.url))},()=>{
 const html=read('out/status/index.html');
 assert.match(html,/<title>Anyroute status<\/title>/);
 assert.match(html,/measured in the open/);
 assert.match(html,/Proof-time is better/);
 assert.match(html,/href="\/status\/"/);
});
