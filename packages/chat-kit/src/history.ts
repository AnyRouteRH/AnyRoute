// Chat history kept only in the viewer's browser, encrypted under a viewing key the viewer holds.
//
// The same construction as the Anyroute Harness private-mode history:
//   - AES-GCM (256 bit) over the whole history, a fresh random 12-byte IV on every write;
//   - the key comes from a passphrase through PBKDF2 (HMAC-SHA-256, 600 000 rounds, random 16-byte salt), or is a
//     random 32-byte viewing key the viewer keeps (generateViewingKey), or comes from your own KDF (Argon2id, say:
//     WebCrypto has none, so pass `kdf` with a WASM implementation);
//   - the key is a non-extractable CryptoKey held in memory while unlocked; lock() and forget() drop it;
//   - the stored record holds only the KDF name, its parameters, the IV and the ciphertext: no titles, dates or counts.
//     The KDF parameters are bound into the AES-GCM additional data, so they cannot be swapped for weaker ones;
//   - nothing here touches the network. exportBlob() hands out the record as it is stored (still encrypted), and
//     importBlob() only accepts a blob that opens under the secret given.
// There is no recovery: a lost passphrase or viewing key means the history cannot be read.

import type { ChatMessage } from "./types";

export const HISTORY_VERSION = 1;
export const PBKDF2 = "PBKDF2-SHA256";
export const RAW_KEY = "raw-256";
export const ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 8;
export const MAX_CHATS = 50;
export const MAX_BYTES = 2_000_000;
const MIN_ROUNDS = 100_000;
const MAX_ROUNDS = 10_000_000;
const KIND = "anyroute-chat-kit/history";

const enc = new TextEncoder();
const dec = new TextDecoder();

export type HistoryErrorCode = "wrong_secret" | "unreadable" | "exists" | "weak_passphrase" | "bad_key" | "locked" | "no_vault" | "too_large" | "unsupported";

const MESSAGES: Record<HistoryErrorCode, string> = {
  wrong_secret: "That passphrase or key does not open this history.",
  unreadable: "This history cannot be read.",
  exists: "There is already a history here.",
  weak_passphrase: `Use at least ${MIN_PASSPHRASE} characters.`,
  bad_key: "That is not a viewing key.",
  locked: "The history is locked.",
  no_vault: "There is no history here.",
  too_large: "This conversation is too large to keep.",
  unsupported: "This browser cannot encrypt a history.",
};

export class HistoryError extends Error {
  readonly code: HistoryErrorCode;
  constructor(code: HistoryErrorCode) {
    super(MESSAGES[code]);
    this.name = "HistoryError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- bytes

export const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toB64url = (b: Uint8Array) => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (t: string) => fromBase64(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4));
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

// ---------------------------------------------------------------- keys

/** A secret that opens a history: a passphrase, or a viewing key from generateViewingKey(). */
export type ViewingSecret = { passphrase: string } | { key: string };

/** Your own key derivation (for Argon2id, say). `derive` must return 32 bytes and be deterministic for (passphrase, salt). */
export interface CustomKdf {
  name: string;
  derive(passphrase: string, salt: Uint8Array): Promise<Uint8Array>;
}

/** A new random viewing key (32 bytes, base64url). Show it to the viewer once; the kit never stores it in the clear. */
export function generateViewingKey(crypto: Crypto = globalThis.crypto): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The encrypted record as stored and as exported. */
export interface SealedHistory {
  v: number;
  kind: string;
  kdf: string;
  iterations?: number;
  salt?: string;
  iv: string;
  ct: string;
}

const aad = (h: Pick<SealedHistory, "kdf" | "iterations" | "salt">) => enc.encode(`${KIND}/${HISTORY_VERSION}|${h.kdf}|${h.iterations ?? ""}|${h.salt ?? ""}`);

export function isSealed(r: unknown): r is SealedHistory {
  const x = r as SealedHistory;
  if (!x || typeof x !== "object" || x.v !== HISTORY_VERSION || x.kind !== KIND || typeof x.kdf !== "string" || typeof x.iv !== "string" || typeof x.ct !== "string") return false;
  if (x.kdf === PBKDF2) return Number.isInteger(x.iterations) && x.iterations! >= MIN_ROUNDS && x.iterations! <= MAX_ROUNDS && typeof x.salt === "string";
  if (x.kdf === RAW_KEY) return x.salt === undefined;
  return typeof x.salt === "string";
}

type Header = Pick<SealedHistory, "kdf" | "iterations" | "salt">;

async function deriveKey(subtle: SubtleCrypto, secret: ViewingSecret, header: Header, kdf?: CustomKdf): Promise<CryptoKey> {
  const aes = { name: "AES-GCM", length: 256 } as const;
  if ("key" in secret) {
    if (header.kdf !== RAW_KEY) throw new HistoryError("wrong_secret");
    let raw: Uint8Array;
    try {
      raw = fromB64url(String(secret.key).trim());
    } catch {
      throw new HistoryError("bad_key");
    }
    if (raw.length !== 32) throw new HistoryError("bad_key");
    return subtle.importKey("raw", buf(raw), aes, false, ["encrypt", "decrypt"]);
  }
  const pass = String(secret.passphrase ?? "").normalize("NFKC");
  const salt = fromBase64(header.salt ?? "");
  if (header.kdf === PBKDF2) {
    const base = await subtle.importKey("raw", buf(enc.encode(pass)), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations: header.iterations! }, base, aes, false, ["encrypt", "decrypt"]);
  }
  if (kdf && header.kdf === kdf.name) {
    const raw = await kdf.derive(pass, salt);
    if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new HistoryError("unsupported");
    return subtle.importKey("raw", buf(raw), aes, false, ["encrypt", "decrypt"]);
  }
  throw new HistoryError(header.kdf === RAW_KEY ? "wrong_secret" : "unsupported");
}

