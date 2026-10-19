import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ASK_SHORTCUT, bindAskAboutThis, insertQuote, quotePosition, quoteSelection, selectedReply } from '../lib/ask-about-this.js';
import { shortcutLabel } from '../lib/keyboard-shortcuts.js'; // K193
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const rect = { left: 50, right: 180, top: 100, bottom: 120, width: 130, height: 20 };

function surface() {
  const listeners = () => {
    const map = new Map();
    return { map, addEventListener(type, handler) { map.set(type, handler); }, removeEventListener(type) { map.delete(type); }, fire(type, event = {}) { map.get(type)?.(event); } };
  };
  const reply = { contains: node => node === textNode || node === codeNode };
  const textNode = { nodeType: 3, parentElement: { closest: selector => selector === '[data-ask-about-reply]' ? reply : null } };
  const codeNode = { ...textNode };
  let connected = true;
  const root = { contains: node => connected && node === reply };
  const selection = { anchorNode: textNode, focusNode: codeNode, rangeCount: 1, isCollapsed: false, toString: () => 'Selected answer', getRangeAt: () => ({ startContainer: textNode, endContainer: codeNode, getClientRects: () => [rect] }), removeAllRanges() { this.isCollapsed = true; } };
  const document = listeners();
  let queued;
  const window = { ...listeners(), innerWidth: 375, innerHeight: 667, getSelection: () => selection, requestAnimationFrame: fn => { queued = fn; return 1; }, cancelAnimationFrame: () => { queued = null; } };
  const input = { isConnected: true, value: 'Follow up', selectionStart: 0, focus: () => { input.focused = true; }, setSelectionRange: (a, b) => { input.caret = [a, b]; } };
  const positions = [], drafts = [];
  const control = bindAskAboutThis({ document, window, root, input, setDraft: draft => { drafts.push(draft); input.value = draft; }, onChange: position => positions.push(position) });
  return { control, root, selection, document, window, input, positions, drafts, textNode, codeNode, disconnect: () => { connected = false; }, flush: () => queued?.() };
}

