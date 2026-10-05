import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { shellRoute, createShellWorker } from '../lib/harness-sw.js';
import { isIOS, isInstalled, listenForInstall } from '../lib/harness-pwa.js';
import { buildPwa } from '../scripts/build-pwa.mjs';
import { auditPwa } from '../scripts/audit-pwa.mjs';

const root = new URL('../', import.meta.url);
const origin = 'https://shell.invalid';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(new URL(file, root));
const request = (url, options) => new Request(origin + url, options);

test('manifest uses site colours, stable Harness identity and opaque PNG icons', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  const css = read('app/globals.css').toString();
  for (const [field, token] of [['theme_color', 'ink'], ['background_color', 'paper']]) {
    assert.equal(manifest[field], css.match(new RegExp(`--${token}:(#[a-f0-9]{6})`))[1]);
  }
  assert.equal(manifest.name, 'Anyroute');
  assert.equal(manifest.short_name, 'Anyroute');
  assert.equal(manifest.id, '/harness/');
  assert.equal(manifest.start_url, '/harness/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const size of [192, 512]) for (const purpose of ['any', 'maskable']) {
    const icon = manifest.icons.find(i => i.sizes === `${size}x${size}` && i.purpose === purpose);
    assert(icon && icon.type === 'image/png');
    const png = read('public' + icon.src);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const apple = read('public/pwa/apple-touch-icon.png');
  assert.equal(apple.readUInt32BE(16), 180);
  assert.equal(apple.readUInt32BE(20), 180);
});

test('API paths can never enter the cache, even if included in a future shell list', () => {
  for (const url of ['/api/', '/api', '/api/v1/chat/completions', '/trpc/keys', '/v1/models', '/API/chat', '/%61pi/chat']) {
    assert.equal(shellRoute(request(url), origin, { [url]: 'a' }), null, url);
  }
});

test('queries, credentials, writes, partial requests, other origins and unknown paths bypass the shell', () => {
  const assets = { '/harness/': 'a', '/_next/static/chunks/app.js': 'b' };
  assert.equal(shellRoute(request('/harness/'), origin, assets), '/harness/');
  for (const req of [request('/harness/?key=sample-key'), request('/harness/', { method: 'POST', body: 'sample-message' }),
    request('/harness/', { headers: { authorization: 'Bearer sample-key' } }), request('/harness/', { headers: { range: 'bytes=0-10' } }),
    request('/agents/profile/'), new Request('https://other.invalid/harness/')]) assert.equal(shellRoute(req, origin, assets), null);
});

function worker(contents, responseFor = (_path, text) => new Response(text)) {
  const handlers = {}, stores = new Map(), calls = [], writes = [], deleted = [];
  const key = req => typeof req === 'string' ? req : req.url;
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return { put: async (req, res) => { writes.push(req.url); entries.set(key(req), res.clone()); }, match: async req => entries.get(key(req))?.clone() };
    },
    keys: async () => [...stores.keys()],
    delete: async name => { deleted.push(name); return stores.delete(name); },
  };
  const env = { location: { origin }, caches, crypto: webcrypto, clients: { claim: async () => {} },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    fetch: async req => { calls.push(req); return responseFor(new URL(req.url).pathname, contents[new URL(req.url).pathname]); },
  };
  createShellWorker({ assets: Object.fromEntries(Object.entries(contents).map(([url, text]) => [url, sha(text)])), cacheName: 'anyroute-shell-current' }, env);
  const install = () => { let promise; handlers.install({ waitUntil: value => { promise = value; } }); return promise; };
  const fetch = req => { let promise; handlers.fetch({ request: req, respondWith: value => { promise = value; } }); return promise; };
  return { install, fetch, env, calls, writes, stores, deleted, handlers };
}

test('install verifies exact exported bytes and fetch uses only those static responses', async () => {
  const w = worker({ '/harness/': '<html>Anyroute</html>', '/offline.html': '<html>Offline</html>', '/_next/static/chunks/app.js': 'app()' });
  await w.install();
  assert.equal(w.writes.length, 3);
  for (const req of w.calls) { assert.equal(req.credentials, 'omit'); assert.equal(req.cache, 'no-store'); }
  w.env.fetch = async () => { throw new Error('offline'); };
  const nav = request('/harness/');
  Object.defineProperty(nav, 'mode', { value: 'navigate' });
  assert.equal(await (await w.fetch(nav)).text(), '<html>Anyroute</html>');
  assert.equal(await (await w.fetch(request('/_next/static/chunks/app.js'))).text(), 'app()');
  for (const url of ['/api/chat', '/trpc/keys', '/v1/chat/completions', '/harness/?query=sample-message']) {
    const nav = request(url); Object.defineProperty(nav, 'mode', { value: 'navigate' });
    assert.equal(w.fetch(nav), undefined, 'Network-only, including API navigations');
  }
  assert.equal(w.writes.length, 3, 'No runtime response ever writes to cache');
  w.stores.get('anyroute-shell-current').delete(origin + '/harness/');
  assert.equal(await (await w.fetch(nav)).text(), '<html>Offline</html>');
});

