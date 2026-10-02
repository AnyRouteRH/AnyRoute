import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activityBounds, activityPath, activityPage, activityChips, exportActivity } from '../lib/activity.js';
import ActivityList from '../components/account/ActivityList.js';
import { sectionFromHash, sectionHash } from '../components/account/account-state.js';
import { TASKS } from '../lib/site-map.js';
const row = { id: 'call:one', at: '2026-09-28T12:00:00.000123Z', kind: 'call', title: 'AI call', amount: '-0.000000000001', model: 'acme/model', lane: 'public', where: 'Provider A', key_label: 'Agent key', receipt_id: 'one', reference: 'one', verify_url: '/verify/?r=one', approval_limit: null, status: 'completed' };
test('activity builds encoded kind, key, model and exclusive UTC range filters', () => {
  const bounds = activityBounds('2026-09-01','2026-10-01');
  assert.deepEqual(bounds,{from:'2026-09-01T00:00:00.000Z',to:'2026-10-01T00:00:00.000Z'});
  const url = new URL(activityPath({kind:'call',key:'selected-key',model:'acme/model & variant',...bounds},'cursor','csv',100),'https://router.example');
  assert.equal(url.pathname,'/api/v1/activity');assert.equal(url.searchParams.get('model'),'acme/model & variant');assert.equal(url.searchParams.get('cursor'),'cursor');assert.equal(url.searchParams.get('format'),'csv');assert.equal(url.searchParams.get('key'),'selected-key');assert.equal(url.searchParams.get('limit'),'100');
  assert.deepEqual(activityBounds('',''),{from:'',to:''});
});
test('filter chips show plain labels without displaying full key identifiers',()=>{
  assert.deepEqual(activityChips({kind:'call',key:'full-key-identifier',model:'acme/model',from:''}),[{name:'kind',label:'Calls'},{name:'key',label:'Selected key or agent'},{name:'model',label:'Model: acme/model'}]);
});
test('page validation retains exact amounts and independent next cursor',()=>{
  assert.deepEqual(activityPage({data:[row],next_cursor:'next',scope:'key'}),{rows:[row],next:'next',scope:'key'});
  for(const bad of [null,{data:{}},{data:[],scope:'unknown'}])assert.throws(()=>activityPage(bad),/could not be read/);
});
test('list uses keyboard-expandable rows, exact amounts, recorded location and prefilled receipt links',()=>{
  const html=renderToStaticMarkup(h(ActivityList,{rows:[row,{...row,id:'approval:two',title:'Payment approval',amount:'0',receipt_id:null,approval_limit:'1.000000000001'}]}));
  assert.match(html,/<details>/);assert.match(html,/<summary>/);assert.match(html,/-0\.000000000001 USDG/);assert.match(html,/1\.000000000001 USDG/);assert.match(html,/Provider A/);assert.match(html,/href="\/verify\/\?r=one"/);assert.match(html,/Check this receipt/);assert.match(html,/No signed call receipt recorded/);assert.doesNotMatch(html,/attested|verified|we can.t read/i);
});
test('JSON export follows every filtered page rather than only loaded rows',async()=>{
  const requests=[];
  const request=async path=>{requests.push(new URL(path,'https://router.example'));return requests.length===1?{data:[row],scope:'account',next_cursor:'next'}:{data:[{...row,id:'call:two'}],scope:'account',next_cursor:null};};
  const file=await exportActivity(request,{kind:'call',model:'acme/model'},'json');
  assert.equal(JSON.parse(file.text).data.length,2);assert.equal(file.name,'activity.json');assert.equal(requests[1].searchParams.get('cursor'),'next');
  assert.ok(requests.every(url=>url.searchParams.get('kind')==='call'&&url.searchParams.get('model')==='acme/model'));
});
test('CSV export joins pages with one header and retains quoted multiline cells',async()=>{
  let n=0;
  const request=async(path,options)=>{n++;assert.equal(options.raw,true);options.onResponse({headers:new Headers(n===1?{'x-next-cursor':'next'}:{})});return 'id,title\r\n'+(n===1?'"one","a\r\nb"\r\n':'"two","c"\r\n');};
  const file=await exportActivity(request,{kind:'alert'},'csv');
  assert.equal(file.text,'id,title\r\n"one","a\r\nb"\r\n"two","c"\r\n');assert.equal(file.type,'text/csv');
});
test('export cancellation and repeated cursors report errors without partial downloads',async()=>{
  await assert.rejects(exportActivity(async()=>({data:[],scope:'key',next_cursor:'same'}),{},'json'),/did not advance/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(exportActivity(async(path,options)=>{options.signal.throwIfAborted();}, {},'json',controller.signal),{name:'AbortError'});
});
test('unified activity and both extra tool views retain deep links in the single site map',()=>{
  assert.equal(sectionFromHash('#activity'),'Activity');assert.equal(sectionHash('Activity'),'activity');assert.equal(sectionFromHash('#receipts'),'Receipts');assert.equal(sectionFromHash('#spend-watch'),'Spend Watch');
  for(const id of ['account-activity','activity','api-receipts'])assert.equal(TASKS.find(task=>task.id===id).href,'/dashboard/#activity');
});
