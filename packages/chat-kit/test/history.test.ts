import { describe, expect, test } from "bun:test";
import { createEncryptedHistory, generateViewingKey, HistoryError, localStorageStorage, memoryStorage, type CustomKdf, type SealedHistory } from "../src";
import { apiUrl, retryAfterMs, sseEvents } from "../src/client";

const FAST = 100_000; // the lowest round count a stored history may claim
const msgs = (q: string, a: string) => [
  { id: "u1", role: "user" as const, text: q, attachments: [{ name: "pic.png", type: "image/png", url: "data:image/png;base64,AAAA" }] },
  { id: "a1", role: "assistant" as const, text: a, status: "done" as const, receipt: { id: "rcpt_9" } },
];

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HistoryError ? e.code : String(e);
  }
};

describe("encrypted history", () => {
  test("passphrase round trip: nothing readable is stored, a wrong passphrase fails, lock drops the key", async () => {
    const storage = memoryStorage();
    const h = createEncryptedHistory({ storage, iterations: FAST });
    expect(await code(h.create({ passphrase: "short" }))).toBe("weak_passphrase");
    await h.create({ passphrase: "a long passphrase" });
    await h.put({ id: "c1", messages: msgs("where is the treasure", "under the old oak") });
    const stored = (await storage.get())!;
    expect(stored).toMatchObject({ v: 1, kdf: "PBKDF2-SHA256", iterations: FAST });
    expect(Object.keys(stored).sort()).toEqual(["ct", "iterations", "iv", "kdf", "kind", "salt", "v"]);
    expect(JSON.stringify(stored)).not.toContain("treasure");
    expect(JSON.stringify(stored)).not.toContain("oak");

    h.lock();
    expect(h.unlocked).toBe(false);
    expect(h.list()).toEqual([]);
    expect(await code(h.unlock({ passphrase: "the wrong passphrase" }))).toBe("wrong_secret");
    await h.unlock({ passphrase: "a long passphrase" });
    const chat = h.get("c1")!;
    expect(chat.title).toBe("where is the treasure");
    expect(chat.messages[1].text).toBe("under the old oak");
    expect(chat.messages[0].attachments).toEqual([{ name: "pic.png", type: "image/png", url: "" }]);

    // A fresh IV on every write.
    const iv1 = (await storage.get())!.iv;
    await h.put({ id: "c2", messages: msgs("q", "a") });
    expect((await storage.get())!.iv).not.toBe(iv1);
    expect(h.list().map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  test("the KDF parameters are bound to the ciphertext", async () => {
    const storage = memoryStorage();
    const h = createEncryptedHistory({ storage, iterations: FAST + 1 });
    await h.create({ passphrase: "a long passphrase" });
    const r = (await storage.get())!;
    await storage.set({ ...r, iterations: FAST });
    h.lock();
    expect(await code(h.unlock({ passphrase: "a long passphrase" }))).toBe("wrong_secret");
    await storage.set({ ...r, ct: "AAAA" });
    expect(await code(h.unlock({ passphrase: "a long passphrase" }))).toBe("wrong_secret");
    await storage.set({ ...r, v: 9 } as SealedHistory);
    expect(await code(h.unlock({ passphrase: "a long passphrase" }))).toBe("unreadable");
  });

  test("viewing key: a random 32-byte key opens it, a passphrase or another key does not", async () => {
    const key = generateViewingKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const storage = memoryStorage();
    const h = createEncryptedHistory({ storage });
    await h.create({ key });
    await h.put({ id: "c1", messages: msgs("hello", "hi") });
    expect((await storage.get())!.kdf).toBe("raw-256");
    h.lock();
    expect(await code(h.unlock({ key: generateViewingKey() }))).toBe("wrong_secret");
    expect(await code(h.unlock({ key: "not-a-key" }))).toBe("bad_key");
    expect(await code(h.unlock({ passphrase: key }))).not.toBe("ok");
    await h.unlock({ key });
    expect(h.get("c1")!.messages[0].text).toBe("hello");
  });

  test("export and import move the encrypted blob between browsers", async () => {
    const a = createEncryptedHistory({ storage: memoryStorage(), iterations: FAST });
    await a.create({ passphrase: "move me somewhere" });
    await a.put({ id: "c1", messages: msgs("portable", "yes") });
    const blob = await a.exportBlob();
    expect(blob).not.toContain("portable");

    const bStorage = memoryStorage();
    const b = createEncryptedHistory({ storage: bStorage, iterations: FAST });
    expect(await code(b.importBlob(blob, { passphrase: "not the passphrase" }))).toBe("wrong_secret");
    expect(await bStorage.get()).toBeNull();
    expect(await code(b.importBlob("{nope", { passphrase: "move me somewhere" }))).toBe("unreadable");
    await b.importBlob(blob, { passphrase: "move me somewhere" });
    expect(b.unlocked).toBe(true);
    expect(b.get("c1")!.messages[1].text).toBe("yes");
    expect(await bStorage.get()).toEqual(JSON.parse(blob));
  });

  test("localStorage storage, forget, and a custom KDF (the Argon2id hook)", async () => {
    const mem = new Map<string, string>();
    const ls = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } as Storage;
    // A stand-in KDF (SHA-256 of salt and passphrase); a real app would pass argon2id from a WASM library.
    const kdf: CustomKdf = { name: "test-sha256", derive: async (p, salt) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...salt, ...new TextEncoder().encode(p)]))) };
    const h = createEncryptedHistory({ storage: localStorageStorage({ storage: ls, key: "k" }), kdf });
    await h.create({ passphrase: "custom kdf phrase" });
    await h.put({ id: "c1", messages: msgs("q", "a") });
    expect(JSON.parse(mem.get("k")!).kdf).toBe("test-sha256");
    h.lock();
    await h.unlock({ passphrase: "custom kdf phrase" });
    expect(h.list().length).toBe(1);
    expect(await code(createEncryptedHistory({ storage: localStorageStorage({ storage: ls, key: "k" }) }).unlock({ passphrase: "custom kdf phrase" }))).toBe("unsupported");
    await h.forget();
    expect(mem.has("k")).toBe(false);
    expect(await h.exists()).toBe(false);
  });
});

