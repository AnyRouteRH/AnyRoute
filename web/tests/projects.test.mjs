import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activityPath, activityChips, exportActivity } from '../lib/activity.js';
import { insightsPath } from '../lib/insights.js';
import { projectActivityPath } from '../lib/project-activity.js';
import ProjectFilter from '../components/account/ProjectFilter.js';
import ProjectBreakdown from '../components/account/ProjectBreakdown.js';
import ActivityList from '../components/account/ActivityList.js';
import { TASKS } from '../lib/site-map.js';
test('project filters preserve existing query paths when absent and encode selected labels', () => {
  assert.equal(activityPath({project:''}),activityPath({}));
  assert.equal(insightsPath({project:''}),insightsPath({}));
  assert.equal(new URL(activityPath({project:'research.v2'}),'https://router.example').searchParams.get('project'),'research.v2');
  assert.equal(new URL(insightsPath({project:'research.v2'}),'https://router.example').searchParams.get('project'),'research.v2');
  assert.deepEqual(activityChips({project:'research'}),[{name:'project',label:'Project: research'}]);
  const path = activityPath({model:'acme/model',from:'2026-09-28'}, 'next');
  assert.equal(projectActivityPath(path,''),path);
  const selected = new URL(projectActivityPath(path,'research'),'https://router.example');
  assert.equal(selected.searchParams.get('model'),'acme/model');assert.equal(selected.searchParams.get('cursor'),'next');assert.equal(selected.searchParams.get('project'),'research');
});
test('every exported page carries its project filter', async () => {
  const paths=[];
  await exportActivity(async path=>{paths.push(path);return {data:[],scope:'key',next_cursor:paths.length===1?'next':null};},{project:'research'},'json');
  assert.equal(paths.length,2);assert.ok(paths.every(path=>new URL(path,'https://router.example').searchParams.get('project')==='research'));
});
test('project controls and breakdowns use plain labels and native keyboard controls', () => {
  const filter=renderToStaticMarkup(h(ProjectFilter,{value:'research',onChange:()=>{}}));
  assert.match(filter,/<label>Project<input/);assert.match(filter,/aria-label="Project"/);assert.match(filter,/maxLength="48"/);
  const html=renderToStaticMarkup(h(ProjectBreakdown,{rows:[{id:'research',cost_usd:'2.5',calls:'2'},{id:null,cost_usd:'1',calls:'1'}]}));
  assert.match(html,/By project/);assert.match(html,/scope="col"/);assert.match(html,/No project/);assert.match(html,/2\.5/);
  assert.equal(renderToStaticMarkup(h(ProjectBreakdown,{})),'');
  const list=renderToStaticMarkup(h(ActivityList,{rows:[{id:'call:one',title:'AI call',at:'2026-09-28T12:00:00Z',amount:'-1',project:'research',approval_limit:null}]}));assert.match(list,/Project: research/);
});
test('projects are searchable through the existing site map', () => { assert.ok(TASKS.some(task=>task.href==='/docs/#projects')); });
