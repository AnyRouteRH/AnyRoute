import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// SpendWatch.jsx keeps its pure helpers in one plain-JS block between markers, so they can be
// exercised here without a JSX toolchain.
const source=fs.readFileSync(new URL('../components/features/SpendWatch.jsx',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../components/features/SpendWatch.module.css',import.meta.url),'utf8');
const begin=source.indexOf('// ---- spend-watch pure helpers: begin');
const end=source.indexOf('// ---- spend-watch pure helpers: end');
assert.ok(begin>0&&end>begin,'helper markers present');
const block=source.slice(begin,end).replace(/^export /gm,'');
const names=[...block.matchAll(/^(?:function|const)\s+([A-Za-z]\w*)/gm)].map(m=>m[1]);
const loaded=vm.runInNewContext(`${block}\n;({${names.join(',')}})`,{});
// Objects made inside the vm context have its own prototypes; bring results into this realm.
const local=(v)=>v&&typeof v==='object'?JSON.parse(JSON.stringify(v)):v;
const h=Object.fromEntries(Object.entries(loaded).map(([k,v])=>[k,typeof v==='function'?(...args)=>local(v(...args)):local(v)]));

const NOW=Date.UTC(2026,8,15,12);

test('money and axis formatting stay readable from fractions of a cent to thousands',()=>{
 assert.equal(h.formatUsd(0),'$0.00');
 assert.equal(h.formatUsd(1234.5),'$1,234.50');
 assert.equal(h.formatUsd(2),'$2.00');
 assert.equal(h.formatUsd(0.0123),'$0.0123');
 assert.equal(h.formatUsd(0.000004),'$0.000004');
 assert.equal(h.formatUsd(-3),'-$3.00');
 assert.equal(h.axisUsd(0),'$0');
 assert.equal(h.axisUsd(2.5),'$2.5');
 assert.equal(h.axisUsd(1500),'$1.5K');
 assert.equal(h.axisUsd(0.005),'$0.005');
});

test('the chart axis uses round steps that cover the data',()=>{
 assert.deepEqual(h.niceScale(0),{max:1,step:0.25,ticks:[0,0.25,0.5,0.75,1]});
 const a=h.niceScale(7.3);assert.equal(a.step,2);assert.equal(a.max,8);assert.deepEqual(a.ticks,[0,2,4,6,8]);
 const b=h.niceScale(0.034);assert.equal(b.step,0.01);assert.equal(b.max,0.04);
 const c=h.niceScale(1000);assert.equal(c.max,1000);assert.equal(c.ticks.length,5);
 for(const m of [0.3,3,11.84,99,12345])assert.ok(h.niceScale(m).max>=m);
 assert.equal(h.labelEvery(90,300,60),18);
 assert.equal(h.labelEvery(7,700,60),1);
});

test('sample mode is complete, internally consistent and marked as sample everywhere',()=>{
 for(const period of ['7d','30d','90d']){
  const s=h.sampleData(period,NOW);
  assert.equal(s.sample,true);assert.equal(s.report.sample,true);
  assert.equal(s.report.series.length,Number(period.replace('d','')));
  assert.equal(s.report.series.at(-1).date,'2026-09-15');
  const total=s.report.series.reduce((x,d)=>x+d.cost_usd,0);
  assert.ok(Math.abs(total-s.report.totals.period_usd)<0.011);
  assert.equal(s.report.totals.today_usd,s.report.series.at(-1).cost_usd);
  assert.equal(s.report.anomaly.flagged,true);
  assert.ok(s.report.anomaly.today_usd>=3*s.report.anomaly.trailing_daily_avg_usd);
  const shares=s.report.breakdown.reduce((x,r)=>x+r.share,0);assert.ok(Math.abs(shares-1)<1e-9);
  for(const k of s.report.byKey)assert.match(k.id,/^sample-/);
  for(const r of s.rules){assert.match(r.id,/^sample-/);for(const f of r.history)assert.match(f.id,/^sample-/);}
 }
 assert.deepEqual(h.sampleData('30d',NOW),h.sampleData('30d',NOW),'deterministic');
 // Every sample surface in the component carries a visible sample label.
 for(const label of ['Sample data','Sample · ','Sample rules · read only','(sample)','SAMPLE','Sample spike'])assert.ok(source.includes(label),label);
});

test('rule descriptions, firing text and delivery states read as sentences',()=>{
 assert.equal(h.describeRule({kind:'threshold',threshold_usd:25,window:'day'}),'Spend ≥ $25.00 per day');
 assert.equal(h.describeRule({kind:'budget_pct',pct:80}),'Budget ≥ 80% used');
 assert.equal(h.describeRule({kind:'anomaly',multiplier:2.5}),'Day spend ≥ 2.5× the 7-day average');
 assert.equal(h.firingText({kind:'threshold',window:'week',value_usd:9,threshold_usd:8}),'$9.00 spent this week (limit $8.00)');
 assert.equal(h.firingText({kind:'anomaly',value_usd:3.5,pct:350}),'$3.50 today · 3.5× the average');
 assert.deepEqual(h.deliveryText({status:'delivered',attempts:1}),{tone:'ok',text:'Delivered'});
 assert.deepEqual(h.deliveryText({status:'delivered',attempts:3}),{tone:'ok',text:'Delivered on attempt 3'});
 assert.deepEqual(h.deliveryText({status:'pending',attempts:0}),{tone:'wait',text:'Queued'});
 assert.deepEqual(h.deliveryText({status:'pending',attempts:1,max_attempts:3,http_status:503}),{tone:'wait',text:'Retrying · attempt 1 of 3 failed (HTTP 503)'});
 assert.deepEqual(h.deliveryText({status:'failed',attempts:3,error:'timeout'}),{tone:'bad',text:'Failed after 3 attempts (timed out)'});
 assert.deepEqual(h.deliveryText({status:'blocked',attempts:1,error:'destination_blocked'}),{tone:'bad',text:'Not sent: destination is not public'});
 assert.deepEqual(h.deliveryText({status:'none',attempts:0}),{tone:'off',text:'No webhook'});
 assert.equal(h.budgetLevel(79.9),'ok');assert.equal(h.budgetLevel(80),'warn');assert.equal(h.budgetLevel(100),'over');
});

test('the rule form never echoes the saved webhook and sends only what changed kind-wise',()=>{
 const saved={id:'sa_1',kind:'threshold',window:'week',threshold_usd:12.5,key_hash:null,webhook_url:'https://hooks.example.com/…',enabled:true};
 const f=h.emptyForm(saved,'');
 assert.equal(f.webhook,'','the masked URL is a placeholder, not a value');
 assert.deepEqual(h.ruleBody(f,true),{window:'week',threshold_usd:12.5,key_hash:null,enabled:true});
 assert.deepEqual(h.ruleBody({...f,removeWebhook:true},true),{window:'week',threshold_usd:12.5,key_hash:null,webhook_url:null,enabled:true});
 assert.deepEqual(h.ruleBody({...f,webhook:' https://new.example.org/h '},true).webhook_url,'https://new.example.org/h');
 const n=h.emptyForm(null,'abc');
 assert.deepEqual(h.ruleBody({...n,kind:'budget_pct',pct:'90'},false),{kind:'budget_pct',pct:90,key_hash:'abc',enabled:true});
 assert.deepEqual(h.ruleBody({...n,kind:'anomaly',key:''},false),{kind:'anomaly',multiplier:3,key_hash:null,enabled:true});
 assert.equal(h.formProblem({...n,kind:'threshold',threshold:''}),'Enter the spend that triggers the alert, in USD.');
 assert.equal(h.formProblem({...n,kind:'budget_pct',key:''}),'Choose the key whose budget to watch.');
 assert.equal(h.formProblem({...n,kind:'budget_pct',pct:'12.5'}),'Use a whole percentage from 1 to 1000.');
 assert.equal(h.formProblem({...n,kind:'anomaly',multiplier:'1'}),'Use a multiplier from 1.1 to 100.');
 assert.equal(h.formProblem({...n,kind:'threshold',threshold:'5',webhook:'http://x.example.com'}),'The webhook must be an https:// URL.');
 assert.equal(h.formProblem({...n,kind:'threshold',threshold:'5',webhook:'https://x.example.com'}),'');
});

test('the chart is plain SVG with an accessible name, keyboard reading and a data table; no chart library',()=>{
 const imports=[...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(m=>m[1]);
 assert.deepEqual(imports.sort(),['../../lib/api','../UI','./SpendWatch.module.css','react']);
 assert.ok(!source.includes('dangerouslySetInnerHTML'));
 for(const needle of ['role="img"','aria-labelledby','<title id=','<desc id=','onKeyDown={onKey}','aria-live="polite"','<caption>','role="meter"'])assert.ok(source.includes(needle),needle);
 // Palette: the site's tokens only.
 for(const token of ['var(--signal)','var(--ink)','var(--paper)','var(--signal-deep)'])assert.ok(css.includes(token),token);
 assert.ok(css.includes('@media (max-width: 640px)'));
});
