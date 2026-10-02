import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GROUPS, TASKS } from '../lib/site-map.js';
import { isSearchShortcut } from '../lib/site-search.js';

const transpile = 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));';
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) for (const ext of ['.jsx', '.js']) {
      const url = new URL(specifier + ext, context.parentURL);
      if (fs.existsSync(url)) return next(url.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {};' };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: 'import React from "react";\n' + execFileSync('bun', ['-e', transpile], { input: fs.readFileSync(fileURLToPath(url), 'utf8'), encoding: 'utf8' }) };
    return next(url, context);
  },
});
const { DesktopGroups, MobileGroups } = await import('../components/nav/GroupMenus.jsx');
const { default: TaskMap } = await import('../components/nav/TaskMap.jsx');
const { default: SearchButton } = await import('../components/nav/SearchButton.jsx');
hook.deregister();
const render = (component, props = {}) => renderToStaticMarkup(createElement(component, props));

function assertLinks(html, tasks) {
  for (const task of tasks) assert.ok(html.includes(`href="${task.href}"`), task.id);
  assert.equal((html.match(/<a\b/g) || []).length, tasks.length);
}

test('desktop disclosures expose the menu tools with labelled, closed panels', () => {
  const html = render(DesktopGroups, { path: '/harness/' });
  assertLinks(html, TASKS.filter(task => task.menu));
  for (const group of GROUPS) {
    assert.ok(html.includes(`aria-expanded="false" aria-controls="nav-${group.id}"`));
    assert.ok(html.includes(`id="nav-${group.id}" hidden="" aria-label="${group.title} tasks"`));
  }
  assert.ok(html.includes('aria-controls="nav-chat" aria-current="true"'));
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
});

test('mobile navigation includes Home and the grouped menu tools', () => {
  const html = render(MobileGroups, { onNavigate() {} });
  assertLinks(html, [...TASKS.filter(task => task.menu), { id: 'home', href: '/' }]);
  for (const group of GROUPS) assert.ok(html.includes(`id="mobile-${group.id}"`));
});

test('homepage cards use only the featured tasks and include the search trigger', () => {
  const html = render(TaskMap);
  assertLinks(html, TASKS.filter(task => task.featured));
  for (const group of GROUPS) assert.ok(html.includes(`<h3>${group.title}</h3>`));
  assert.ok(html.includes('Search everything'));
  assert.ok(html.includes('aria-haspopup="dialog" aria-controls="site-search"'));
});

test('the search button dispatches the same in-memory event on every route', () => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent(event) { events.push(event.type); } };
  try {
    const button = SearchButton({ onOpen() { events.push('close-menu'); } });
    assert.equal(button.props['aria-controls'], 'site-search');
    button.props.onClick();
    assert.deepEqual(events, ['close-menu', 'anyroute:site-search']);
  } finally { globalThis.window = previous; }
});

test('Command K, Control K and slash open search outside the Harness', () => {
  for (const pathname of ['/', '/docs/', '/agents/', '/agents/directory/']) {
    for (const event of [{ key: 'k', metaKey: true }, { key: 'K', ctrlKey: true }, { key: '/' }]) assert.equal(isSearchShortcut(event, { pathname }), true);
    assert.equal(isSearchShortcut({ key: 'k', ctrlKey: true }, { pathname, editable: true }), true);
    assert.equal(isSearchShortcut({ key: '/' }, { pathname, editable: true }), false);
  }
});

test('the Harness, text entry, composition and existing dialogs retain their keys', () => {
  for (const pathname of ['/harness', '/harness/']) for (const event of [{ key: 'k', metaKey: true }, { key: 'k', ctrlKey: true }, { key: '/' }]) assert.equal(isSearchShortcut(event, { pathname }), false);
  for (const event of [{ key: '/', ctrlKey: true }, { key: 'k' }, { key: 'k', metaKey: true, altKey: true }, { key: 'k', metaKey: true, shiftKey: true }, { key: 'k', metaKey: true, defaultPrevented: true }, { key: '/', isComposing: true }]) assert.equal(isSearchShortcut(event, { pathname: '/' }), false);
  assert.equal(isSearchShortcut({ key: 'k', metaKey: true }, { pathname: '/', dialogOpen: true }), false);
});

test('no group is marked current on the homepage', () => {
  const html = render(DesktopGroups, { path: '/' });
  assert.equal((html.match(/aria-current="true"/g) || []).length, 0);
});
