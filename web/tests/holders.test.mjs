import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Holders.jsx keeps its pure helpers in one plain-JS block between markers, so they can be
// exercised here without a JSX toolchain.
const source=fs.readFileSync(new URL('../components/features/Holders.jsx',import.meta.url),'utf8');
const begin=source.indexOf('// ---- holders pure helpers: begin');
const end=source.indexOf('// ---- holders pure helpers: end');
assert.ok(begin>0&&end>begin,'helper markers present');
const block=source.slice(begin,end).replace(/^export /gm,'');
const names=[...block.matchAll(/^(?:function|const)\s+([A-Za-z]\w*)/gm)].map(m=>m[1]);
const ANYR_CA='0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a';
const loaded=vm.runInNewContext(`${block}\n;({${names.join(',')}})`,{ANYR_CA});
const local=(v)=>v&&typeof v==='object'?JSON.parse(JSON.stringify(v)):v;
const h=Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,typeof v==='function'?(...args)=>local(v(...args)):local(v)]));

test('token amounts are grouped and trimmed without float rounding',()=>{
 assert.equal(h.formatTokens('2450000'),'2,450,000');
 assert.equal(h.formatTokens('2450000.5'),'2,450,000.5');
 assert.equal(h.formatTokens('123456789012345678901.129'),'123,456,789,012,345,678,901.12');
 assert.equal(h.formatTokens('0.004'),'0');
 assert.equal(h.formatTokens('750000.99',0),'750,000');
 assert.equal(h.formatTokens(null),'0');
});

test('perks read as plain words, with the discount shown as a percentage',()=>{
 assert.equal(h.bpsText(50),'0.5%');
 assert.equal(h.bpsText(100),'1%');
 assert.equal(h.multiplierText(2),'2×');
 assert.deepEqual(h.perkLines({name:'Holder',rpm_multiplier:2,discount_bps:50},{rpm:1200}),['2× rate limit','1,200 requests a minute','0.5% off Anyroute fees']);
 assert.deepEqual(h.perkLines({name:'Free',rpm_multiplier:1.5,discount_bps:0},{rpm:0}),['1.5× rate limit','No request limit on this key','Standard fees']);
 assert.deepEqual(h.perkLines(null),['Standard rate limits','Standard fees']);
});

test('progress to the next tier is clamped between 0 and 1',()=>{
 assert.equal(h.progressTo('420000',{min:'1000000'}),0.42);
 assert.equal(h.progressTo('5000000',{min:'1000000'}),1);
 assert.equal(h.progressTo('0',{min:'100000'}),0);
 assert.equal(h.progressTo('10',null),0);
});

test('the sample is labelled and shaped like GET /api/v1/holder',()=>{
 const s=h.sampleHolder(Date.UTC(2026,8,29));
 assert.equal(s.sample,true);
 assert.equal(s.tier.name,'Holder');
 assert.equal(s.next_tier.remaining,String(Number(s.next_tier.min)-Number(s.balance)));
 assert.equal(s.credits_total_usd,s.credits_received.reduce((a,c)=>a+c.usd,0));
 for(const key of ['enabled','token','wallet','balance','tier','perks','tiers','credits_received'])assert.ok(key in s,key);
});
