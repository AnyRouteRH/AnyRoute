import test from 'node:test';
import assert from 'node:assert/strict';
import {WINDOW_MS,ago,barCells,describeProvider,describeSummary,describeWindow,durationLabel,fieldLabel,formatShare,historyPath,markerPositions,pageState,verifyHref} from '../lib/proof-time.js';

const NOW=Date.parse('2026-09-29T12:00:00Z');
const HOUR=3_600_000;
const iso=(agoMs)=>new Date(NOW-agoMs).toISOString();

test('times read as how long ago, in hours until two days',()=>{
 assert.equal(ago(iso(20_000),NOW),'just now');
 assert.equal(ago(iso(12*60_000),NOW),'12 min ago');
 assert.equal(ago(iso(30*HOUR),NOW),'30 h ago');
 assert.equal(ago(iso(47*HOUR),NOW),'47 h ago');
 assert.equal(ago(iso(5*24*HOUR),NOW),'5 d ago');
 assert.equal(ago(new Date(NOW+HOUR).toISOString(),NOW),'in the future');
 for(const bad of ['',null,undefined,'yesterday'])assert.equal(ago(bad,NOW),'');
});

test('a share is truncated, never rounded up to a better number',()=>{
 assert.equal(formatShare(1),'100%');
 assert.equal(formatShare(0),'0%');
 assert.equal(formatShare(0.9996),'99.9%');
 assert.equal(formatShare(0.99999),'99.9%');
 assert.equal(formatShare(0.4375),'43.7%');
 assert.equal(formatShare(0.5),'50%');
 assert.equal(formatShare(0.875),'87.5%');
 for(const bad of [null,undefined,NaN,-0.1,'0.5',Infinity])assert.equal(formatShare(bad),'',String(bad));
 assert.equal(formatShare(1.2),'100%'); // clamped, not extended
});

test('durations read in the two largest units',()=>{
 assert.equal(durationLabel(30_000),'under a minute');
 assert.equal(durationLabel(45*60_000),'45 min');
 assert.equal(durationLabel(6*HOUR+12*60_000),'6 h 12 min');
 assert.equal(durationLabel(2*HOUR),'2 h');
 assert.equal(durationLabel(3*24*HOUR+4*HOUR+5*60_000),'3 d 4 h');
 assert.equal(durationLabel(4*24*HOUR),'4 d');
 for(const bad of [-1,NaN,null,'x'])assert.equal(durationLabel(bad),'');
});

test('bar cells tell covered, gap, partial and unknown apart',()=>{
 assert.deepEqual(barCells([100,0,25,null,undefined,'x',140,-5]),[
  {pct:100,kind:'full'},{pct:0,kind:'none'},{pct:25,kind:'partial'},{pct:null,kind:'nodata'},{pct:null,kind:'nodata'},{pct:null,kind:'nodata'},{pct:100,kind:'full'},{pct:0,kind:'none'},
 ]);
 assert.deepEqual(barCells(null),[]);
});

test('markers sit where the change fell in the window and nowhere else',()=>{
 const changes=[{at:iso(6*HOUR),changed:['image_digest']},{at:iso(30*HOUR),changed:['mrtd']},{at:'nope'},{at:new Date(NOW+HOUR).toISOString()}];
 const m=markerPositions(changes,NOW,WINDOW_MS['24h']);
 assert.equal(m.length,1);
 assert.equal(m[0].left,75);
 assert.deepEqual(m[0].changed,['image_digest']);
 assert.equal(markerPositions(changes,NOW,WINDOW_MS['7d']).length,2);
 assert.deepEqual(markerPositions(null,NOW,1000),[]);
});

const bucketsOf=(n,fn)=>Array.from({length:n},(_,i)=>fn(i));
const windowOf=(over={})=>({share:0.875,observed_ms:24*HOUR,observed_from:iso(24*HOUR),history_complete:true,buckets:bucketsOf(48,(i)=>i<42?100:0),...over});

