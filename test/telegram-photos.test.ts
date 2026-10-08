import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.ts";
import { generations, kv } from "../src/db/schema.ts";
import { TelegramBot, userKey, type TgUpdate, type RouterCall } from "../src/services/telegram.ts";
import { MAX_PHOTO_BYTES, photoCapability, photoCaption, prepareTelegramPhoto, visionReply } from "../src/telegram/photos.ts";
import { reencodePhotoJpeg } from "../src/telegram/photo-jpeg.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { rgbPhoto } from "./support/telegram-photo.ts";

// A complete baseline JPEG: one grayscale 8x8 block, all-zero quantized DCT
// coefficients. Canonical one-bit DC-zero/AC-EOB tables; APP1 and COM deliberately
// contain identifiable metadata, followed by unrelated bytes after EOI.
function jpeg() {
  const bytes: number[] = [255, 216];
  const seg = (marker: number, data: number[]) => bytes.push(255, marker, (data.length + 2) >> 8, (data.length + 2) & 255, ...data);
  seg(225, [...Buffer.from("Exif\0\0photo-metadata-marker")]);
  seg(254, [...Buffer.from("photo-comment-marker")]);
  seg(219, [0, ...Array(64).fill(1)]);
  seg(192, [8, 0, 8, 0, 8, 1, 1, 17, 0]);
  seg(196, [0, 1, ...Array(15).fill(0), 0, 16, 1, ...Array(15).fill(0), 0]);
  seg(218, [1, 1, 0, 0, 63, 0]);
  bytes.push(63, 255, 217, ...Buffer.from("trailing-photo-marker"));
  return new Uint8Array(bytes);
}
const image = jpeg();
const TOKEN = "123456789:AAFixtureTokenFixtureToken0123456789";
const LLAMA = MODELS.llama.slug;
let uid = 910000, updateId = 0;
const update = (user: number, extra: Partial<NonNullable<TgUpdate["message"]>> = {}): TgUpdate => ({ update_id: ++updateId, message: { message_id: updateId, from: { id: user }, chat: { id: user, type: "private" }, ...extra } });
const photo = (file_id = "photo-file-marker", width = 8, file_size?: number) => ({ file_id, width, height: width, ...(file_size === undefined ? {} : { file_size }) });

function telegram() {
  const calls: { method: string; params: any }[] = [];
  const downloads: { url: string; init: RequestInit }[] = [];
  let file: { file_path?: string; file_size?: number } = { file_path: "photos/photo.jpg", file_size: image.length };
  let response = () => new Response(image);
  const request = (async (input: any, init: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`https://api.telegram.org/file/bot${TOKEN}/`)) { downloads.push({ url, init }); return response(); }
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = url.slice(url.lastIndexOf("/") + 1), params = JSON.parse(String(init.body));
    calls.push({ method, params });
    return Response.json({ ok: true, result: method === "getFile" ? file : true });
  }) as typeof fetch;
  return { calls, downloads, fetch: request, setFile: (value: typeof file) => { file = value; }, setResponse: (value: typeof response) => { response = value; }, sent: () => calls.filter((x) => x.method === "sendMessage").map((x) => String(x.params.text)), last: () => String(calls.filter((x) => x.method === "sendMessage").at(-1)?.params.text) };
}

