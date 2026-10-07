import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { THEME_KEY, THEME_SCRIPT, applyTheme, readTheme, saveTheme } from '../lib/theme.js';
import { auditTheme, THEME_HASH } from '../scripts/audit-theme.mjs';
const css = readFileSync(new URL('../app/theme-colors.css', import.meta.url), 'utf8');
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const blocks = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/g)].map(m => tokens(m[1]));
const root = () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; } });
const storage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
test('every light colour token has explicit and device dark values', () => {
  const original = tokens(readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8').split('*,*::before')[0]);
  const colours = Object.keys(original).filter(k => /^(#|rgba?\()/.test(original[k]));
  assert.equal(blocks.length, 3);
  for (const key of colours) assert(key in blocks[0], `Missing light ${key}`);
  assert.deepEqual(Object.keys(blocks[1]).sort(), Object.keys(blocks[0]).sort());
  assert.deepEqual(blocks[1], blocks[2]);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
  assert.equal(blocks[0].signal, blocks[1].signal);
  assert.equal(blocks[0].mark, blocks[1].mark);
});
function luminance(hex) {
  const rgb = hex.replace('#', '').match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
test('text token pairs meet WCAG AA in light and dark (including status, brand and code)', () => {
  const pairs = [];
  for (const background of ['paper', 'paper-2', 'paper-3', 'white']) {
    for (const foreground of ['ink', 'muted', 'signal-deep', 'danger', 'warn']) pairs.push([foreground, background]);
  }
  pairs.push(['signal-deep', 'signal-tint'], ['danger-text', 'danger-surface'], ['warn-text', 'warn-surface'], ['success-text', 'success-surface'], ['neutral-text', 'neutral-surface'], ['night', 'signal'], ['mark', 'qr-paper']);
  for (const background of ['night', 'ink-2', 'ink-3', 'ink-4']) {
    for (const foreground of ['bone', 'muted-dark', 'signal', 'code-blue', 'code-green', 'code-amber']) pairs.push([foreground, background]);
  }
  for (const [mode, palette] of [['light', blocks[0]], ['dark', blocks[1]]]) {
    for (const [foreground, background] of pairs) {
      const ratio = contrast(palette[foreground], palette[background]);
      assert(ratio >= 4.5, `${mode} ${foreground}/${background}: ${ratio.toFixed(2)} < 4.5`);
    }
  }
});
test('three-way choices persist and device removes an explicit override', () => {
  const r = root(), s = storage();
  assert.equal(readTheme(s), 'device');
  for (const choice of ['light', 'dark']) {
    assert.equal(saveTheme(r, s, choice), choice);
    assert.equal(readTheme(s), choice);
    assert.equal(r.attributes['data-theme'], choice);
  }
  saveTheme(r, s, 'device');
  assert.equal(s.getItem(THEME_KEY), undefined);
  assert.equal(r.attributes['data-theme'], undefined);
  assert.equal(applyTheme(r, 'invalid'), 'device');
});
test('storage denial still applies a choice without throwing', () => {
  const r = root(), denied = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  assert.equal(readTheme(denied), 'device');
  saveTheme(r, denied, 'dark'); assert.equal(r.attributes['data-theme'], 'dark');
  saveTheme(r, denied, 'device'); assert.equal(r.attributes['data-theme'], undefined);
});
test('startup script handles saved, absent, invalid and blocked storage before body', () => {
  for (const value of ['light', 'dark', null, 'invalid']) {
    const r = root(); runInNewContext(THEME_SCRIPT, { document: { documentElement: r }, localStorage: { getItem: () => value } });
    assert.equal(r.attributes['data-theme'], ['light', 'dark'].includes(value) ? value : undefined);
  }
  const r = root(); runInNewContext(THEME_SCRIPT, { document: { documentElement: r }, get localStorage() { throw Error(); } });
  assert.equal(r.attributes['data-theme'], undefined);
  const layout = readFileSync(new URL('../app/layout.jsx', import.meta.url), 'utf8');
  assert.match(layout, /<head><ThemeScript\/>/);
  assert.match(layout, /suppressHydrationWarning/);
});
test('export audit requires exact head script bytes and rejects missing or late scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyroute-theme-'));
  try {
    const file = join(dir, 'index.html'), script = `<script id="anyroute-theme">${THEME_SCRIPT}</script>`;
    writeFileSync(file, `<html><head>${script}</head><body></body></html>`);
    assert.equal(auditTheme(dir).length, 1);
    assert.match(THEME_HASH, /^'sha256-/);
    writeFileSync(file, `<html><head></head><body>${script}</body></html>`);
    assert.throws(() => auditTheme(dir), /before body/);
    writeFileSync(file, '<html><head></head><body></body></html>');
    assert.throws(() => auditTheme(dir), /One appearance script/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('appearance controls are present in account menu and footer, with labelled native keyboard selection', () => {
  for (const file of ['../components/Footer.jsx', '../components/nav/AccountDrawer.jsx']) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /<ThemeToggle\/>/);
  const component = readFileSync(new URL('../components/ThemeToggle.jsx', import.meta.url), 'utf8');
  assert.match(component, /htmlFor=\{id\}/); assert.match(component, /<select id=\{id\}/);
  for (const label of ['Light', 'Dark', 'Match device']) assert(component.includes(`>${label}</option>`));
  assert(component.includes("window.addEventListener('storage'"));
});

test('offline build uses the same palette and script, including idempotent rebuilds', async () => {
  const { buildOfflineTheme } = await import('../scripts/build-theme.mjs');
  const { mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'anyroute-theme-offline-'));
  try {
    mkdirSync(join(dir, 'pwa'));
    writeFileSync(join(dir, 'offline.html'), '<html><head></head><body></body></html>');
    writeFileSync(join(dir, 'pwa/offline.css'), 'body{color:var(--ink)}\n');
    buildOfflineTheme(dir); buildOfflineTheme(dir);
    assert.equal(auditTheme(dir).length, 1);
    const offline = readFileSync(join(dir, 'pwa/offline.css'), 'utf8');
    assert.equal(offline.split('/* C126: offline palette */').length, 2);
    assert(offline.endsWith(css));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mounting another control preserves the current choice when browser storage is denied', () => {
  const component = readFileSync(new URL('../components/ThemeToggle.jsx', import.meta.url), 'utf8');
  const effect = component.split('useEffect(() => {')[1].split('return () =>')[0];
  assert.doesNotMatch(effect, /readTheme|localStorage/);
  assert.match(effect, /getAttribute\('data-theme'\)/);
  assert.match(effect, /MutationObserver\(sync\)/);
  assert.match(effect, /themeChoice\(event.newValue\)/);
});

test('colour literals are confined to the palette and retained shared-file rules have token overrides', async () => {
  const { readdirSync } = await import('node:fs');
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of [...walk(new URL('../app', import.meta.url).pathname), ...walk(new URL('../components', import.meta.url).pathname)].filter(f => f.endsWith('.css'))) {
    if (file.endsWith('/theme-colors.css')) continue;
    let source = readFileSync(file, 'utf8');
    if (file.endsWith('/globals.css')) source = source.split('*,*::before')[1];
    if (file.endsWith('/account/Inbox.module.css') || file.endsWith('/nav/AccountStrip.module.css')) source = source.split('/* C126: appearance token overrides. */')[1];
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b|rgba?\([\d\s.,]+\)/i, `Hard-coded colour: ${file}`);
  }
});

test('button hover text keeps a contrasting invariant foreground in dark brand sections', () => {
  const globals = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(globals, /\.site-footer \.ar-button\.secondary\{--fill:var\(--bone\);--fill-fg:var\(--night\)\}/);
  for (const palette of blocks.slice(0, 2)) assert(contrast(palette.bone, palette.night) >= 4.5);
});

test('every directly paired text and surface token in CSS meets AA in both themes', async () => {
  const { readdirSync } = await import('node:fs');
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  const files = [...walk(new URL('../app', import.meta.url).pathname), ...walk(new URL('../components', import.meta.url).pathname)].filter(file => file.endsWith('.css') && !file.endsWith('/theme-colors.css'));
  let checked = 0;
  for (const file of files) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Later additive overrides replace earlier shared-file rules, as in the browser cascade.
    const rules = new Map([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]]));
    for (const [selector, rule] of rules) {
      const foreground = /(?<![-\w])color:\s*var\(--([\w-]+)\)/.exec(rule)?.[1];
      const background = /(?<![-\w])background(?:-color)?:\s*var\(--([\w-]+)\)/.exec(rule)?.[1];
      if (!foreground || !background) continue;
      for (const [mode, palette] of [['light', blocks[0]], ['dark', blocks[1]]]) {
        const fg = palette[foreground], bg = palette[background];
        // Component-local aliases, gradients and inherited backgrounds are covered separately by the token-pair test.
        if (!/^#[\da-f]{6}$/i.test(fg) || !/^#[\da-f]{6}$/i.test(bg)) continue;
        const ratio = contrast(fg, bg); checked++;
        assert(ratio >= 4.5, `${file} ${selector} ${mode} ${foreground}/${background}: ${ratio.toFixed(2)}`);
      }
    }
  }
  assert(checked >= 400, `Unexpectedly few CSS pairs checked: ${checked}`);
});
