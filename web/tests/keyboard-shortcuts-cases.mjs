// K193: shared by the browser-library and Bun suites; no services or account required.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SHORTCUTS, applyChatShortcutAttributes, bindKeyboardShortcuts, getShortcut, isTypingTarget, matchesShortcut, shortcutAria, shortcutLabel, shortcutsForPage } from '../lib/keyboard-shortcuts.js';
import { commandActions, registerCommand, runPageCommand } from '../lib/command-palette.js';
import { isSearchShortcut } from '../lib/site-search.js';
import { promptShortcut } from '../lib/harness-prompts.js';
import { historyShortcut } from '../lib/harness-history.js';
import { ASK_SHORTCUT } from '../lib/ask-about-this.js';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? sourceFiles(url) : /\.(jsx?|mjs)$/.test(entry.name) ? [url] : [];
  });
}
function keyboard() {
  const document = new EventTarget(), window = new EventTarget();
  let modal = false, clock = 100, opened = 0;
  const navigated = [];
  document.querySelector = () => modal;
  const dispose = bindKeyboardShortcuts({ document, window, onOpen: () => opened++, navigate: href => navigated.push(href), now: () => clock });
  return {
    document, window, dispose, navigated, get opened() { return opened; },
    modal: value => { modal = value; }, tick: value => { clock += value; },
    press(key, options = {}) {
      const event = new Event('keydown', { cancelable: true });
      for (const [name, value] of Object.entries({ key, ...options })) Object.defineProperty(event, name, { value });
      document.dispatchEvent(event);
      return event;
    },
  };
}
const field = tag => ({ closest(selector) { return selector.includes(tag) ? this : null; } });

