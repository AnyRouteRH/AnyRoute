import test from 'node:test';
import assert from 'node:assert/strict';
import { imageOutput, imageSettings, imagePrice, safeImageUrl, imageFile, imageHistoryFields } from '../lib/harness-images.js';
import { snapshotLanes, restoreLanes } from '../lib/harness-image-history.js';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { normalizeModel, buildRequest, defaultSettings, applyChunk, blankReply, toWire } from '../lib/harness.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const model = normalizeModel({ id: 'sample/image', architecture: { input_modalities: ['text','image'], output_modalities: ['image','text'] }, pricing: { prompt: '0.000001', completion: '0.000006' }, supported_parameters: ['max_tokens'] });

test('image mode sends modalities through chat completions, and regeneration preserves the mode', () => {
  assert.equal(imageOutput(model), true);
  assert.equal(imageOutput(null), false);
  const settings = { ...defaultSettings(), imageOut: false, audioOut: true };
  const enabled = imageSettings(model, settings, true);
  const { body } = buildRequest({ model, settings: enabled, messages: [{ role: 'user', text: 'Draw a tree' }] });
  assert.deepEqual(body.modalities, ['image','text']);
  assert.equal(enabled.audioOut, false);
  assert.equal(settings.imageOut, false);
  assert.equal(imageSettings(model, enabled, false).imageOut, false);
  assert.equal(imageSettings({ outputs: ['text'] }, settings, true).imageOut, false);
  assert.equal(imageSettings(model, settings), settings);
});

test('prices distinguish a published per-image price from absent, invalid and zero prices', () => {
  assert.match(imagePrice({ pricing: { image: '0.04' } }), /\$0\.04 per image/);
  assert.match(imagePrice({ pricing: { image: '0.000000001' } }), /\$0\.000000001 per image/);
  for (const image of [undefined, null, '', '0', '-1', 'NaN', 'Infinity']) {
    assert.match(imagePrice({ pricing: { image } }), /unavailable/);
    assert.match(imagePrice({ pricing: { image } }), /does not mean a free image/);
  }
});

test('only raster data and credential-free HTTPS image URLs are accepted', () => {
  assert.equal(safeImageUrl(png), png);
  assert.equal(safeImageUrl('https://example.com/output.webp'), 'https://example.com/output.webp');
  for (const url of ['javascript:alert(1)', 'http://example.com/image.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,<>', 'https://sample-user:password@example.com/image.png', null]) assert.equal(safeImageUrl(url), null);
  assert.equal(imageHistoryFields({ images: Array(25).fill(png) }).images.length, 16);
});

test('download and attach use actual raster type, omit credentials, and reject oversized outputs', async () => {
  let options;
  const file = await imageFile('https://example.com/image', 1, async (_, opts) => {
    options = opts;
    return new Response(new Blob(['image bytes'], { type: 'image/webp' }));
  });
  assert.equal(file.name, 'anyroute-image-2.webp');
  assert.equal(file.type, 'image/webp');
  assert.deepEqual(options, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  assert.deepEqual(toWire({ role: 'user', text: 'Edit it', attachments: [{ kind: 'image', url: png }] }, model).content[1], { type: 'image_url', image_url: { url: png } });
  await assert.rejects(imageFile(png, 0, async () => new Response('', { status: 410 })), /expired/);
  await assert.rejects(imageFile(png, 0, async () => new Response(new Blob(['<svg/>'], { type: 'image/svg+xml' }))), /not supported/);
  await assert.rejects(imageFile(png, 0, async () => ({ ok: true, blob: async () => ({ type: 'image/png', size: 8 * 1024 * 1024 + 1 }) })), /larger than 8 MB/);
});

test('image-only stream replies survive browser history while input attachments and failed outputs do not', async () => {
  const reply = applyChunk(blankReply(), { choices: [{ delta: { images: [{ image_url: { url: png } }] } }] });
  const lanes = [{ modelId: model.id, messages: [
    { id: 'u1', role: 'user', text: 'Draw a tree', attachments: [{ name: 'input.png', url: png }] },
    { ...reply, id: 'a1', role: 'assistant', model: model.id, status: 'done', imageMode: true },
    { id: 'a2', role: 'assistant', text: '', images: [png], status: 'error' },
  ] }];
  const saved = snapshotLanes(lanes);
  assert.equal(saved[0].messages.length, 2);
  assert.deepEqual(saved[0].messages[1].images, [png]);
  assert.equal(saved[0].messages[1].text, '');
  assert.equal(saved[0].messages[0].attachments, undefined);
  const storage = memoryStorage();
  const vault = createHistory({ storage, iterations: 100_000 });
  await vault.create('sample-passphrase');
  await vault.put({ id: 'chat1', title: 'Tree', lanes: saved });
  assert.equal(JSON.stringify(await storage.get()).includes(png), false);
  vault.lock();
  await vault.unlock('sample-passphrase');
  const back = restoreLanes(vault.get('chat1').lanes);
  assert.deepEqual(back[0].messages[1].images, [png]);
  assert.equal(back[0].messages[1].imageMode, true);
  assert.deepEqual(back[0].messages[0].attachments, []);
});

test('ordinary text history remains compatible and restored image fields are filtered', () => {
  const lanes = [{ modelId: model.id, messages: [{ id: 'a1', role: 'assistant', text: 'A tree', status: 'done' }] }];
  assert.equal(restoreLanes(snapshotLanes(lanes))[0].messages[0].text, 'A tree');
  const saved = [{ modelId: model.id, messages: [{ role: 'assistant', text: 'A tree', images: ['javascript:alert(1)'] }] }];
  assert.equal(restoreLanes(saved)[0].messages[0].images, undefined);
});
