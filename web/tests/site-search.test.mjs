import test from 'node:test';
import assert from 'node:assert/strict';
import { TASKS } from '../lib/site-map.js';
import { searchTasks } from '../lib/site-search.js';
const ids = rows => rows.map(row => row.id);
const entry = (id, title, keywords = [], description = '', featured = false) => ({ id, title, keywords, description, featured });

test('ranking is exact title, title prefix, title mention, keyword, description', () => {
  const rows = [entry('description', 'Other', [], 'Use image controls'), entry('keyword', 'Draw something', ['image']), entry('mention', 'Make an image'), entry('prefix', 'Image creation'), entry('exact', 'Image')];
  assert.deepEqual(ids(searchTasks('image', rows)), ['exact', 'prefix', 'mention', 'keyword', 'description']);
});
test('search tolerates case, plural words, accents and small typos', () => {
  for (const query of ['PICTURES', 'pictur', 'pictuer', 'pictxre', 'pícture']) assert.ok(ids(searchTasks(query)).includes('images'), query);
  assert.equal(searchTasks('reciept')[0].id, 'receipt');
  assert.equal(searchTasks('telegram')[0].id, 'telegram');
  assert.equal(searchTasks('api keys')[0].id, 'dashboard');
});
test('empty queries show featured tasks in source order', () => {
  for (const query of ['', '   ', '?!']) assert.deepEqual(searchTasks(query), TASKS.filter(task => task.featured));
});
test('ties keep source order and matching never mutates the map', () => {
  const rows = [entry('one', 'Find something', ['art']), entry('two', 'Find another', ['art'])];
  const before = JSON.stringify(rows);
  assert.deepEqual(ids(searchTasks('art', rows)), ['one', 'two']);
  assert.deepEqual(ids(searchTasks('art', rows)), ['one', 'two']);
  assert.equal(JSON.stringify(rows), before);
});
test('all query words must match, and unrelated queries have no results', () => {
  assert.ok(ids(searchTasks('agent budget')).includes('rulebook'));
  assert.deepEqual(searchTasks('notawordzzzz'), []);
  assert.deepEqual(searchTasks('image notawordzzzz'), []);
  assert.deepEqual(searchTasks('mxyz'), []);
});