// ---------------------------------------------------------------- storage

export interface HistoryStorage {
  /** False where the record lives in memory only and is gone when the page closes. */
  persistent: boolean;
  get(): Promise<SealedHistory | null>;
  set(record: SealedHistory): Promise<void>;
  delete(): Promise<void>;
}

export function memoryStorage(): HistoryStorage {
  let held: SealedHistory | null = null;
  return {
    persistent: false,
    get: async () => (held ? { ...held } : null),
    set: async (r) => void (held = { ...r }),
    delete: async () => void (held = null),
  };
}

/** The record in localStorage (or any Storage) under one key. */
export function localStorageStorage({ key = "anyroute-chat-kit-history", storage }: { key?: string; storage?: Storage } = {}): HistoryStorage {
  const s = storage ?? (globalThis as { localStorage?: Storage }).localStorage;
  if (!s) return memoryStorage();
  return {
    persistent: true,
    get: async () => {
      const raw = s.getItem(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return { v: -1 } as unknown as SealedHistory;
      }
    },
    set: async (r) => s.setItem(key, JSON.stringify(r)),
    delete: async () => s.removeItem(key),
  };
}

/** The record in IndexedDB (one database, one record). Falls back to memory where IndexedDB is missing. */
export function indexedDBStorage({ name = "anyroute-chat-kit-history", indexedDB }: { name?: string; indexedDB?: IDBFactory } = {}): HistoryStorage {
  const idb = indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return memoryStorage();
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("vault");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB is not available."));
    });
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("vault", mode);
        const req = op(tx.objectStore("vault"));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write failed."));
      });
    } finally {
      db.close();
    }
  };
  return {
    persistent: true,
    get: async () => ((await run("readonly", (s) => s.get("history"))) as SealedHistory | undefined) ?? null,
    set: (r) => run("readwrite", (s) => s.put(r, "history")).then(() => undefined),
    delete: () => run("readwrite", (s) => s.delete("history")).then(() => undefined),
  };
}

/** IndexedDB where the browser has it, else localStorage, else memory. */
export function browserStorage(name = "anyroute-chat-kit-history"): HistoryStorage {
  const g = globalThis as { indexedDB?: IDBFactory; localStorage?: Storage };
  if (g.indexedDB) return indexedDBStorage({ name });
  if (g.localStorage) return localStorageStorage({ key: name });
  return memoryStorage();
}

// ---------------------------------------------------------------- the history

/** A kept conversation. Attachments are kept by name only (their bytes are not stored). */
export interface SavedChat {
  id: string;
  title: string;
  at: number;
  model?: string;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  at: number;
  turns: number;
}

export interface EncryptedHistory {
  readonly persistent: boolean;
  readonly unlocked: boolean;
  exists(): Promise<boolean>;
  /** Start a new, empty history under a passphrase or a viewing key, and leave it unlocked. */
  create(secret: ViewingSecret): Promise<void>;
  unlock(secret: ViewingSecret): Promise<void>;
  list(): ChatSummary[];
  get(id: string): SavedChat | null;
  put(chat: { id: string; title?: string; model?: string; messages: ChatMessage[] }): Promise<void>;
  remove(id: string): Promise<void>;
  lock(): void;
  forget(): Promise<void>;
  /** The stored record as JSON text, still encrypted. Safe to download or copy elsewhere. */
  exportBlob(): Promise<string>;
  /** Replace this history with an exported blob, if it opens under `secret`. Leaves it unlocked. */
  importBlob(blob: string, secret: ViewingSecret): Promise<void>;
  subscribe(fn: () => void): () => void;
}

export interface HistoryOptions {
  storage?: HistoryStorage;
  crypto?: Crypto;
  /** PBKDF2 rounds for a new passphrase history (an existing one keeps its own count). */
  iterations?: number;
  /** Your own KDF for passphrases (Argon2id, say). Used for new passphrase histories when given. */
  kdf?: CustomKdf;
  now?: () => number;
}

/** The first thing the person said, as a short title. */
export function titleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.text.trim());
  return first ? first.text.trim().replace(/\s+/g, " ").slice(0, 60) : "Untitled";
}