test('quotes plain text, multiline paragraphs, blank lines and code without interpreting it', () => {
  assert.equal(quoteSelection('  hello  '), '> hello');
  assert.equal(quoteSelection('a\r\nb\r\nc'), '> a\n> b\n> c');
  assert.equal(quoteSelection('a\n\nb'), '> a\n> \n> b');
  assert.equal(quoteSelection('const a = "<tag>";\n  return a;'), '> const a = "<tag>";\n>   return a;');
  assert.equal(quoteSelection(' \n '), '');
});
test('long selections are capped at 1,500 characters including ellipsis without breaking emoji', () => {
  assert.equal(quoteSelection('x'.repeat(1500)), '> ' + 'x'.repeat(1500));
  assert.equal(quoteSelection('x'.repeat(1501)), '> ' + 'x'.repeat(1499) + '…');
  assert.equal(quoteSelection('😀'.repeat(1600)), '> ' + '😀'.repeat(1499) + '…');
});
test('inserts above the cursor line, preserves existing draft, selection and follow-up caret', () => {
  assert.deepEqual(insertQuote('', 'a'), { text: '> a\n\n', cursor: 5 });
  assert.deepEqual(insertQuote('first\nfollow up', 'a\nb', 9), { text: 'first\n> a\n> b\n\nfollow up', cursor: 18 });
  assert.deepEqual(insertQuote('\nrest', 'a', 0), { text: '> a\n\n\nrest', cursor: 5 });
  assert.deepEqual(insertQuote('draft', ' ', 2), { text: 'draft', cursor: 2 });
});
test('only a nonempty selection inside one connected assistant reply is eligible', () => {
  const s = surface();
  assert.equal(selectedReply(s.selection, s.root).text, 'Selected answer');
  for (const patch of [{ isCollapsed: true }, { rangeCount: 0 }, { rangeCount: 2 }, { focusNode: {} }, { anchorNode: {} }, { toString: () => ' \n ' }]) {
    assert.equal(selectedReply({ ...s.selection, ...patch }, s.root), null);
  }
  const button = { nodeType: 1, closest: selector => selector === '[data-ask-about-reply]' ? s.textNode.parentElement.closest(selector) : {} };
  assert.equal(selectedReply({ ...s.selection, anchorNode: button }, s.root), null);
  s.disconnect();
  assert.equal(selectedReply(s.selection, s.root), null);
  s.control.dispose();
});
test('code selection uses native plain selection text and keeps indentation', () => {
  const s = surface();
  s.selection.toString = () => 'function run() {\n  return 42;\n}';
  assert.equal(s.control.ask(), true);
  assert.equal(s.drafts[0], '> function run() {\n>   return 42;\n> }\n\nFollow up');
  s.flush();
  assert.equal(s.input.focused, true);
  assert.equal(s.input.caret[0], s.drafts[0].indexOf('Follow up'));
  assert.equal(s.positions.at(-1), null);
  assert.equal(s.control.ask(), false);
  s.control.dispose();
});
test('compare selection quotes into the supplied focused composer without changing another draft', () => {
  const focused = surface(), other = surface();
  focused.input.value = 'Focused follow-up';
  focused.control.ask();
  assert.equal(focused.input.value, '> Selected answer\n\nFocused follow-up');
  assert.equal(other.input.value, 'Follow up');
  assert.deepEqual(other.drafts, []);
  assert.match(read('components/Harness.jsx'), /<AskAboutThis input=\{input\} setDraft=\{setDraft\} scope=\{focusLane\?\.id\}/);
  focused.control.dispose(); other.control.dispose();
});
test('selection changes and touch pointer release show the button; clearing selection hides it', () => {
  const s = surface();
  assert.deepEqual(s.positions.at(-1), { left: 50, top: 132 });
  s.document.fire('pointerup', { pointerType: 'touch' });
  assert.deepEqual(s.positions.at(-1), { left: 50, top: 132 });
  s.selection.isCollapsed = true;
  s.document.fire('selectionchange');
  assert.equal(s.positions.at(-1), null);
  s.control.dispose();
});
test('shortcut inserts the same quote; unrelated keys, editable targets and IME are left alone', () => {
  const s = surface(); let prevented = 0;
  const shortcut = { altKey: true, shiftKey: true, code: 'KeyQ', preventDefault: () => prevented++ };
  s.document.fire('keydown', { ...shortcut, code: 'KeyK' });
  s.document.fire('keydown', { ...shortcut, isComposing: true });
  s.document.fire('keydown', { ...shortcut, target: { nodeType: 1, closest: () => ({}) } });
  assert.equal(s.drafts.length, 0);
  s.document.fire('keydown', shortcut);
  assert.equal(prevented, 1);
  assert.equal(s.drafts[0], '> Selected answer\n\nFollow up');
  s.control.dispose();
});
test('Escape dismisses until a fresh selection and activation rejects detached content', () => {
  const s = surface();
  s.document.fire('keydown', { key: 'Escape' });
  s.window.fire('scroll');
  assert.equal(s.positions.at(-1), null);
  assert.equal(s.control.ask(), false);
  s.document.fire('selectionchange');
  assert.ok(s.positions.at(-1));
  s.disconnect();
  assert.equal(s.control.ask(), false);
  s.control.dispose();
  assert.equal(s.document.map.size + s.window.map.size, 0);
});
test('floating action fits 375 px and the visual viewport; offscreen selections hide it', () => {
  assert.deepEqual(quotePosition({ ...rect, left: 360, bottom: 660 }, { width: 375, height: 667 }), { left: 207, top: 611 });
  assert.deepEqual(quotePosition(rect, { width: 375, height: 250, offsetTop: 80 }), { left: 50, top: 132 });
  assert.equal(quotePosition({ ...rect, top: 700, bottom: 720 }, { width: 375, height: 667 }), null);
});
test('button is hidden by default, has an accessible label and shortcut, and preserves touch selection', () => {
  const source = read('components/harness/AskAboutThis.jsx');
  const transpiled = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement"}}}).transformSync(await Bun.stdin.text()));'], { input: source, encoding: 'utf8' });
  const Button = new Function('React', 'ASK_SHORTCUT', 's', 'useShortcutLabel', transpiled.replace(/^import .*;\n/gm, '').replace(/export default function/g, 'function').replace(/export function/g, 'function') + '\nreturn AskAboutButton;')({ createElement }, ASK_SHORTCUT, { action: 'action' }, id => shortcutLabel(id)); // K193
  assert.equal(renderToStaticMarkup(createElement(Button, {})), '');
  const html = renderToStaticMarkup(createElement(Button, { position: { left: 8, top: 8 } }));
  assert.match(html, /type="button"/);
  assert.match(html, /aria-label="Ask about selected text"/);
  assert.match(html, /aria-keyshortcuts="Alt\+Shift\+Q"/);
  assert.match(html, /title="Ask about this \(Alt\+Shift\+Q\)"/);
  assert.match(source, /onPointerDown=\{event => event.preventDefault\(\)\}/);
  assert.match(source, /if \(blocked \|\| !composer\) return/);
  assert.match(read('components/Harness.jsx'), /blocked=\{!!\(signin \|\| editing \|\| palette \|\| sheet\)\}/);
});
test('docs, search and inventory describe message handling with no new network calls or storage', () => {
  assert.match(read('components/AskAboutThisDocs.jsx'), /id="ask-about-this"/);
  assert.match(read('app/docs/page.jsx'), /<AskAboutThisDocs \/>/);
  assert.match(read('components/DocsFeatureIndex.jsx'), /sections.push\(\["ask-about-this"/);
  assert.match(read('lib/site-map.js'), /task\('ask-about-this', 'chat'/);
  assert.doesNotMatch(read('lib/ask-about-this.js') + read('components/harness/AskAboutThis.jsx'), /fetch\(|localStorage|sessionStorage|indexedDB|api\(/);
});
