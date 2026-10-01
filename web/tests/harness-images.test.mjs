import test from "node:test";
import assert from "node:assert/strict";
import { applyChunk, blankReply, buildRequest, defaultSettings, normalizeModel, routeAsModel } from "../lib/harness.js";
import { MAX_IMAGE_BYTES, MAX_SOURCE_BYTES, imageDimensions, imageFile, imageSettings, imageSendBlock, imageSendError, prepareImage, readsImages, storedImages, validateImage } from "../lib/harness-images.js";
import { snapshotLanes, restoreLanes } from "../lib/harness-image-history.js";
import { createHistory, memoryStorage } from "../lib/private-history.js";
import { streamChat } from "../lib/api.js";

const vision = normalizeModel({ id: "sample/vision", architecture: { input_modalities: ["text", "image"] } });
const text = normalizeModel({ id: "sample/text", input_modalities: ["text"] });
const image = { id: "img-1", kind: "image", name: "image.jpg", url: "data:image/jpeg;base64,AAAA", size: 3, width: 2, height: 1 };
const user = { id: "u1", role: "user", text: "", attachments: [image] };
const find = (id) => [vision, text].find((m) => m.id === id);

test("vision is declared by architecture, top-level modalities or the architecture input side", () => {
  assert.ok(readsImages(vision));
  assert.ok(readsImages(normalizeModel({ id: "sample/a", input_modalities: ["image"] })));
  assert.ok(readsImages(normalizeModel({ id: "sample/b", architecture: { modality: "text+image->text" } })));
  assert.equal(readsImages(normalizeModel({ id: "sample/c", architecture: { modality: "text->text+image" } })), false);
  assert.equal(readsImages(normalizeModel({ id: "sample/vision-name" })), false);
  assert.equal(readsImages(null), false);
  assert.equal(readsImages(normalizeModel({ id: "sample/d", architecture: { input_modalities: ["text"] }, input_modalities: ["image"] })), false);
});

test("a route accepts images only when every member does", () => {
  const byId = new Map([vision, text].map((m) => [m.id, m]));
  assert.ok(readsImages(routeAsModel({ slug: "vision", config: { models: [vision.id] } }, byId)));
  assert.equal(readsImages(routeAsModel({ slug: "mixed", config: { models: [vision.id, text.id] } }, byId)), false);
});

test("dimensions preserve aspect ratio, avoid upscaling and reject excessive decoded pixels", () => {
  assert.deepEqual(imageDimensions(4096, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(imageDimensions(1024, 4096), { width: 512, height: 2048 });
  assert.deepEqual(imageDimensions(20, 10), { width: 20, height: 10 });
  assert.deepEqual(imageDimensions(40000, 1), { width: 2048, height: 1 });
  for (const [w, h] of [[0, 1], [NaN, 1], [Infinity, 2], [10000, 10000]]) assert.throws(() => imageDimensions(w, h));
});

test("input permits only PNG, JPEG, WebP or GIF, bounded at 8 MB", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) validateImage({ type, size: MAX_SOURCE_BYTES });
  for (const f of [{ type: "image/svg+xml", size: 1 }, { type: "image/jpeg", size: 0 }, { type: "image/jpeg", size: MAX_SOURCE_BYTES + 1 }]) assert.throws(() => validateImage(f));
});

function renderer(sizes = [100]) {
  const calls = [];
  let closed = false;
  const bitmap = { width: 4096, height: 2048, close: () => { closed = true; } };
  const context = { fillRect: (...args) => calls.push(["fill", ...args]), drawImage: (...args) => calls.push(["draw", ...args.slice(1)]) };
  const surface = { width: 0, height: 0, getContext: () => context, toBlob: (done, type, quality) => { calls.push(["encode", type, quality]); done({ type, size: sizes.shift() ?? MAX_IMAGE_BYTES + 1 }); } };
  const deps = { decode: async () => bitmap, canvas: () => surface, read: async (blob) => { calls.push(["read", blob.size]); return image.url; } };
  return { deps, surface, calls, closed: () => closed };
}

