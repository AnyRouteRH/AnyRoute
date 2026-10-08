import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseSharedDraft, sharedLocation, clearSharedLocation, receiveSharedDraft } from '../lib/share-draft.js';
import { createShareWorker } from '../lib/share-worker.js';
import { createShellWorker } from '../lib/harness-sw.js';

const origin = 'https://share.invalid';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
function worker(serialized = false) {
  const handlers = {}, calls = [];
  const env = {
    location: { origin }, crypto: webcrypto,
    addEventListener: (name, fn) => (handlers[name] ||= []).push(fn),
    caches: { open: async () => ({ match: async url => url === origin + '/harness/' ? new Response('static Chat') : undefined }) },
    fetch: async request => { calls.push(request); return new Response('network'); },
  };
  const config = { cacheName: 'anyroute-shell-current', assets: { '/harness/': 'digest' } };
  createShellWorker(config, env);
  if (serialized) vm.runInNewContext(`(${createShareWorker.toString()})(config, env, (${parseSharedDraft.toString()}))`, { config, env, URL, Request, Response, Blob, Date });
  else createShareWorker(config, env, parseSharedDraft);
  const fetch = request => {
    let response, count = 0;
    for (const handler of handlers.fetch) handler({ request, respondWith: promise => { response = promise; count++; } });
    assert(count <= 1, 'only one worker responds');
    return response;
  };
  const message = (id, source = origin + '/harness/', type = 'anyroute-share-consume') => {
    let reply;
    for (const handler of handlers.message) handler({ data: { type, id }, source: { url: source }, ports: [{ postMessage: value => { reply = value; } }] });
    return reply;
  };
  return { env, calls, fetch, message };
}
function post(form, path = '/harness/?share_target=1') {
  return new Request(origin + path, { method: 'POST', body: form });
}
function form(text = 'Shared text', count = 0, type = 'image/png', size = 3) {
  const data = new FormData();
  data.set('share_title', 'A title'); data.set('share_text', text); data.set('share_url', 'https://link.invalid/');
  for (let index = 0; index < count; index++) data.append('share_files', new Blob([new Uint8Array(size)], { type }), 'photo.png');
  return data;
}
const idOf = response => new URL(response.headers.get('location')).searchParams.get('share_id');

test('manifest registers one multipart target for title, text, links and supported images', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest'));
  assert.equal(manifest.id, '/harness/');
  assert.deepEqual(manifest.share_target, {
    action: '/harness/?share_target=1', method: 'POST', enctype: 'multipart/form-data',
    params: { title: 'share_title', text: 'share_text', url: 'share_url', files: [{ name: 'share_files', accept: ['image/png', '.png', 'image/jpeg', '.jpg', '.jpeg', 'image/webp', '.webp', 'image/gif', '.gif'] }] },
  });
});

test('prefill decoding keeps hostile HTML and URLs as plain text, decoding exactly once', () => {
  const params = new URLSearchParams('share_title=%3Cscript%3Ealert%281%29%3C%2Fscript%3E&share_text=a%26b%2B%252F%0D%0Aline%00&share_url=javascript%3Aalert%281%29');
  assert.deepEqual(parseSharedDraft(params), { present: true, text: '<script>alert(1)</script>\na&b+%2F\nline\njavascript:alert(1)', truncated: false });
  assert.deepEqual(parseSharedDraft(new URLSearchParams('model=sample-model')), { present: false, text: '', truncated: false });
  assert.equal(parseSharedDraft(new URLSearchParams('share_text=one&share_text=two')).text, 'one');
  assert.equal(parseSharedDraft(new URLSearchParams('share_title=&share_text=link+only&share_url=')).text, 'link only');
});

test('prefill enforces per-field and combined caps without a dangling surrogate', () => {
  for (const [field, cap] of [['share_title', 512], ['share_text', 16000], ['share_url', 2048]]) {
    const result = parseSharedDraft(new URLSearchParams({ [field]: 'x'.repeat(cap + 20) }));
    assert.equal(result.text.length, cap); assert(result.truncated);
  }
  const all = parseSharedDraft(new URLSearchParams({ share_title: 'a'.repeat(512), share_text: 'b'.repeat(16000), share_url: 'c'.repeat(2048) }));
  assert.equal(all.text.length, 16384); assert(all.truncated);
  assert.equal(parseSharedDraft(new URLSearchParams({ share_title: 'x'.repeat(511) + '🌍' })).text.length, 511);
});

