import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const css = read('app/globals.css');
const arena = read('components/Arena.module.css');
const rule = (source, selector) => source.slice(source.indexOf(selector + '{') + selector.length + 1).split('}')[0];

function jsxFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jsxFiles(file) : file.endsWith('.jsx') ? [file] : [];
  });
}

test('only the landing Hero carries the dark hero attribute', () => {
  const root = new URL('../', import.meta.url).pathname;
  const marked = ['app', 'components'].flatMap(dir => jsxFiles(path.join(root, dir)))
    .filter(file => /<[^>]*\sdata-dark-hero(?:\s|=|>)/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file));
  assert.deepEqual(marked, ['components/Hero.jsx']);
});

test('the fixed header is opaque ink in every tone, with light identity and controls', () => {
  const header = rule(css, '.site-header');
  assert.match(header, /background:var\(--ink\)/);
  assert.match(header, /color:var\(--paper\)/);
  assert.match(header, /border-bottom:1px solid var\(--line-dark\)/);
  assert.doesNotMatch(css, /\.site-header\[data-tone[^}]*\{[^}]*(?:background|color)/);
  assert.match(read('components/Logo.jsx'), /function Wordmark[\s\S]*?fill="currentColor"/);
  assert.match(rule(css, '.site-header .ar-button:not(.secondary)'), /--bg:var\(--paper\);--fg:var\(--ink\)/);
  assert.match(rule(css, '.site-header .ar-button.secondary'), /--fg:var\(--paper\);--fill:var\(--paper\);--fill-fg:var\(--ink\)/);
  assert.match(rule(css, '.site-header :focus-visible'), /outline-color:var\(--signal\)/);
  // Clipped buttons need an inset focus cue as well as the outer outline.
  assert.match(rule(css, '.site-header .ar-button:focus-visible'), /box-shadow:inset 0 0 0 2px var\(--ink\)/);
  assert.match(css, /\.site-header\[data-hidden=true\]:not\(\.expanded\)/);
  assert.match(read('components/UI.jsx'), /setHidden\(y>last&&y>480\)/);
  assert.match(read('components/UI.jsx'), /aria-expanded=\{open\}/);
});

test('Arena and the Harness outer surface are paper and retain header clearance', () => {
  assert.match(read('components/Arena.jsx'), /<section className=\{styles.arena\} aria-labelledby="arena-title">/);
  assert.match(arena, /\.arena \{[^}]*background: var\(--paper\); color: var\(--ink\)/);
  assert.doesNotMatch(arena, /--muted-dark|--line-dark|rgba\(245, 245, 240|#ff8f93|color: var\(--paper\)/);
  assert.match(arena, /padding: calc\(var\(--header\)/);
  assert.match(read('components/Harness.module.css'), /height: 100svh; padding-top: var\(--header\); background: var\(--paper\)/);
});

const rgb = name => css.match(new RegExp(`--${name}:#([a-f0-9]{6})`))[1].match(/../g).map(v => parseInt(v, 16));
const blend = (top, bottom, alpha) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('Arena active text clears AA on paper, nested overlays and picker states', () => {
  const paper = rgb('paper'), ink = rgb('ink'), signal = rgb('signal');
  assert.match(arena, /--arena-signal: color-mix\(in srgb, var\(--signal-deep\) 85%, var\(--ink\)\)/);
  const colors = [ink, rgb('muted'), blend(rgb('signal-deep'), ink, .85), [150, 22, 27]];
  const lane = blend(ink, paper, .03);
  const surfaces = [paper, rgb('paper-2'), blend(ink, lane, .08), blend(ink, lane, .03), blend(signal, rgb('paper-2'), .12), blend(signal, paper, .14)];
  for (const fg of colors) for (const bg of surfaces) assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
  assert.ok(contrast(ink, signal) >= 4.5, 'winner badges');
  assert.ok(contrast(paper, ink) >= 4.5, 'header');
});