test("image preparation redraws pixels and reads only the re-encoded blob", async () => {
  const r = renderer();
  const source = { type: "image/gif", size: 2048, name: "source-with-metadata.gif" };
  const result = await prepareImage(source, r.deps);
  assert.deepEqual(result, { kind: "image", name: "image.jpg", url: image.url, size: 100, width: 2048, height: 1024 });
  assert.deepEqual(r.calls, [["fill", 0, 0, 2048, 1024], ["draw", 0, 0, 2048, 1024], ["encode", "image/jpeg", 0.86], ["read", 100]]);
  assert.equal(r.closed(), true);
  assert.equal(r.surface.width, 0);
  assert.equal(r.surface.height, 0);
});

test("oversized output reduces dimensions again and never sends an over-cap image", async () => {
  const r = renderer([MAX_IMAGE_BYTES + 1, 100]);
  const result = await prepareImage({ type: "image/png", size: 1 }, r.deps);
  assert.equal(result.width, 1433);
  assert.equal(result.height, 717);
  assert.equal(r.calls.filter((c) => c[0] === "read").length, 1);
  const failing = renderer([]);
  await assert.rejects(prepareImage({ type: "image/jpeg", size: 1 }, failing.deps), /sending limit/);
  assert.equal(failing.calls.filter((c) => c[0] === "read").length, 0);
  assert.equal(failing.closed(), true);
});

test("decoding or encoding failures do not fall back to original bytes", async () => {
  await assert.rejects(prepareImage({ type: "image/webp", size: 1 }, { decode: async () => { throw new Error("bad image"); } }), /bad image/);
  const r = renderer();
  r.surface.toBlob = (done) => done(null);
  await assert.rejects(prepareImage({ type: "image/jpeg", size: 1 }, r.deps), /cannot encode/);
  assert.equal(r.closed(), true);
  assert.equal(r.calls.filter((c) => c[0] === "read").length, 0);
});

test("image-only content uses OpenAI parts in every vision compare lane", () => {
  for (const model of [vision, normalizeModel({ id: "sample/other", input_modalities: ["image"] })]) {
    const { body, notes } = buildRequest({ model, messages: [user] });
    assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "" }, { type: "image_url", image_url: { url: image.url } }] }]);
    assert.deepEqual(notes, []);
  }
});

test("capability guard blocks mixed compare sends and switching an image conversation to text", () => {
  const lanes = [{ modelId: vision.id, messages: [] }, { modelId: text.id, messages: [] }];
  assert.match(imageSendBlock(lanes, find, [image]), /Switch to a vision model/);
  assert.equal(imageSendBlock(lanes.slice(0, 1), find, [image]), "");
  assert.equal(imageSendBlock(lanes, find, []), "");
  assert.match(imageSendError(text, [user]), /does not accept image input/);
  assert.match(imageSendError(null, [user]), /does not accept image input/);
  assert.equal(imageSendError(vision, [user]), "");
  assert.equal(imageSendBlock([{ modelId: text.id, messages: [user] }], find, [], 0), "");
});

test("browser history preserves image-only turns and compares store image bytes once", () => {
  const lanes = [{ modelId: vision.id, messages: [user] }, { modelId: vision.id, messages: [user] }];
  const snapshot = snapshotLanes(lanes);
  assert.equal(JSON.stringify(snapshot).split(image.url).length - 1, 1);
  assert.deepEqual(snapshot[1].messages[0].attachments, [{ imageRef: image.id }]);
  const restored = restoreLanes(snapshot);
  assert.deepEqual(restored[0].messages[0].attachments, [image]);
  assert.deepEqual(restored[1].messages[0].attachments, [image]);
  assert.equal(imageSendBlock(restored, find), "");
  assert.deepEqual(restoreLanes(null)[0].messages, []);
});