describe("Telegram photo preparation", () => {
  test("metadata stripping removes EXIF, comments and trailing content and is stable", () => {
    const clean = reencodePhotoJpeg(image), text = Buffer.from(clean).toString("latin1");
    for (const value of ["Exif", "photo-metadata-marker", "photo-comment-marker", "trailing-photo-marker"]) expect(text).not.toContain(value);
    expect(clean.slice(0, 2)).toEqual(new Uint8Array([255, 216]));
    expect(clean.slice(-3)).toEqual(new Uint8Array([63, 255, 217]));
    expect(reencodePhotoJpeg(clean)).toEqual(clean);
  });
  test("a colour JPEG keeps its image data byte for byte", () => {
    const clean = reencodePhotoJpeg(rgbPhoto);
    expect(reencodePhotoJpeg(clean)).toEqual(clean);
    // Native image decoding independently confirmed identical pixels for this fixture.
    const scan = (bytes: Uint8Array) => bytes.findIndex((v, i) => v === 255 && bytes[i + 1] === 218);
    expect(clean.subarray(scan(clean))).toEqual(rgbPhoto.subarray(scan(rgbPhoto)));
  });
  test("corrupt and oversized photos fail closed; other JPEG encodings are stripped without decoding", () => {
    for (const bytes of [new Uint8Array(), image.subarray(0, 30), new Uint8Array(MAX_PHOTO_BYTES + 1)]) expect(() => reencodePhotoJpeg(bytes)).toThrow();
    const progressive = image.slice();
    const index = progressive.findIndex((v, i) => v === 255 && progressive[i + 1] === 192);
    progressive[index + 1] = 194;
    const stripped = reencodePhotoJpeg(progressive);
    expect(Buffer.from(stripped).toString("latin1")).not.toContain("Exif");
    expect(reencodePhotoJpeg(stripped)).toEqual(stripped);
    const oversizedDimensions = image.slice();
    oversizedDimensions.set([255,255,255,255], index + 5);
    expect(() => reencodePhotoJpeg(oversizedDimensions)).toThrow();
  });
  test("caption fallback and catalog capability tags are authoritative", () => {
    expect(photoCaption({ caption: "  " })).toBe("What is in this picture?");
    expect(photoCaption({ caption: " Describe it " })).toBe("Describe it");
    expect(photoCapability({ capabilities: ["vision"] }).vision).toBe(true);
    expect(photoCapability({ capabilities: [], input_modalities: ["image"] }).vision).toBe(false);
    const reply = visionReply("text-model", [1,2,3,4].map((n) => ({ id: `vision-${n}`, vision: true })));
    expect(reply).toContain("vision-1, vision-2, vision-3"); expect(reply).not.toContain("vision-4"); expect(reply).toContain("/model");
  });
  test("selects the largest fitting size, excluding advertised oversize without downloading it", async () => {
    const tg = telegram(), ids: string[] = [];
    const url = await prepareTelegramPhoto([photo("small", 4, 50), photo("too-large", 32, MAX_PHOTO_BYTES + 1), photo("largest", 16, image.length)], { token: TOKEN, fetch: tg.fetch, getFile: async (id) => { ids.push(id); return { file_path: "photos/photo.jpg", file_size: image.length }; } });
    expect(ids).toEqual(["largest"]); expect(tg.downloads).toHaveLength(1); expect(url).toStartWith("data:image/jpeg;base64,");
  });
  test("getFile size verification falls back and all-oversized photos are refused", async () => {
    const tg = telegram(), ids: string[] = [];
    await prepareTelegramPhoto([photo("big", 16), photo("small", 8)], { token: TOKEN, fetch: tg.fetch, getFile: async (id) => { ids.push(id); return { file_path: "photos/photo.jpg", file_size: id === "big" ? MAX_PHOTO_BYTES + 1 : image.length }; } });
    expect(ids).toEqual(["big", "small"]); expect(tg.downloads).toHaveLength(1);
    await expect(prepareTelegramPhoto([photo("big", 16, MAX_PHOTO_BYTES + 1)], { token: TOKEN, fetch: tg.fetch, getFile: async () => { throw new Error("should not call"); } })).rejects.toThrow("8 MB");
  });
  test("enforces streaming and Content-Length limits, cancels oversized bodies and allows fallback", async () => {
    const tg = telegram(); let cancelled = 0;
    tg.setResponse(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_PHOTO_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } })));
    await expect(prepareTelegramPhoto([photo()], { token: TOKEN, fetch: tg.fetch, getFile: async () => ({ file_path: "photos/photo.jpg" }) })).rejects.toThrow("8 MB");
    expect(cancelled).toBe(1);
    tg.setResponse(() => new Response(image, { headers: { "content-length": String(MAX_PHOTO_BYTES + 1) } }));
    await expect(prepareTelegramPhoto([photo()], { token: TOKEN, fetch: tg.fetch, getFile: async () => ({ file_path: "photos/photo.jpg" }) })).rejects.toThrow("8 MB");
    let tries = 0;
    tg.setResponse(() => ++tries === 1 ? new Response(image, { headers: { "content-length": String(MAX_PHOTO_BYTES + 1) } }) : new Response(image));
    await expect(prepareTelegramPhoto([photo("big", 16), photo("small")], { token: TOKEN, fetch: tg.fetch, getFile: async () => ({ file_path: "photos/photo.jpg" }) })).resolves.toStartWith("data:image/jpeg;base64,");
  });
  test("rejects unsafe paths and sanitizes token-bearing transport errors", async () => {
    const tg = telegram();
    for (const file_path of ["../photo.jpg", "https://other.invalid/photo.jpg", "photos/a.jpg?token=secret"]) {
      await expect(prepareTelegramPhoto([photo()], { token: TOKEN, fetch: tg.fetch, getFile: async () => ({ file_path }) })).rejects.toThrow("download");
    }
    expect(tg.downloads).toHaveLength(0);
    await expect(prepareTelegramPhoto([photo()], { token: TOKEN, getFile: async () => { throw new Error(TOKEN); } })).rejects.toThrow("download");
  });
});

