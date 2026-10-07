import {buildOfflineTheme} from './build-theme.mjs'; // C126
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shellRoute, createShellWorker } from '../lib/harness-sw.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function buildPwa(root) {
  buildOfflineTheme(root); // C126
  const assets = {};
  const add = (url, file = path.join(root, url)) => {
    if (!fs.statSync(file).isFile()) throw new Error('Shell asset is not a file');
    assets[url] = hash(fs.readFileSync(file));
  };
  add('/harness/', path.join(root, 'harness/index.html'));
  add('/offline.html');
  add('/pwa/offline.css');
  add('/manifest.webmanifest');
  for (const entry of fs.readdirSync(path.join(root, 'pwa'))) if (entry.endsWith('.png')) add('/pwa/' + entry);
  // Include only scripts/styles referenced by the Harness HTML and their font/image dependencies.
  const html = fs.readFileSync(path.join(root, 'harness/index.html'), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="(\/_next\/static\/[^"?]+)"/g)) add(match[1]);
  for (const url of Object.keys(assets).filter(url => url.endsWith('.css'))) {
    const text = fs.readFileSync(path.join(root, url), 'utf8');
    for (const match of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const dependency = new URL(match[1], 'https://shell.invalid' + url);
      if (dependency.origin !== 'https://shell.invalid' || !dependency.pathname.startsWith('/_next/static/')) continue;
      add(dependency.pathname);
    }
  }
  // The brand mark may be used by browser chrome, independently of React.
  for (const name of ['anyroute-mark.svg', 'anyroute-symbol.png']) add('/brand/' + name);
  const sorted = Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)));
  for (const url of Object.keys(sorted)) {
    if (!shellRoute(new Request('https://shell.invalid' + url), 'https://shell.invalid', sorted)) throw new Error('Unsafe shell asset');
  }
  const cacheName = 'anyroute-shell-' + hash(JSON.stringify(sorted) + shellRoute.toString() + createShellWorker.toString()).slice(0, 24);
  fs.writeFileSync(path.join(root, 'sw.js'), `// Static app shell only; generated from exported file hashes.\nconst shellRoute = ${shellRoute.toString()};\nconst createShellWorker = ${createShellWorker.toString()};\ncreateShellWorker(${JSON.stringify({ assets: sorted, cacheName })}, self);\n`);
  return { assets: sorted, cacheName };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildPwa(path.resolve(process.argv[2] || 'out'));
  console.log(`PWA: ${Object.keys(result.assets).length} static shell files.`);
}