test("history excludes originals, remote images, oversized URLs and non-image attachments", () => {
  const unsafe = [
    { ...image, url: "data:image/png;base64,AAAA" },
    { ...image, url: "https://example.invalid/image.jpg" },
    { ...image, url: "javascript:alert(1)" },
    { ...image, url: "data:image/jpeg;base64," + "A".repeat(MAX_IMAGE_BYTES * 2) },
    { ...image, kind: "file" },
  ];
  assert.deepEqual(storedImages(unsafe), []);
  const restored = restoreLanes([{ modelId: vision.id, messages: [{ ...user, attachments: [{ imageRef: "missing" }, ...unsafe] }] }]);
  assert.deepEqual(restored[0].messages[0].attachments, []);
  assert.deepEqual(restoreLanes([{ modelId: vision.id, messages: [{ ...user, attachments: undefined }] }])[0].messages[0].attachments, []);
});

test("images round-trip through the existing encrypted browser vault without a storage family", async () => {
  const storage = memoryStorage();
  const history = createHistory({ storage, iterations: 100_000 });
  await history.create("sample passphrase");
  await history.put({ id: "chat-1", title: "Image conversation", lanes: snapshotLanes([{ modelId: vision.id, messages: [user] }]) });
  assert.equal(JSON.stringify(await storage.get()).includes(image.url), false);
  history.lock();
  await history.unlock("sample passphrase");
  assert.deepEqual(restoreLanes(history.get("chat-1").lanes)[0].messages[0].attachments, [image]);
});

test("the Harness transport serializes image parts unchanged", async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const { body } = buildRequest({ model: vision, messages: [user] });
    await streamChat({ key: "sample-key", body });
    assert.equal(sent.messages[0].content[1].image_url.url, image.url);
  } finally { globalThis.fetch = original; }
});

test("generated images become prepared inputs and both survive the same encrypted history", async () => {
  const generated = "data:image/png;base64,BBBB";
  const file = await imageFile(generated, 0, async () => new Response(new Blob(["pixels"], { type: "image/png" })));
  const r = renderer();
  const prepared = { ...await prepareImage(file, r.deps), id: "prepared-1" };
  assert.equal(prepared.url, image.url);
  assert.equal(prepared.name, "image.jpg");
  assert.deepEqual(r.calls[2], ["encode", "image/jpeg", 0.86]);

  const imageModel = normalizeModel({ id: "sample/image", architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] } });
  const reply = { ...applyChunk(blankReply(), { choices: [{ delta: { images: [{ image_url: { url: generated } }] } }] }), id: "generated-1", role: "assistant", model: imageModel.id, status: "done", imageMode: true };
  const messages = [
    { id: "prompt-1", role: "user", text: "Draw a tree" },
    reply,
    { id: "failed-1", role: "assistant", status: "error", text: "", images: [generated] },
    { id: "edit-1", role: "user", text: "", attachments: [prepared] },
  ];
  const saved = snapshotLanes([{ modelId: imageModel.id, messages }, { modelId: imageModel.id, messages }]);
  assert.equal(saved[0].messages.length, 3);
  assert.deepEqual(saved[1].messages[2].attachments, [{ imageRef: prepared.id }]);
  assert.equal(JSON.stringify(saved).split(prepared.url).length - 1, 1);

  const storage = memoryStorage();
  const vault = createHistory({ storage, iterations: 100_000 });
  await vault.create("sample passphrase");
  await vault.put({ id: "combined-1", title: "Tree edit", lanes: saved });
  const encrypted = JSON.stringify(await storage.get());
  for (const url of [generated, prepared.url]) assert.equal(encrypted.includes(url), false);
  vault.lock();
  await vault.unlock("sample passphrase");
  const restored = restoreLanes(vault.get("combined-1").lanes);
  assert.equal(imageSendBlock(restored, (id) => id === imageModel.id ? imageModel : null), "");
  for (const lane of restored) {
    assert.deepEqual(lane.messages[1].images, [generated]);
    assert.equal(lane.messages[1].imageMode, true);
    assert.deepEqual(lane.messages[2].attachments, [prepared]);
    const { body, notes } = buildRequest({ model: imageModel, settings: imageSettings(imageModel, defaultSettings(), lane.messages[1].imageMode), messages: lane.messages });
    assert.deepEqual(body.modalities, ["image", "text"]);
    assert.deepEqual(body.messages.at(-1).content[1], { type: "image_url", image_url: { url: prepared.url } });
    assert.deepEqual(notes, []);
  }
});
