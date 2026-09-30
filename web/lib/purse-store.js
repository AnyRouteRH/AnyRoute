// Where the page keeps things, and how it lets go of them.
//
//   the one-time key   in memory (KeyHolder) and, so a reload does not strand a deposit, in this tab's sessionStorage.
//                      Never localStorage, never IndexedDB. Discarding overwrites the memory copy and removes the stored one.
//   the finished tokens in IndexedDB ("Purse"), so they outlive the tab. If IndexedDB is unavailable the page says so and
//                      the download is the only copy; nothing here pretends a write worked.
//
// Every browser API is passed in (defaulting to the real one) so each failure path can be exercised without a browser.

export const SESSION_ITEM = "anyroute-private-tokens-session-v1";
export const DB_NAME = "anyroute-private-tokens";
export const DB_VERSION = 1;

// ---- the key in memory -------------------------------------------------------------------------------------------

/**
 * Holds a secret as bytes so it can be overwritten. JavaScript strings cannot be erased, so `reveal()` hands out a string
 * only for the moment a request needs it; `wipe()` zeroes the bytes and drops the reference. This is best effort, and it
 * is why the key is never kept in a longer-lived place than it needs.
 */
export class KeyHolder {
  #bytes;
  constructor(secret, { buffer } = {}) {
    const encoded = new TextEncoder().encode(String(secret));
    if (buffer) {
      if (buffer.length < encoded.length) throw new Error("buffer too small");
      buffer.set(encoded);
      this.#bytes = buffer.subarray(0, encoded.length);
    } else this.#bytes = encoded;
  }
  get present() {
    return this.#bytes !== null;
  }
  reveal() {
    if (this.#bytes === null) throw new Error("The one-time key has been discarded.");
    return new TextDecoder().decode(this.#bytes);
  }
  wipe() {
    if (this.#bytes !== null) {
      this.#bytes.fill(0);
      this.#bytes = null;
    }
  }
}

// ---- the key in this tab's sessionStorage -----------------------------------------------------------------------

function sessionArea(area) {
  if (area === null) return null; // the caller says there is none
  try {
    return area ?? globalThis.sessionStorage ?? null; // merely reading sessionStorage can throw when storage is blocked
  } catch {
    return null;
  }
}

/** Keep the record (it holds the key) for this tab. Returns { ok } and never throws: blocked or full storage is a state, not a crash. */
export function saveSession(record, area) {
  const store = sessionArea(area);
  if (!store) return { ok: false, error: "This browser does not allow session storage here." };
  try {
    store.setItem(SESSION_ITEM, JSON.stringify({ v: 1, ...record }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.name === "QuotaExceededError" ? "Session storage is full." : "This browser refused to store the key for this tab." };
  }
}

/** The stored record, or null. A value that is unreadable or of another shape is removed rather than trusted. */
export function loadSession(area) {
  const store = sessionArea(area);
  if (!store) return null;
  let raw;
  try {
    raw = store.getItem(SESSION_ITEM);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    const doc = JSON.parse(raw);
    if (doc && doc.v === 1 && typeof doc.secret === "string" && /^sk-ar-v1-[0-9a-f]{64}$/.test(doc.secret) && (doc.method === "usdg" || doc.method === "anyr")) return doc;
  } catch {
    /* fall through: not ours */
  }
  clearSession(store);
  return null;
}

/**
 * Remove the stored record and check that it is gone. If removal throws, overwrite it with an empty value, since an
 * empty item holds no key. Returns { ok, overwritten }: ok is false only when a key may still be readable.
 */
export function clearSession(area) {
  const store = sessionArea(area);
  if (!store) return { ok: true, overwritten: false };
  let removeFailed = false;
  try {
    store.removeItem(SESSION_ITEM);
  } catch {
    removeFailed = true;
  }
  let present = true;
  try {
    present = store.getItem(SESSION_ITEM) !== null;
  } catch {
    present = removeFailed; // cannot look: if removal threw, assume it is still there
  }
  if (!present) return { ok: true, overwritten: false };
  try {
    store.setItem(SESSION_ITEM, "");
    return { ok: true, overwritten: true };
  } catch {
    return { ok: false, overwritten: false };
  }
}

// ---- the tokens in IndexedDB --------------------------------------------------------------------------------------

export class PurseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PurseError";
    this.code = code; // unavailable | blocked | quota | failed
  }
}

function wrap(e) {
  if (e instanceof PurseError) return e;
  if (e?.name === "QuotaExceededError") return new PurseError("quota", "The browser has no room left to store the tokens.");
  return new PurseError("failed", e?.message ? `The browser could not read or write the stored tokens (${e.message}).` : "The browser could not read or write the stored tokens.");
}

/** Run one transaction; resolves with what `fn` returns once the transaction has committed, rejects if it aborts. */
function transact(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(wrap(e));
      return;
    }
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(wrap(tx.error));
    tx.onabort = () => reject(wrap(tx.error ?? new Error("aborted")));
    try {
      result = fn(tx);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      reject(wrap(e));
    }
  });
}