test('share fields leave the address while model selection, hash and history state survive', () => {
  const calls = [];
  const location = { href: origin + '/harness/?model=sample-model&share_title=A&share_text=B&share_url=C&share_id=opaque&share_error=invalid&share_target=1#composer' };
  assert.equal(sharedLocation(location).text, 'A\nB\nC');
  clearSharedLocation({ location, history: { state: { view: 1 }, replaceState: (...args) => calls.push(args) } });
  assert.deepEqual(calls, [[{ view: 1 }, '', '/harness/?model=sample-model#composer']]);
});

test('POST redirects text and images into a single-use draft with no network, cache write or inference', async () => {
  const w = worker(true);
  const response = await w.fetch(post(form('Read this', 6)));
  assert.equal(response.status, 303); assert.equal(response.headers.get('cache-control'), 'no-store');
  const id = idOf(response); assert(id);
  const draft = w.message(id).draft;
  assert.equal(draft.text, 'A title\nRead this\nhttps://link.invalid/');
  assert.equal(draft.files.length, 6); assert.equal(draft.files[0].type, 'image/png');
  assert.equal(w.message(id).draft, null);
  assert.deepEqual(w.calls, []);
});

test('text-only POST and image-only POST both produce drafts without authentication', async () => {
  const w = worker();
  assert.equal(w.message(idOf(await w.fetch(post(form())))).draft.files.length, 0);
  const images = new FormData(); images.append('share_files', new Blob(['image'], { type: 'image/jpeg' }), 'photo.jpg');
  const draft = w.message(idOf(await w.fetch(post(images)))).draft;
  assert.equal(draft.text, ''); assert.equal(draft.files.length, 1);
  assert.deepEqual(w.calls, []);
});

test('ordinary traffic and API requests retain their existing routing', () => {
  const w = worker();
  for (const path of ['/api/v1/chat/completions', '/harness/', '/harness/?other=1']) assert.equal(w.fetch(post(form(), path)), undefined);
  for (const url of [origin + '/api/v1/key?share_text=hello', 'https://other.invalid/harness/?share_text=hello', origin + '/harness/?model=sample-model']) {
    const req = new Request(url); Object.defineProperty(req, 'mode', { value: 'navigate' });
    assert.equal(w.fetch(req), undefined);
  }
});

test('GET share navigation opens only the cached static Chat shell, without forwarding the query', async () => {
  const w = worker();
  const req = new Request(origin + '/harness/?share_text=private'); Object.defineProperty(req, 'mode', { value: 'navigate' });
  assert.equal(await (await w.fetch(req)).text(), 'static Chat'); assert.deepEqual(w.calls, []);
  w.env.caches.open = async () => ({ match: async () => undefined });
  assert.equal(await (await w.fetch(req)).text(), 'network');
  assert.equal(w.calls[0].url, origin + '/harness/'); assert.equal(w.calls[0].credentials, 'omit');
});

test('handoff requires a same-origin Chat client and the opaque id; rejected clients cannot consume it', async () => {
  const w = worker(), id = idOf(await w.fetch(post(form())));
  for (const source of ['https://other.invalid/harness/', origin + '/dashboard/', 'invalid']) assert.equal(w.message(id, source), undefined);
  assert.equal(w.message(id, origin + '/harness/', 'other-message'), undefined);
  assert.equal(w.message('wrong-id').draft, null);
  assert(w.message(id).draft);
});

test('pending shares expire and a third share evicts only the oldest', async t => {
  const w = worker(); let now = 1000; t.mock.method(Date, 'now', () => now);
  const first = idOf(await w.fetch(post(form('first'))));
  const second = idOf(await w.fetch(post(form('second'))));
  const third = idOf(await w.fetch(post(form('third'))));
  assert.equal(w.message(first).draft, null); assert(w.message(second).draft);
  now += 5 * 60 * 1000;
  assert.equal(w.message(third).draft, null);
});

