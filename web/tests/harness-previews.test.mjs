import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as previews from '../lib/harness-previews.js';
import { parseBlocks, parseInline } from '../lib/markdown.js';

function component(file, names, bindings = {}) {
  const input = readFileSync(new URL(`../components/${file}.jsx`, import.meta.url), 'utf8');
  const output = execFileSync('bun', ['-e', 'process.stdout.write(new Bun.Transpiler({loader:"jsx",target:"node",tsconfig:{compilerOptions:{jsx:"react",jsxFactory:"React.createElement",jsxFragmentFactory:"React.Fragment"}}}).transformSync(await Bun.stdin.text()));'], { input, encoding: 'utf8' });
  const scope = { React, ...React, s: new Proxy({}, { get: (_, key) => key }), renderToStaticMarkup, ...previews, ...bindings };
  return new Function(...Object.keys(scope), output.replace(/^import .*;\n/gm, '').replace(/export default memo\(Markdown\);/, '').replace(/export default function /g, 'function ').replace(/export function /g, 'function ') + `\nreturn {${names.join(',')}};`)(...Object.values(scope));
}
const CopyButton = ({ text }) => React.createElement('button', { 'data-copy': text }, 'Copy');
const highlight = (text) => text;
const { Markdown } = component('Markdown', ['Markdown'], { parseBlocks, parseInline, CopyButton, highlight });
const { CodeBlock, PreviewFrame, PreviewDialog } = component('harness/CodeBlock', ['CodeBlock', 'PreviewFrame', 'PreviewDialog'], { Markdown, CopyButton, highlight });
const { ReplyMarkdown } = component('harness/ReplyMarkdown', ['ReplyMarkdown'], { Markdown, CodeBlock });
const render = (C, props) => renderToStaticMarkup(React.createElement(C, props));
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const innerDoc = (frame) => decode(frame.srcDoc.match(/ srcdoc="([^"]*)"/)[1]);
const walk = (element) => !element || typeof element !== 'object' ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(walk)];