test('personalized, private, redirected and failed responses refuse installation and remove partial caches', async () => {
  for (const response of [new Response('sample-answer'), new Response('static', { headers: { 'cache-control': 'private' } }),
    new Response('static', { headers: { 'cache-control': 'no-store' } }), new Response('static', { status: 500 }),
    Object.defineProperty(new Response('static'), 'redirected', { value: true })]) {
    const w = worker({ '/harness/': 'static' }, () => response.clone());
    // Response.clone does not preserve an overridden browser property.
    if (response.redirected) w.env.fetch = async () => response;
    await assert.rejects(w.install());
    assert.equal(w.stores.has('anyroute-shell-current'), false);
  }
});

test('runtime cache misses go to network without storing user data; activation removes only older app caches', async () => {
  const w = worker({ '/harness/': 'static' });
  await w.install();
  w.stores.get('anyroute-shell-current').clear();
  w.env.fetch = async () => new Response('sample-answer');
  assert.equal(await (await w.fetch(request('/harness/'))).text(), 'sample-answer');
  assert.equal(w.writes.length, 1);
  await w.env.caches.open('anyroute-shell-old');
  await w.env.caches.open('unrelated-cache');
  let promise; w.handlers.activate({ waitUntil: value => { promise = value; } }); await promise;
  assert.deepEqual(w.deleted, ['anyroute-shell-old']);
  assert(w.stores.has('unrelated-cache'));
});

test('installation detection covers iOS and standalone; event listeners are cleaned up', () => {
  const display = new EventTarget(); display.matches = false;
  const win = new EventTarget(); win.navigator = { userAgent: 'iPhone', platform: 'iPhone', standalone: false }; win.matchMedia = () => display;
  assert(isIOS(win.navigator));
  assert(isIOS({ userAgent: 'Safari', platform: 'MacIntel', maxTouchPoints: 5 }));
  assert(!isIOS({ userAgent: 'Android', platform: 'Linux' }));
  assert(!isInstalled(win.navigator, win.matchMedia));
  assert(isInstalled({ standalone: true }, win.matchMedia));
  const states = [], stop = listenForInstall(win, state => states.push(state));
  assert.equal(states.length, 1);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  win.dispatchEvent(event);
  assert(event.defaultPrevented);
  assert.equal(states.at(-1).prompt, event);
  win.dispatchEvent(new Event('appinstalled'));
  assert.equal(states.at(-1).installed, true);
  assert.equal(states.at(-1).prompt, null);
  stop(); win.dispatchEvent(event);
  assert.equal(states.length, 3);
});

test('export generation includes shell dependencies, rejects missing assets, and passes the artifact audit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyroute-pwa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(new URL('public/', root), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.mkdirSync(path.join(dir, '_next/static/chunks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_next/static/media'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_next/static/chunks/app.js'), 'app()');
  fs.writeFileSync(path.join(dir, '_next/static/chunks/app.css'), '@font-face{src:url(../media/font.woff2)}');
  fs.writeFileSync(path.join(dir, '_next/static/media/font.woff2'), 'font-bytes');
  fs.writeFileSync(path.join(dir, 'harness/index.html'), '<html><meta name="viewport" content="viewport-fit=cover"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png"><script src="/_next/static/chunks/app.js"></script><link href="/_next/static/chunks/app.css" rel="stylesheet"></html>');
  const first = buildPwa(dir);
  assert(first.assets['/_next/static/media/font.woff2']);
  assert.equal(auditPwa(dir), Object.keys(first.assets).length);
  fs.writeFileSync(path.join(dir, '_next/static/chunks/app.js'), 'newApp()');
  assert.throws(() => auditPwa(dir), /Changed shell file/);
  assert.notEqual(buildPwa(dir).cacheName, first.cacheName);
  fs.rmSync(path.join(dir, '_next/static/chunks/app.js'));
  assert.throws(() => buildPwa(dir), /ENOENT/);
});