describe("Telegram photo chat path", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter({ env: { TELEGRAM_PHOTOS_ENABLED: "true" } }); });
  afterAll(async () => { await h.close(); });
  const fresh = () => {
    const tg = telegram(), chats: { body: any; headers: Headers }[] = [], paths: string[] = [];
    const router: RouterCall = async (path, init) => {
      paths.push(path);
      if (path.startsWith("/api/v1/models")) return Response.json({ data: [{ id: LLAMA, capabilities: ["vision"], pricing: { prompt: "0.0000001", completion: "0.00000032" } }, { id: MODELS.qwen.slug, capabilities: [], pricing: { prompt: "0.0000002", completion: "0.0000006" } }] });
      if (path === "/api/v1/chat/completions") chats.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return h.app.request(path, init);
    };
    const bot = new TelegramBot(h.ctx, { token: TOKEN, router, fetch: tg.fetch });
    const connect = async () => { const user = ++uid, key = await h.fundedKey(); await bot.handleUpdate(update(user, { text: `/key ${key.secret}` })); return { user, key }; };
    return { tg, chats, paths, bot, connect };
  };
  test("default-off config and disabled photo reply leave the existing path unchanged", async () => {
    expect(loadConfig({}).telegramPhotosEnabled).toBe(false);
    h.ctx.cfg.telegramPhotosEnabled = false;
    const f = fresh();
    try {
      await f.bot.handleUpdate(update(++uid, { photo: [photo()], caption: "caption" }));
      expect(f.tg.last()).toBe("I can only read text messages. Send me a question, or /help.");
      expect(f.tg.downloads).toHaveLength(0); expect(f.paths).toEqual([]);
      await f.bot.handleUpdate(update(uid, { text: "/help" })); expect(f.tg.last()).not.toContain("EXIF");
    } finally { h.ctx.cfg.telegramPhotosEnabled = true; }
  });
  test("photo with caption uses the connected key, bills normally and returns a verifiable receipt without storing the image", async () => {
    const f = fresh(), { user, key } = await f.connect();
    const [before] = await h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user)));
    await f.bot.handleUpdate(update(user, { photo: [photo()], caption: "unique-photo-caption-marker" }));
    expect(f.tg.calls.filter((x) => x.method === "getFile").map((x) => x.params)).toEqual([{ file_id: "photo-file-marker" }]);
    expect(f.tg.downloads[0].init.redirect).toBe("error");
    expect(f.chats).toHaveLength(1); expect(f.chats[0].headers.get("authorization")).toBe(`Bearer ${key.secret}`);
    const body = f.chats[0].body, content = body.messages[0].content;
    expect(body.model).toBe(LLAMA); expect(body.cache).toBeUndefined(); expect(content[0]).toEqual({ type: "text", text: "unique-photo-caption-marker" });
    const data = content[1].image_url.url as string;
    expect(Buffer.from(data.split(",")[1], "base64")).toEqual(Buffer.from(reencodePhotoJpeg(image)));
    const id = /receipts\/(gen-[\w-]+)/.exec(f.tg.last())?.[1]; expect(id).toBeDefined();
    const receipt = (await (await h.request(`/api/v1/receipts/${id}`)).json()).data;
    expect(receipt.id).toBe(id); expect(typeof receipt.sig).toBe("string"); expect(Number(receipt.payload.cost)).toBeGreaterThan(0);
    const [after] = await h.ctx.db.select().from(kv).where(eq(kv.key, userKey(user))); expect(after).toEqual(before);
    const persisted = JSON.stringify([await h.ctx.db.select().from(kv), await h.ctx.db.select().from(generations)], (_, value) => typeof value === "bigint" ? value.toString() : value);
    for (const marker of [data, "unique-photo-caption-marker", "photo-file-marker", "photos/photo.jpg", "photo-metadata-marker"]) expect(persisted).not.toContain(marker);
  });
  test("no-caption photos use the fixed question and help describes readable in-memory processing", async () => {
    const f = fresh(), { user } = await f.connect();
    await f.bot.handleUpdate(update(user, { photo: [photo()] })); expect(f.chats[0].body.messages[0].content[0].text).toBe("What is in this picture?");
    await f.bot.handleUpdate(update(user, { text: "/help" }));
    expect(f.tg.last()).toContain("Anyroute reads the photo and caption in memory"); expect(f.tg.last()).toContain("EXIF"); expect(f.tg.last()).toContain("not saved");
  });
  test("unconnected, non-private and bot senders cannot download or infer", async () => {
    const f = fresh();
    await f.bot.handleUpdate(update(++uid, { photo: [photo()] })); expect(f.tg.last()).toContain("Connect your AnyRoute key first");
    await f.bot.handleUpdate(update(uid, { photo: [photo()], chat: { id: uid, type: "group" } }));
    await f.bot.handleUpdate(update(uid, { photo: [photo()], from: { id: uid, is_bot: true } }));
    expect(f.tg.downloads).toHaveLength(0); expect(f.chats).toHaveLength(0);
  });
  test("key-like captions are deleted and never reach a model", async () => {
    const f = fresh(), { user, key } = await f.connect();
    await f.bot.handleUpdate(update(user, { photo: [photo()], caption: `/key ${key.secret}` }));
    expect(f.tg.last()).toContain("did not send it to any model"); expect(f.tg.last()).not.toContain(key.secret);
    expect(f.tg.downloads).toHaveLength(0); expect(f.chats).toHaveLength(0);
  });
  test("non-vision model replies with available vision choices and switching instructions without download or billing", async () => {
    const f = fresh(), { user } = await f.connect();
    await f.bot.handleUpdate(update(user, { text: `/model ${MODELS.qwen.slug}` }));
    await f.bot.handleUpdate(update(user, { photo: [photo()] }));
    expect(f.tg.last()).toContain(`${MODELS.qwen.slug} can't read images`); expect(f.tg.last()).toContain(LLAMA); expect(f.tg.last()).toContain("/model");
    expect(f.tg.downloads).toHaveLength(0); expect(f.chats).toHaveLength(0);
  });
  test("oversized and invalid photos never reach inference and busy state is released", async () => {
    const f = fresh(), { user } = await f.connect();
    await f.bot.handleUpdate(update(user, { photo: [photo("oversized", 8, MAX_PHOTO_BYTES + 1)] }));
    expect(f.tg.last()).toContain("8 MB"); expect(f.tg.downloads).toHaveLength(0); expect(f.chats).toHaveLength(0);
    f.tg.setResponse(() => new Response("invalid JPEG"));
    await f.bot.handleUpdate(update(user, { photo: [photo()] })); expect(f.chats).toHaveLength(0);
    f.tg.setResponse(() => new Response(image));
    await f.bot.handleUpdate(update(user, { photo: [photo()] })); expect(f.chats).toHaveLength(1);
  });
  test("private photo input keeps the attested lane and withholds answers without an attested receipt", async () => {
    const f = fresh(), { user } = await f.connect();
    await f.bot.handleUpdate(update(user, { text: "/private on" }));
    await f.bot.handleUpdate(update(user, { photo: [photo()] }));
    expect(f.paths).toContain("/api/v1/models?lane=attested"); expect(f.chats[0].body.provider).toEqual({ lane: "attested" });
    expect(f.tg.last()).toContain("No provider with a proven enclave"); expect(f.tg.last()).not.toContain("Hello from");
  });
});