/** What is kept of a message: its text and facts, not attachment bytes or a half-streamed state. */
export function keepable(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { ...m, attachments: m.attachments?.map((a) => ({ name: a.name, type: a.type, url: "" })) };
  if (out.status === "streaming") out.status = "stopped";
  return out;
}

export function createEncryptedHistory(opts: HistoryOptions = {}): EncryptedHistory {
  const storage = opts.storage ?? browserStorage();
  const crypto = opts.crypto ?? globalThis.crypto;
  const iterations = opts.iterations ?? ITERATIONS;
  const now = opts.now ?? (() => Date.now());
  let session: { key: CryptoKey; header: Header; chats: SavedChat[] } | null = null;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((f) => f());
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  const subtle = () => {
    if (!crypto?.subtle) throw new HistoryError("unsupported");
    return crypto.subtle;
  };
  const need = () => {
    if (!session) throw new HistoryError("locked");
    return session;
  };

  async function newHeader(secret: ViewingSecret): Promise<Header> {
    if ("key" in secret) return { kdf: RAW_KEY };
    if (String(secret.passphrase ?? "").length < MIN_PASSPHRASE) throw new HistoryError("weak_passphrase");
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    return opts.kdf ? { kdf: opts.kdf.name, salt } : { kdf: PBKDF2, iterations, salt };
  }

  async function seal(key: CryptoKey, header: Header, chats: SavedChat[]): Promise<SealedHistory> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(aad(header)) }, key, buf(enc.encode(JSON.stringify({ chats })))));
    return { v: HISTORY_VERSION, kind: KIND, ...header, iv: toBase64(iv), ct: toBase64(ct) };
  }

  async function open(record: unknown, secret: ViewingSecret) {
    if (!isSealed(record)) throw new HistoryError("unreadable");
    const header: Header = { kdf: record.kdf, iterations: record.iterations, salt: record.salt };
    const key = await deriveKey(subtle(), secret, header, opts.kdf);
    let plain: ArrayBuffer;
    try {
      plain = await subtle().decrypt({ name: "AES-GCM", iv: buf(fromBase64(record.iv)), additionalData: buf(aad(header)) }, key, buf(fromBase64(record.ct)));
    } catch {
      throw new HistoryError("wrong_secret");
    }
    let doc: { chats?: unknown };
    try {
      doc = JSON.parse(dec.decode(plain));
    } catch {
      throw new HistoryError("unreadable");
    }
    if (!Array.isArray(doc?.chats)) throw new HistoryError("unreadable");
    return { key, header, chats: doc.chats as SavedChat[] };
  }

  const write = async (chats: SavedChat[]) => {
    const s = need();
    await storage.set(await seal(s.key, s.header, chats));
    s.chats = chats;
    notify();
  };

  return {
    persistent: storage.persistent,
    get unlocked() {
      return !!session;
    },
    exists: async () => !!(await storage.get()),
    create: (secret) =>
      serial(async () => {
        const header = await newHeader(secret);
        if (await storage.get()) throw new HistoryError("exists");
        const key = await deriveKey(subtle(), secret, header, opts.kdf);
        await storage.set(await seal(key, header, []));
        session = { key, header, chats: [] };
        notify();
      }),
    unlock: (secret) =>
      serial(async () => {
        const record = await storage.get();
        if (!record) throw new HistoryError("no_vault");
        session = await open(record, secret);
        notify();
      }),
    list: () => (session ? session.chats.map((c) => ({ id: c.id, title: c.title, at: c.at, turns: c.messages.filter((m) => m.role === "user").length })) : []),
    get: (id) => {
      const chat = need().chats.find((c) => c.id === id);
      return chat ? structuredClone(chat) : null;
    },
    put: (chat) =>
      serial(async () => {
        const s = need();
        const messages = chat.messages.filter((m) => m.text || m.role === "user").map(keepable);
        const entry: SavedChat = { id: String(chat.id), title: String(chat.title || titleOf(messages)).slice(0, 80), at: now(), model: chat.model, messages };
        const size = (list: SavedChat[]) => enc.encode(JSON.stringify({ chats: list })).length;
        if (size([entry]) > MAX_BYTES) throw new HistoryError("too_large");
        let chats = [entry, ...s.chats.filter((c) => c.id !== entry.id)].slice(0, MAX_CHATS);
        while (chats.length > 1 && size(chats) > MAX_BYTES) chats = chats.slice(0, -1);
        await write(chats);
      }),
    remove: (id) => serial(() => write(need().chats.filter((c) => c.id !== id))),
    lock: () => {
      session = null;
      notify();
    },
    forget: () =>
      serial(async () => {
        session = null;
        await storage.delete();
        notify();
      }),
    exportBlob: () =>
      serial(async () => {
        const record = await storage.get();
        if (!record) throw new HistoryError("no_vault");
        return JSON.stringify(record);
      }),
    importBlob: (blob, secret) =>
      serial(async () => {
        let record: unknown;
        try {
          record = JSON.parse(blob);
        } catch {
          throw new HistoryError("unreadable");
        }
        const opened = await open(record, secret);
        await storage.set(record as SealedHistory);
        session = opened;
        notify();
      }),
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