describe("wire helpers", () => {
  test("SSE parsing across split chunks, comments and [DONE]", async () => {
    const parts = [": keep-alive\n\n", 'data: {"choices":[{"delta":{"content":"He', 'llo"}}]}\n\n', 'data: {"receipt":{"id":"r"}}\r\n\r\n', "data: [DONE]\n\n"];
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const out = [];
    for await (const ev of sseEvents(body)) out.push(ev);
    expect(out).toEqual([{ choices: [{ delta: { content: "Hello" } }] }, { receipt: { id: "r" } }]);
  });

  test("Retry-After as seconds, as a date, or from the body", () => {
    expect(retryAfterMs("3")).toBe(3000);
    const soon = new Date(Date.now() + 10_000).toUTCString();
    expect(retryAfterMs(soon)).toBeGreaterThan(5000);
    expect(retryAfterMs(null, { error: { metadata: { retry_after_ms: 1500 } } })).toBe(1500);
    expect(retryAfterMs(null, {})).toBeNull();
  });

  test("base URLs with or without /api/v1", () => {
    expect(apiUrl("https://r.test/", "/api/v1/models")).toBe("https://r.test/api/v1/models");
    expect(apiUrl("https://r.test/api/v1", "/api/v1/models")).toBe("https://r.test/api/v1/models");
    expect(apiUrl("https://r.test/v1", "/api/v1/models")).toBe("https://r.test/api/v1/models");
    expect(apiUrl("", "/api/v1/models")).toBe("/api/v1/models");
  });
});