export const keyboardShortcutCases = [
  ['registry covers every source aria-keyshortcuts declaration and every reference resolves', () => {
    const ids = SHORTCUTS.map(row => row.id);
    assert.equal(new Set(ids).size, ids.length);
    const registered = new Set(SHORTCUTS.flatMap(row => row.aria.split(' ')).filter(Boolean));
    for (const directory of ['components/', 'app/']) for (const file of sourceFiles(new URL('../' + directory, import.meta.url))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/aria-keyshortcuts=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
        if (match[1] || match[2]) for (const binding of (match[1] || match[2]).split(' ')) assert.ok(registered.has(binding), `${file.pathname}: ${binding}`);
        else assert.match(match[3], /shortcutAria\(|ASK_SHORTCUT/, `${file.pathname}: attributes must use the registry`);
      }
      for (const match of source.matchAll(/shortcutAria\(['"]([^'"]+)['"]\)/g)) assert.ok(getShortcut(match[1]).aria, match[1]);
      for (const match of source.matchAll(/<ShortcutKeys id=['"]([^'"]+)['"]/g)) assert.ok(getShortcut(match[1]), match[1]);
    }
    assert.equal(ASK_SHORTCUT, shortcutAria('chat-ask'));
    const harness = read('components/Harness.jsx');
    assert.match(harness, /useChatShortcutAttributes\(\)/);
    for (const id of ['chat-model', 'chat-prompts']) assert.ok(harness.includes(`aria-keyshortcuts="${shortcutAria(id)}"`), id);
  }],
  ['page groups show only the shortcuts that apply, including slash on every page', () => {
    for (const path of ['/', '/agents/', '/dashboard/', '/models/model/']) {
      const rows = shortcutsForPage(path);
      assert.ok(rows.every(row => row.group === 'Everywhere'));
      for (const id of ['shortcuts', 'site-search', 'focus-search', 'go-agents']) assert.ok(rows.some(row => row.id === id));
    }
    assert.ok(shortcutsForPage('/harness').some(row => row.id === 'chat-history'));
    assert.ok(shortcutsForPage('/harness/').some(row => row.id === 'chat-ask'));
    assert.ok(shortcutsForPage('/arena/').some(row => row.id === 'arena-run'));
    assert.ok(!shortcutsForPage('/harness/').some(row => row.group === 'Arena'));
  }],
  ['platform labels use Mac symbols or Windows/Linux modifiers without raw ARIA names', () => {
    for (const platform of ['MacIntel', 'macOS', 'iPad']) {
      assert.equal(shortcutLabel('site-search', platform), '⌘ K');
      assert.equal(shortcutLabel('chat-prompts', platform), '⌘ ⇧ P');
      assert.equal(shortcutLabel('chat-ask', platform), '⌥ ⇧ Q');
    }
    for (const platform of ['Win32', 'Windows', 'Linux x86_64', '']) {
      assert.equal(shortcutLabel('site-search', platform), 'Ctrl+K');
      assert.equal(shortcutLabel('chat-prompts', platform), 'Ctrl+Shift+P');
      assert.equal(shortcutLabel('chat-ask', platform), 'Alt+Shift+Q');
    }
    assert.equal(shortcutLabel('go-agents'), 'G then A');
    assert.equal(shortcutLabel('shortcuts'), '?');
    assert.equal(shortcutLabel('close'), 'Esc');
    assert.equal(shortcutLabel('search-choose', 'Win32'), '↑ / ↓');
    assert.equal(shortcutLabel('search-choose', 'MacIntel'), '↑ / ↓');
  }],
  ['question mark opens once, and all typing targets keep their question marks', () => {
    const flow = keyboard();
    assert.equal(flow.press('?', { shiftKey: true }).defaultPrevented, true);
    assert.equal(flow.opened, 1);
    for (const tag of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]']) {
      const target = field(tag);
      assert.equal(isTypingTarget(target), true, tag);
      assert.equal(flow.press('?', { target }).defaultPrevented, false, tag);
    }
    const parentElement = field('textarea');
    assert.equal(isTypingTarget({ nodeType: 3, parentElement }), true);
    for (const options of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) flow.press('?', options);
    const prevented = new Event('keydown', { cancelable: true });
    Object.defineProperty(prevented, 'key', { value: '?' }); prevented.preventDefault(); flow.document.dispatchEvent(prevented);
    flow.modal(true); flow.press('?');
    assert.equal(flow.opened, 1);
    flow.dispose(); flow.modal(false); flow.press('?'); assert.equal(flow.opened, 1);
  }],
  ['g a navigates only as an unmodified timely sequence and resets across fields, clicks and blur', () => {
    const flow = keyboard();
    flow.press('g'); assert.equal(flow.press('a').defaultPrevented, true);
    assert.deepEqual(flow.navigated, ['/agents/']);
    flow.press('a'); flow.press('g'); flow.tick(1001); flow.press('a');
    flow.press('g'); flow.press('x'); flow.press('a');
    flow.press('g'); flow.press('a', { target: field('input') }); flow.press('a');
    flow.press('g', { ctrlKey: true }); flow.press('a');
    flow.press('g'); flow.document.dispatchEvent(new Event('pointerdown')); flow.press('a');
    flow.press('g'); flow.window.dispatchEvent(new Event('blur')); flow.press('a');
    flow.press('g'); flow.modal(true); flow.press('a'); flow.modal(false); flow.press('a');
    assert.equal(flow.navigated.length, 1);
    flow.dispose();
  }],
  ['existing shortcuts match registry keys and slash preserves Chat input and open dialogs', () => {
    assert.equal(promptShortcut({ key: 'P', ctrlKey: true, shiftKey: true }), true);
    assert.equal(historyShortcut({ key: 'k', metaKey: true }), 'search');
    assert.equal(historyShortcut({ key: 'E', ctrlKey: true, shiftKey: true }), 'export');
    assert.equal(matchesShortcut({ key: 'œ', code: 'KeyQ', altKey: true, shiftKey: true }, 'chat-ask'), true);
    assert.equal(isSearchShortcut({ key: '/' }, { pathname: '/harness/' }), false); // Chat keeps / for itself
    for (const path of ['/agents/', '/']) {
      assert.equal(isSearchShortcut({ key: '/' }, { pathname: path }), true);
      assert.equal(isSearchShortcut({ key: '/' }, { pathname: path, editable: true }), false);
      assert.equal(isSearchShortcut({ key: '/' }, { pathname: path, dialogOpen: true }), false);
    }
    for (const options of [{ repeat: true }, { isComposing: true }, { altKey: true }, { defaultPrevented: true }]) {
      assert.equal(promptShortcut({ key: 'P', ctrlKey: true, shiftKey: true, ...options }), false);
    }
  }],
  ['shared Chat controls take registry attributes, including send and newline on the composer', () => {
    const control = () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
    const model = control(), prompts = control(), composer = control();
    const controls = new Map([[getShortcut('chat-model').selector, model], [getShortcut('chat-prompts').selector, prompts], ['#harness-input', composer]]);
    applyChatShortcutAttributes({ querySelectorAll: selector => [controls.get(selector)] });
    assert.equal(model.attributes['aria-keyshortcuts'], shortcutAria('chat-model'));
    assert.equal(prompts.attributes['aria-keyshortcuts'], shortcutAria('chat-prompts'));
    assert.equal(composer.attributes['aria-keyshortcuts'], 'Enter Shift+Enter');
  }],
  ['palette and footer open the same sheet without sign-in, API routes or persistence', () => {
    let count = 0;
    const unregister = registerCommand('keyboard-shortcuts', () => count++);
    try {
      const row = commandActions({ pathname: '/agents/', ready: ['keyboard-shortcuts'] }, { signedIn: false }).find(row => row.command === 'keyboard-shortcuts');
      assert.equal(row.title, 'Keyboard shortcuts'); assert.equal(row.disabled, false); assert.ok(!row.signIn);
      assert.equal(runPageCommand(row.command), true); assert.equal(count, 1);
    } finally { unregister(); }
    assert.equal(runPageCommand('keyboard-shortcuts'), false);
    assert.match(read('components/Footer.jsx'), /<KeyboardShortcutsButton\/>/);
    assert.match(read('components/shortcuts/KeyboardShortcutsButton.jsx'), /onClick=\{openKeyboardShortcuts\}/);
    assert.match(read('components/shortcuts/KeyboardShortcuts.jsx'), /registerCommand\('keyboard-shortcuts', show\)/);
    assert.match(read('app/template.jsx'), /<KeyboardShortcuts\/>/);
    assert.match(read('app/docs/page.jsx'), /<KeyboardShortcutsDocs \/>/);
    assert.match(read('components/DocsFeatureIndex.jsx'), /sections.push\(\["keyboard-shortcuts"/);
    assert.match(read('lib/site-map.js'), /TASKS.push\(.*'keyboard-shortcuts'/);
  }],
];