test('invalid counts, sizes, formats, file fields and empty shares redirect to a fixed error', async () => {
  const w = worker();
  for (const data of [form('text', 7), form('text', 1, 'image/svg+xml'), form('text', 1, 'image/png', 0), form('text', 1, 'image/png', 8 * 1024 * 1024 + 1), new FormData()]) {
    const response = await w.fetch(post(data)); assert.equal(response.status, 303); assert.match(response.headers.get('location'), /share_error=/); assert.equal(idOf(response), null);
  }
  const invalid = form(); invalid.append('share_files', 'not a file');
  assert.match((await w.fetch(post(invalid))).headers.get('location'), /share_error=images/);
  const req = new Request(origin + '/harness/?share_target=1', { method: 'POST', body: 'not multipart' });
  assert.match((await w.fetch(req)).headers.get('location'), /share_error=invalid/);
  const malformed = new Request(origin + '/harness/?share_target=1', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=missing' }, body: 'invalid' });
  assert.match((await w.fetch(malformed)).headers.get('location'), /share_error=invalid/);
  assert.deepEqual(w.calls, []);
});

test('oversized multipart framing is rejected before parsing and cancels the reader', async () => {
  const w = worker(); let canceled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6 * 8 * 1024 * 1024 + 64 * 1024 + 1)); }, cancel() { canceled = true; } });
  const req = new Request(origin + '/harness/?share_target=1', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=a' }, body, duplex: 'half' });
  assert.match((await w.fetch(req)).headers.get('location'), /share_error=size/); assert(canceled);
});

test('page consumes a worker draft via a message channel, surfacing a lost draft', async () => {
  const w = worker(), id = idOf(await w.fetch(post(form())));
  const active = { postMessage: (message, ports) => ports[0].postMessage(w.message(message.id)) };
  const serviceWorker = { ready: Promise.resolve({ active }), controller: null };
  assert.equal((await receiveSharedDraft(serviceWorker, id)).text, 'A title\nShared text\nhttps://link.invalid/');
  await assert.rejects(receiveSharedDraft(serviceWorker, id), /Share unavailable/);
  await assert.rejects(receiveSharedDraft({ ready: Promise.resolve({ active: null }) }, id), /Share unavailable/);
});

test('Chat share integration can only prefill and prepare; existing submit retains sign-in guard', () => {
  const integration = read('../components/harness/SharedDraft.jsx');
  assert.match(integration, /current\.current\.setDraft\(draft\.text\)/);
  assert.match(integration, /current\.current\.addFiles\(files\)/);
  assert.doesNotMatch(integration, /\b(?:send|runLane|fetch|api)\s*\(|dangerouslySetInnerHTML/);
  assert.match(integration, /if \(!share\?\.files\.length \|\| !acceptsImages\) return/);
  const harness = read('../components/Harness.jsx');
  assert.match(harness, /useSharedDraft\(\{ setDraft, addFiles, acceptsImages \}\)/);
  assert.match(harness, /if \(needKey\("send"\)\) return/);
  assert.match(harness, /onSignIn=\{\(\) => setSignin\("send"\)\}/);
  assert.match(read('../components/harness/ImageAttachments.jsx'), /await prepareImage\(file\)/);
  assert.match(read('../scripts/build-pwa.mjs'), /createShareWorker.*self, parseSharedDraft/);
});

test('docs, search, inventory and API metadata describe the share path and its limits', () => {
  assert.match(read('../components/ShareToAnyrouteDocs.jsx'), /id="share-to-anyroute"/);
  assert.match(read('../components/DocsFeatureIndex.jsx'), /"share-to-anyroute"/);
  assert.match(read('../lib/site-map.js'), /task\('share-to-anyroute'/);
  assert.match(read('../../src/privacy/share-to-anyroute.ts'), /including their original metadata and names/);
  const route = JSON.parse(read('../public/openapi.json')).paths['/harness/'];
  assert.deepEqual(route.get.security, []); assert.deepEqual(route.post.security, []);
  assert(route.post.requestBody.content['multipart/form-data']);
});
