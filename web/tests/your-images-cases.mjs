// H167: shared cases run under Node and Bun with or without database services.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createHistory, memoryStorage } from '../lib/private-history.js';
import { snapshotLanes, restoreLanes } from '../lib/harness-image-history.js';
import { forkLane } from '../lib/harness-branches.js';
import { imageFile } from '../lib/harness-images.js';
import { collectYourImages, filterYourImages, selectImageVersion, yourImagesAccess } from '../lib/your-images.js';

const png = 'data:image/png;base64,aW1hZ2U=';
const user = (id, text) => ({ id, role: 'user', text });
const reply = (id, model, images = [png]) => ({ id, role: 'assistant', model, text: '', images, status: 'done' });
const lane = () => ({ modelId: 'sample/image', messages: [user('u1', 'Draw a green tree'), reply('a1', 'sample/image')] });
const chats = () => [
  { id: 'older', title: 'Tree', at: 100, pinned: true, lanes: snapshotLanes([lane()]) },
  { id: 'newer', title: 'Boat', at: 200, lanes: snapshotLanes([{ modelId: 'sample/other', messages: [user('u2', 'Draw a blue boat'), reply('a2', 'sample/other', [png, 'data:image/webp;base64,aW1hZ2U='])] }]) },
];
const history = (rows = chats()) => ({ unlocked: true, list: () => rows.map(({ id }) => ({ id })), get: id => structuredClone(rows.find(chat => chat.id === id)) });

export const yourImagesCases = [
  ['collects every saved output once, newest chats first without pin priority', () => {
    const h = history(), before = h.get('older');
    const images = collectYourImages(h);
    assert.equal(images.length, 3);
    assert.deepEqual(images.map(image => image.chatId), ['newer', 'newer', 'older']);
    assert.equal(new Set(images.map(image => image.id)).size, 3);
    assert.equal(images[2].snippet, 'Draw a green tree');
    assert.equal(images[0].model, 'sample/other');
    assert.equal(images[0].at, 200);
    assert.deepEqual(h.get('older'), before);
  }],
  ['collects inactive branches and matches each image to its own ancestor prompt and model', () => {
    const base = lane();
    const fork = forkLane(base, 0, [user('u3', 'Draw a red flower'), reply('a3', 'sample/flower')]);
    fork.messages.push(user('u4', 'Add a bee'), reply('a4', 'sample/flower'));
    const images = collectYourImages(history([{ id: 'branches', title: 'Versions', at: 300, lanes: snapshotLanes([fork]) }]));
    assert.deepEqual(images.map(image => [image.messageId, image.prompt, image.model]), [
      ['a4', 'Add a bee', 'sample/flower'], ['a3', 'Draw a red flower', 'sample/flower'], ['a1', 'Draw a green tree', 'sample/image'],
    ]);
  }],
  ['filters by exact model and full prompt text, ignoring case and surrounding spaces', () => {
    const images = collectYourImages(history());
    assert.equal(filterYourImages(images, { query: '  BLUE  ' }).length, 2);
    assert.equal(filterYourImages(images, { model: 'sample/image', query: 'TREE' }).length, 1);
    assert.equal(filterYourImages(images, { model: 'sample/other', query: 'tree' }).length, 0);
    const long = 'a'.repeat(180) + ' ending';
    const rows = collectYourImages(history([{ id: 'long', title: 'Long', at: 1, lanes: snapshotLanes([{ modelId: 'sample/image', messages: [user('u', long), reply('a', 'sample/image')] }]) }]));
    assert.equal(rows[0].snippet.length, 160);
    assert.equal(filterYourImages(rows, { query: 'ending' }).length, 1);
  }],
  ['never reads locked or off history, and explains how to enable and unlock it', () => {
    const locked = { unlocked: false, list() { throw Error('must not read'); }, get() { throw Error('must not read'); } };
    assert.deepEqual(collectYourImages(locked), []);
    assert.deepEqual(collectYourImages(null), []);
    assert.match(yourImagesAccess(locked), /Unlock/);
    assert.match(yourImagesAccess(null), /Keep history on this device/);
    assert.equal(yourImagesAccess(history()), '');
  }],
  ['keeps generated inline outputs only and never includes input attachments or external links', () => {
    const rows = [{ id: 'one', title: 'One', at: 1, lanes: [{ modelId: 'sample/image', messages: [
      { ...user('u', 'draw'), attachments: [{ kind: 'image', url: png }] },
      reply('a', '', [png, 'https://example.com/image.png', 'data:image/svg+xml;base64,aW1hZ2U=', 'javascript:alert(1)']),
    ] }] }];
    const images = collectYourImages(history(rows));
    assert.equal(images.length, 1); assert.equal(images[0].url, png);
    assert.equal(images[0].model, 'sample/image');
  }],
  ['full-size download uses the existing filename and no network or input size cap', async () => {
    const big = `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 3).toString('base64')}`;
    const noNetwork = () => { throw Error('must not fetch'); };
    const file = await imageFile(big, 0, noNetwork, { limit: 0 });
    assert.equal(file.name, 'anyroute-image-1.png');
    assert.equal(file.size, 8 * 1024 * 1024 + 3);
    await assert.rejects(imageFile(big, 0, noNetwork), /larger than 8 MB/);
    assert.equal((await imageFile('data:image/webp;base64,aW1hZ2U=', 0, noNetwork, { limit: 0 })).name, 'anyroute-image-1.webp');
  }],
  ['opens an inactive saved version in its original compare lane', () => {
    const branched = forkLane(lane(), 0, [user('u3', 'Flower'), reply('a3', 'sample/flower')]);
    const saved = snapshotLanes([lane(), branched]);
    const images = collectYourImages(history([{ id: 'compare', title: 'Compare', at: 1, lanes: saved }]));
    const target = images.find(image => image.laneIndex === 1 && image.messageId === 'a1');
    const restored = restoreLanes(saved), before = structuredClone(restored);
    const opened = selectImageVersion(restored, target);
    assert.deepEqual(opened[1].messages.map(message => message.id), ['u1', 'a1']);
    assert.deepEqual(opened[0], restored[0]);
    assert.deepEqual(restored, before);
    assert.deepEqual(selectImageVersion(restored, { ...target, messageId: 'missing' }), restored);
    const withCost = restored.map(lane => ({ ...lane, chatCostRemainder: { id: 'compare', microUsd: '1000', replies: 1 } }));
    assert.equal(selectImageVersion(withCost, target)[1].chatCostRemainder, undefined);
    assert.deepEqual(selectImageVersion(restored, images.find(image => image.laneIndex === 1 && image.messageId === 'a3')), restored);
  }],
  ['reads the same vault through encrypt, lock and unlock without creating a store', async () => {
    const storage = memoryStorage();
    const vault = createHistory({ storage, crypto: webcrypto, iterations: 100000, now: () => 400 });
    await vault.create('sample history passphrase');
    await vault.put({ ...chats()[0], lanes: snapshotLanes([forkLane(lane(), 0, [user('u3', 'Flower'), reply('a3', 'sample/flower')])]) });
    assert.equal(collectYourImages(vault).length, 2);
    assert.equal(JSON.stringify(await storage.get()).includes(png), false);
    vault.lock(); assert.deepEqual(collectYourImages(vault), []);
    await vault.unlock('sample history passphrase');
    assert.equal(collectYourImages(vault).length, 2);
    await vault.remove('older'); assert.deepEqual(collectYourImages(vault), []);
  }],
];