// Assert exact attributes/policies, including attempts to enable scripts on other types.
test('each preview has two opaque sandbox frames and the required CSP in both documents', () => {
  for (const lang of ['html', 'svg', 'markdown', 'md']) for (const runScripts of [false, true]) {
    const enabled = lang === 'html' && runScripts;
    const expected = `default-src 'none'; img-src data:; style-src 'unsafe-inline';${enabled ? " script-src 'unsafe-inline';" : ''} base-uri 'none'; form-action 'none';`;
    const frame = previews.previewDocument(lang, '<h1>Reply</h1>', runScripts, '<p>Reply</p>');
    assert.equal(frame.sandbox, enabled ? 'allow-scripts' : '');
    assert.equal(frame.csp, expected);
    assert.ok(frame.srcDoc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'));
    assert.equal(decode(frame.srcDoc.match(/Content-Security-Policy" content="([^"]*)"/)[1]), expected);
    assert.match(frame.srcDoc, new RegExp(`sandbox="${enabled ? 'allow-scripts' : ''}"`));
    assert.equal(decode(innerDoc(frame).match(/Content-Security-Policy" content="([^"]*)"/)[1]), expected);
    const html = decode(render(PreviewFrame, { lang, text: '# Reply', runScripts }));
    assert.match(html, new RegExp(`sandbox="${enabled ? 'allow-scripts' : ''}"`));
    assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
    assert.doesNotMatch(html, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    // A srcdoc frame has no src fetch. Only the nested SVG img uses a data URL.
    assert.doesNotMatch(frame.srcDoc.match(/<iframe ([\s\S]*?)><\/iframe>/)[1].replace(/srcdoc="[^"]*"/, ''), /\bsrc=/);
  }
});

test('untrusted HTML cannot escape the inner srcdoc or precede either policy', () => {
  const attack = '</body></html><meta http-equiv="refresh" content="0;url=https://example.invalid/"><script>top.location="https://example.invalid/"</script><img src="https://example.invalid/a"><style>@import "https://example.invalid/font";</style>';
  const frame = previews.previewDocument('html', attack, true);
  assert.equal((frame.srcDoc.match(/<iframe /g) || []).length, 1);
  assert.equal((frame.srcDoc.match(/<meta http-equiv=/g) || []).length, 1);
  assert.doesNotMatch(frame.srcDoc, /<script>|<img /);
  assert.ok(innerDoc(frame).includes(attack));
  assert.ok(innerDoc(frame).indexOf('Content-Security-Policy') < innerDoc(frame).indexOf(attack));
  assert.match(frame.srcDoc, /default-src &#39;none&#39;/); // outer frame navigation restriction
});

test('SVG is encoded as an image, never inline DOM or script markup', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>content</div></foreignObject></svg>';
  const inner = innerDoc(previews.previewDocument('svg', svg, true));
  assert.match(inner, /<img alt="SVG preview" src="data:image\/svg\+xml,/);
  assert.doesNotMatch(inner, /<svg|<script|<foreignObject/);
  assert.equal(decodeURIComponent(inner.match(/src="data:image\/svg\+xml,([^"]*)"/)[1]), svg);
});

test('Markdown preview uses the existing safe component, without raw HTML injection', () => {
  const text = '# Title\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n**Strong**\n\n```html\n<h1>Text</h1>\n```';
  let markdown = null, effect;
  const { PreviewFrame: Frame } = component('harness/CodeBlock', ['PreviewFrame'], { Markdown, CopyButton, highlight, useState: () => [markdown, (value) => { markdown = value; }], useEffect: (fn) => { effect = fn; }, useMemo: (fn) => fn() });
  Frame({ lang: 'md', text, runScripts: true });
  effect();
  const frameHtml = decode(renderToStaticMarkup(Frame({ lang: 'md', text, runScripts: true })));
  // Unwrap the React attribute and then the outer srcdoc attribute.
  const outer = frameHtml.match(/srcDoc="([\s\S]*)" referrerPolicy=/i);
  assert.ok(outer);
  const doc = innerDoc({ srcDoc: outer[1] });
  assert.match(doc, /<h3>Title<\/h3>/);
  assert.match(doc, /<strong>Strong<\/strong>/);
  assert.doesNotMatch(doc, /<script>|href="javascript:|script-src/);
  assert.match(doc, /&lt;script&gt;/);
});

test('download extensions are normalized and unknown labels cannot become paths', () => {
  for (const [language, extension] of [['HTML', 'html'], ['svg', 'svg'], ['md', 'md'], ['markdown', 'md'], ['javascript', 'js'], ['typescript', 'ts'], ['python', 'py'], ['json', 'json'], ['shell', 'sh'], ['c++', 'cpp'], ['c#', 'cs'], ['solidity', 'sol'], ['', 'txt'], ['../../html', 'txt']]) assert.equal(previews.codeFilename(language), `reply.${extension}`);
  assert.equal(previews.previewType(' HTML '), 'html');
  assert.equal(previews.previewType('javascript'), null);
  assert.throws(() => previews.previewDocument('js', 'code'), TypeError);
});

test('every fence, including quoted and unfinished blocks, has language, Copy and Download', () => {
  const html = render(ReplyMarkdown, { text: '```js\nconst x = 1;\n```\n\n> ```svg\n> <svg/>\n> ```\n\n~~~\nplain' });
  assert.equal((html.match(/>Copy<\/button>/g) || []).length, 3);
  assert.equal((html.match(/>Download<\/button>/g) || []).length, 3);
  assert.match(html, />js<\/span>/); assert.match(html, />svg<\/span>/); assert.match(html, />text<\/span>/);
  assert.equal((html.match(/>Preview<\/button>/g) || []).length, 1);
  assert.doesNotMatch(html, /<iframe|Run scripts/);
});

test('script permission defaults off, requires the explicit toggle, and expires when text changes', () => {
  const states = [true, false, false, null];
  const { CodeBlock: Interactive } = component('harness/CodeBlock', ['CodeBlock'], { Markdown, CopyButton, highlight, useState: (initial) => { const i = index++; return [states[i] ?? initial, (value) => { states[i] = value; }]; }, useId: () => 'preview-id' });
  let index = 0;
  const block = (text) => { index = 0; return Interactive({ lang: 'html', text }); };
  const toggle = (tree) => walk(tree).find((e) => e.type === 'button' && e.props.children === 'Run scripts');
  const frame = (tree) => walk(tree).find((e) => e.type?.name === 'PreviewFrame');
  assert.equal(frame(block('reply')).props.runScripts, false);
  toggle(block('reply')).props.onClick();
  assert.equal(frame(block('reply')).props.runScripts, true);
  assert.equal(frame(block('new reply')).props.runScripts, false);
  toggle(block('reply')).props.onClick();
  assert.equal(frame(block('reply')).props.runScripts, false);
});

test('preview close clears script consent and full screen has native dialog keyboard behavior', () => {
  const states = [true, true, false, 'reply']; let index = 0;
  const { CodeBlock: Interactive } = component('harness/CodeBlock', ['CodeBlock'], { Markdown, CopyButton, highlight, useState: (initial) => { const i = index++; return [states[i] ?? initial, (value) => { states[i] = value; }]; }, useId: () => 'preview-id' });
  const tree = Interactive({ lang: 'html', text: 'reply' });
  const open = walk(tree).find((e) => e.type === 'button' && e.props.children === 'Open full screen');
  assert.ok(open); open.props.onClick(); assert.equal(states[2], true);
  const preview = walk(tree).find((e) => e.type === 'button' && e.props.children === 'Preview');
  preview.props.onClick(); assert.equal(states[0], false); assert.equal(states[1], false); assert.equal(states[3], null);
  let closed = 0, prevented = 0;
  const { PreviewDialog: Dialog } = component('harness/CodeBlock', ['PreviewDialog'], { Markdown, CopyButton, highlight, useEffect() {}, useRef: () => ({ current: null }), useId: () => 'preview-title' });
  const dialog = Dialog({ onClose: () => { closed++; }, children: 'preview' });
  assert.equal(dialog.type, 'dialog'); assert.equal(dialog.props['aria-labelledby'], 'preview-title');
  dialog.props.onCancel({ preventDefault() { prevented++; } });
  assert.equal(closed, 1); assert.equal(prevented, 1);
  assert.ok(walk(dialog).some((e) => e.type === 'button' && e.props.autoFocus));
});

test('download contains the original bytes and cleans up its temporary URL', () => {
  const events = [], anchor = { click() { events.push('click'); }, remove() { events.push('remove'); } };
  const originalDocument = globalThis.document, originalTimeout = globalThis.setTimeout;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  try {
    globalThis.document = { createElement: () => anchor, body: { append(value) { assert.equal(value, anchor); events.push('append'); } } };
    globalThis.setTimeout = (fn) => fn();
    URL.createObjectURL = (blob) => { assert.equal(blob.size, Buffer.byteLength('π\nreply')); return 'blob:reply'; };
    URL.revokeObjectURL = (url) => { assert.equal(url, 'blob:reply'); events.push('revoke'); };
    previews.downloadCode('π\nreply', 'python');
    assert.equal(anchor.download, 'reply.py'); assert.equal(anchor.href, 'blob:reply');
    assert.deepEqual(events, ['append', 'click', 'remove', 'revoke']);
  } finally {
    globalThis.document = originalDocument; globalThis.setTimeout = originalTimeout;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});
