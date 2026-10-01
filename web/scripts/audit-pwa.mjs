import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { shellRoute } from '../lib/harness-sw.js';

export function auditPwa(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'AnyRoute');
  assert.equal(manifest.short_name, 'AnyRoute');
  assert.equal(manifest.start_url, '/harness/');
  assert.equal(manifest.id, '/harness/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#0b0c0b');
  assert.equal(manifest.background_color, '#f5f5f0');
  for (const size of [192, 512]) for (const purpose of ['any', 'maskable']) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}` && icon.purpose === purpose);
    assert(icon && icon.type === 'image/png', `Missing ${size} ${purpose} icon`);
    const bytes = fs.readFileSync(path.join(root, icon.src));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const html = fs.readFileSync(path.join(root, 'harness/index.html'), 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*href="\/pwa\/apple-touch-icon.png"/);
  assert.match(html, /viewport-fit=cover/);
  const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const match = worker.match(/\ncreateShellWorker\((\{"assets":.*\}), self\);/);
  assert(match, 'Missing build-owned shell list');
  const { assets, cacheName } = JSON.parse(match[1]);
  assert.match(cacheName, /^anyroute-shell-[a-f0-9]{24}$/);
  for (const [url, digest] of Object.entries(assets)) {
    assert(shellRoute(new Request('https://shell.invalid' + url), 'https://shell.invalid', assets));
    assert(url === '/harness/' || url === '/offline.html' || url === '/manifest.webmanifest' ||
      /^\/pwa\/(?:offline\.css|(?:icon-(?:192|512)(?:-maskable)?|apple-touch-icon)\.png)$/.test(url) ||
      /^\/_next\/static\/(?:chunks|media)\/[^?]+\.(?:js|css|woff2?|png|svg)$/.test(url) ||
      /^\/brand\/anyroute-(?:mark\.svg|symbol\.png)$/.test(url), `Unexpected cached path ${url}`);
    const file = path.join(root, url === '/harness/' ? 'harness/index.html' : url);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, `Changed shell file ${url}`);
  }
  for (const match of html.matchAll(/(?:href|src)="(\/_next\/static\/[^"?]+)"/g)) assert(assets[match[1]], `Uncached shell dependency ${match[1]}`);
  for (const prefix of ['/api/', '/trpc/', '/v1/']) assert.equal(shellRoute(new Request('https://shell.invalid' + prefix), 'https://shell.invalid', assets), null);
  assert(assets['/offline.html'] && assets['/pwa/offline.css'], 'Missing offline page');
  return Object.keys(assets).length;
}