/** The stored tokens. `tokens` holds finished tokens; `pending` holds purchases sent but not yet unblinded. */
export class Purse {
  #db;
  constructor(db) {
    this.#db = db;
  }
  async list() {
    return transact(this.#db, ["tokens"], "readonly", (tx) => {
      const out = [];
      const req = tx.objectStore("tokens").getAll();
      req.onsuccess = () => out.push(...req.result);
      return out;
    });
  }
  /** All or nothing: if any write fails the transaction aborts and none of the entries is stored. */
  async add(entries) {
    if (!entries.length) return;
    await transact(this.#db, ["tokens"], "readwrite", (tx) => {
      const store = tx.objectStore("tokens");
      for (const e of entries) store.put(e);
    });
  }
  async remove(tokens) {
    if (!tokens.length) return;
    await transact(this.#db, ["tokens"], "readwrite", (tx) => {
      const store = tx.objectStore("tokens");
      for (const t of tokens) store.delete(t);
    });
  }
  async clear() {
    await transact(this.#db, ["tokens"], "readwrite", (tx) => {
      tx.objectStore("tokens").clear();
    });
  }
  async listPending() {
    return transact(this.#db, ["pending"], "readonly", (tx) => {
      const out = [];
      const req = tx.objectStore("pending").getAll();
      req.onsuccess = () => out.push(...req.result);
      return out;
    });
  }
  async putPending(record) {
    await transact(this.#db, ["pending"], "readwrite", (tx) => {
      tx.objectStore("pending").put(record);
    });
  }
  async removePending(id) {
    await transact(this.#db, ["pending"], "readwrite", (tx) => {
      tx.objectStore("pending").delete(id);
    });
  }
  close() {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Open (creating on first use) the purse. Rejects with a PurseError; the page then works from memory and the download. */
export function openPurse({ indexedDB, name = DB_NAME, timeoutMs = 5000 } = {}) {
  let idb;
  try {
    idb = indexedDB ?? globalThis.indexedDB;
  } catch {
    idb = undefined;
  }
  if (!idb) return Promise.reject(new PurseError("unavailable", "This browser does not offer storage for tokens here (private windows often block it)."));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(v);
      }
    };
    const timer = setTimeout(() => done(reject, new PurseError("unavailable", "The browser did not open its token storage.")), timeoutMs);
    let req;
    try {
      req = idb.open(name, DB_VERSION);
    } catch (e) {
      done(reject, new PurseError("unavailable", `The browser refused to open token storage (${e?.message || e?.name || "error"}).`));
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains("tokens")) db.createObjectStore("tokens", { keyPath: "token" });
        if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "id" });
      } catch (e) {
        done(reject, wrap(e));
      }
    };
    req.onblocked = () => done(reject, new PurseError("blocked", "Token storage is blocked by another tab of this site. Close it and reload."));
    req.onerror = () => done(reject, new PurseError("unavailable", "The browser could not open token storage."));
    req.onsuccess = () => done(resolve, new Purse(req.result));
  });
}