test('a full window states its share; a short record says how short, and does not pretend',()=>{
 const full=describeWindow('24h',windowOf(),[],NOW);
 assert.equal(full.state,'complete');
 assert.equal(full.shareText,'87.5%');
 assert.match(full.caption,/^Covered for 87\.5% of the window\.$/);
 assert.equal(full.cells.length,48);
 assert.match(full.summary,/fresh attestation for 87\.5% of the time/);
 assert.match(full.summary,/48 slices: 42 fully covered, 6 with a gap, 0 before the record begins/);

 const partial=describeWindow('7d',windowOf({share:0.625,observed_ms:36*HOUR,history_complete:false,buckets:[...bucketsOf(66,()=>null),...bucketsOf(18,()=>100)]}),[],NOW);
 assert.equal(partial.state,'partial');
 assert.equal(partial.shareText,'62.5%');
 assert.match(partial.caption,/of the 1 d 12 h the record spans/);
 assert.match(partial.caption,/unknown, and is not counted either way/);
 assert.match(partial.summary,/66 before the record begins/);

 const early=describeWindow('24h',windowOf({share:1,observed_ms:25*60_000,history_complete:false,buckets:[...bucketsOf(47,()=>null),100]}),[],NOW);
 assert.equal(early.state,'early');
 assert.equal(early.shareText,'');
 assert.equal(early.share,null);
 assert.match(early.caption,/spans only 25 min, too little to give a share/);

 const none=describeWindow('24h',{share:null,observed_ms:0,history_complete:false,buckets:bucketsOf(48,()=>null)},[],NOW);
 assert.equal(none.state,'empty');
 assert.equal(none.shareText,'');
 assert.match(none.caption,/Nothing recorded/);
 assert.equal(describeWindow('24h',undefined,[],NOW).state,'empty');
});

const provider=(over={})=>({
 provider:'phala-x',name:'Phala X',status:'attested',tee:'tdx',attested_at:iso(5*60_000),history_since:iso(40*HOUR),
 runs_7d:{total:200,attested:190,attested_pct:95},
 fresh:{'24h':windowOf(),'7d':windowOf({share:0.9,observed_ms:40*HOUR,history_complete:false,buckets:[...bucketsOf(64,()=>null),...bucketsOf(20,()=>100)]})},
 measurement:{digests:{image_digest:'0x'+'11'.repeat(32)}},
 measurement_changes_7d:[{at:iso(3*HOUR),changed:['image_digest']}],
 last_measurement_change:{at:iso(3*HOUR),changed:['image_digest'],from:{image_digest:'0x'+'11'.repeat(32)},to:{image_digest:'0x'+'44'.repeat(32)}},
 last_failure:{at:iso(19*HOUR),code:'endpoint_unreachable',message:'The attestation endpoint could not be reached.'},
 probe:{ok:true,since:iso(2*HOUR)},canary:{ok:false,at:iso(HOUR),model:'a/b',reason:{code:'quantization_mismatch',message:'The canary output looked like lower precision than the provider declares.'}},
 ...over});

test('a provider reads as what the router says it is, with its gaps in words',()=>{
 const v=describeProvider(provider(),{history_days:30},NOW);
 assert.equal(v.status,'attested');
 assert.equal(v.label,'Attested');
 assert.equal(v.tone,'ok');
 assert.equal(v.lastVerified,'5 min ago');
 assert.equal(v.tee,'Intel TDX (confidential virtual machine)');
 assert.equal(v.runs.text,'95% of 200 checks in 7 days passed');
 assert.equal(v.failure.state,'seen');
 assert.equal(v.failure.when,'19 h ago');
 assert.equal(v.failure.text,'The attestation endpoint could not be reached.');
 assert.equal(v.change.state,'seen');
 assert.match(v.change.text,/Changed: image digest\./);
 assert.match(v.change.from,/^0x1111/);
 assert.notEqual(v.change.from,v.change.to);
 assert.deepEqual(v.changes.map((c)=>[c.when,c.text]),[['3 h ago','image digest']]);
 assert.equal(v.windows[0].markers.length,1); // inside 24 h
 assert.equal(v.windows[1].markers.length,1);
 assert.match(v.canary.text,/lower precision/);
 assert.match(v.probe.text,/^Answered its last health probe/);
 assert.equal(v.verifyHref,'/verify/?p=phala-x');
});

