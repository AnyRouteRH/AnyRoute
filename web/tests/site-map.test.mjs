import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GROUPS, TASKS } from '../lib/site-map.js';

const root = path.resolve(import.meta.dirname, '..');
function sources(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  let source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(file), match[1]);
    const target = [base, base + '.jsx', base + '.js'].find(candidate => /\.(?:jsx|js)$/.test(candidate) && fs.existsSync(candidate));
    if (target) source += '\n' + sources(target, seen);
  }
  return source;
}
function pages(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? pages(path.join(dir, entry.name)) : entry.name === 'page.jsx' ? [path.join(dir, entry.name)] : []);
}

test('the map has unique tasks, ordered non-empty groups and concise honest copy', () => {
  assert.ok(GROUPS.length >= 5 && GROUPS.length <= 6);
  assert.equal(new Set(GROUPS.map(group => group.id)).size, GROUPS.length);
  assert.equal(new Set(TASKS.map(task => task.id)).size, TASKS.length);
  for (const group of GROUPS) {
    assert.ok(TASKS.some(task => task.group === group.id));
    assert.ok(TASKS.some(task => task.group === group.id && task.featured));
  }
  for (const task of TASKS) {
    assert.ok(GROUPS.some(group => group.id === task.group), task.id);
    assert.ok(task.title.length > 0 && task.title.length <= 40, task.title);
    assert.ok(task.description.length > 0 && task.description.length <= 90 && !task.description.includes('\n'), task.description);
    assert.equal(typeof task.featured, 'boolean');
    assert.ok(Array.isArray(task.keywords) && task.keywords.length);
    assert.doesNotMatch([task.title, task.description, ...task.keywords].join(' '), /\b(?:earn|yield|APY|returns|passive|demo|test|tested|mock|simulated|placeholder|decentralized|trustless)\b|local[ -]build/i);
  }
});

test('every destination is an existing page with literal reachable anchor IDs', () => {
  for (const task of TASKS) {
    assert.match(task.href, /^\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?$/);
    const [route, anchor] = task.href.split('#');
    const page = path.join(root, 'app', route, 'page.jsx');
    assert.ok(fs.existsSync(page), task.href);
    if (anchor) assert.ok(sources(page).includes(`id="${anchor}"`) || sources(page).includes(`id='${anchor}'`), task.href);
  }
});

test('every former header destination remains reachable', () => {
  for (const href of ['/models/', '/harness/', '/ask/', '/arena/', '/agents/', '/network/', '/hosts/', '/docs/', '/whitepaper/', '/seal/', '/tokens/', '/case-study/', '/#roadmap', '/#about']) assert.ok(TASKS.some(task => task.href === href), href);
});

test('every static page has a task, with dynamic profiles reached from their indexes', () => {
  const mapped = new Set(TASKS.map(task => task.href.split('#')[0]));
  for (const file of pages(path.join(root, 'app'))) {
    const route = '/' + path.relative(path.join(root, 'app'), path.dirname(file)).split(path.sep).filter(Boolean).join('/');
    if (route === '/agents/profile') assert.ok(sources(path.join(root, 'app/agents/directory/page.jsx')).includes('/agents/profile/?id='), 'Profiles require a directory-selected id');
    else if (route.includes('[')) assert.ok(mapped.has(route.split('/[')[0] + '/'), file);
    else if (route !== '/') assert.ok(mapped.has(route + '/'), file);
  }
});

test('inactive features are not promoted as tasks', () => {
  assert.doesNotMatch(TASKS.map(task => [task.title, task.description, ...task.keywords].join(' ')).join('\n'), /payout|slashing|email alert|npm|pypi|sdk release/i);
});

test('each menu stays short: at most nine tools per group; everything else is still searchable', async () => {
  const { GROUPS, TASKS, menuTasks } = await import('../lib/site-map.js');
  for (const group of GROUPS) {
    const shown = menuTasks(group.id);
    assert.ok(shown.length >= 3 && shown.length <= 9, `${group.id} shows ${shown.length}`);
  }
  assert.ok(TASKS.some(item => !item.menu), 'search-only tools exist');
});

test('the footer keeps support and every link it had before the task map', () => {
  const footer = fs.readFileSync(new URL('../components/Footer.jsx', import.meta.url), 'utf8');
  for (const href of ['mailto:Anyroute1@atomicmail.io', '/docs/#sdk', '/dashboard/#playground', '/#developers', '/#routes', '/#how-it-works', '/#privacy', '/registry/', '/docs/#badge', '/status/#proof-time']) assert.ok(footer.includes(`'${href}'`), href);
});