test('unverified stays unverified, whatever the history looks like',()=>{
 const v=describeProvider(provider({status:'unverified',reason:'last_attempt_failed',attested_at:null}),{history_days:30},NOW);
 assert.equal(v.label,'Unverified');
 assert.equal(v.tone,'bad');
 assert.match(v.text,/latest attempt to verify this provider failed/);
 assert.equal(v.tee,'Not established');
 assert.equal(v.lastVerified,'');
 // an unknown reason falls back to the general line, never to a kinder one
 assert.match(describeProvider(provider({status:'unverified',reason:'something_new'}),{},NOW).text,/no current verification/);
 assert.equal(describeProvider(provider({status:'mystery'}),{},NOW).status,'unverified');
});

test('simulated evidence is labelled as such and not as attested',()=>{
 const v=describeProvider(provider({status:'simulated',tee:'dev'}),{},NOW);
 assert.equal(v.label,'Simulated');
 assert.equal(v.tone,'warn');
 assert.match(v.text,/Nothing about it is verified/);
 assert.equal(v.tee,'None: simulated for development');
});

test('a provider with nothing recorded says so, not "no failures"',()=>{
 const v=describeProvider({provider:'new-one',name:'New One',status:'unverified',reason:'no_attestation',history_since:null,fresh:{'24h':{share:null,observed_ms:0,history_complete:false,buckets:bucketsOf(48,()=>null)},'7d':{share:null,observed_ms:0,history_complete:false,buckets:bucketsOf(84,()=>null)}},last_failure:null,last_measurement_change:null,runs_7d:{total:0,attested:0,attested_pct:null}},{history_days:30},NOW);
 assert.equal(v.hasHistory,false);
 assert.equal(v.failure.state,'unknown');
 assert.equal(v.change.state,'unknown');
 assert.match(v.failure.text,/Nothing has been recorded yet/);
 assert.equal(v.runs,null);
 assert.deepEqual(v.windows.map((w)=>w.state),['empty','empty']);
 // with a record and no failure, the absence is stated against the history the router keeps
 const clean=describeProvider(provider({last_failure:null,last_measurement_change:null,measurement_changes_7d:[]}),{history_days:30},NOW);
 // the absence is stated over what is on record (here 40 h), never over the days the router could keep
 assert.equal(clean.failure.text,'No failed check in the 1 d 16 h on record.');
 assert.equal(clean.change.text,'No measurement change in the 1 d 16 h on record.');
 const brief=describeProvider(provider({last_failure:null,last_measurement_change:null,history_since:iso(25*60_000)}),{history_days:30},NOW);
 assert.equal(brief.failure.text,'No failed check in the 25 min on record.');
 const long=describeProvider(provider({last_failure:null,last_measurement_change:null,history_since:iso(45*24*HOUR)}),{history_days:30},NOW);
 assert.equal(long.failure.text,'No failed check in the 30 d on record.');
});

test('the summary carries its own definition of fresh',()=>{
 const s=describeSummary({history_days:14,generated_at:iso(0),fresh_within_ms:1_800_000,providers:[provider()]},NOW);
 assert.equal(s.providers.length,1);
 assert.equal(s.historyDays,14);
 assert.equal(s.freshMinutes,30);
 assert.match(s.definition,/last 30 minutes, with no failed check since/);
 assert.match(describeSummary({providers:[]},NOW).definition,/recently/);
 assert.deepEqual(describeSummary(null,NOW).providers,[]);
});

test('the page says why it has nothing, and does not confuse silence with failure',()=>{
 assert.equal(pageState(501).kind,'off');
 assert.match(pageState(501).text,/does not keep an attestation history/);
 assert.equal(pageState('network').kind,'error');
 assert.match(pageState('network').text,/not the same as “not attested”/);
 assert.equal(pageState(503).kind,'error');
 assert.equal(pageState(404).kind,'error');
 assert.equal(pageState(200).kind,'ok');
});

test('paths and labels',()=>{
 assert.equal(historyPath('a b'),'/api/v1/attestation/a%20b/history');
 assert.equal(verifyHref('x'),'/verify/?p=x');
 assert.equal(fieldLabel('compose_hash'),'compose hash');
 assert.equal(fieldLabel('novel'),'novel');
});
