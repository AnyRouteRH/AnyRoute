// Private history: the conversations of private mode, kept only in this browser and encrypted there.
//
//   - One vault per browser: AES-GCM (256 bit) over the whole history, with a key derived from a passphrase by
//     PBKDF2 (HMAC-SHA-256, 600 000 rounds, random 16-byte salt). The key is derived as a non-extractable CryptoKey,
//     lives in memory while the history is unlocked and is dropped by lock() and forget().
//   - Every write uses a fresh random 12-byte IV. The stored record holds only the salt, IV, round count and
//     ciphertext: no titles, no dates, no counts in the clear.
//   - Nothing here touches the network. The vault lives in IndexedDB (memory only where the browser has none).
//   - A wrong passphrase and a damaged vault both fail to decrypt; a damaged record (not the expected shape) is
//     reported as unreadable so the person can forget it and start again. There is no recovery: forget() deletes.

import { promptVaultEdits, PRIVATE_PROMPT_BYTES } from "./harness-prompt-vault.js"; // V81: same encrypted vault.
import { validatePrompts } from "./harness-prompts.js"; // V81: validate decrypted prompt data.
import { SAVED_ANSWER_BYTES, savedAnswerEdits, validateSavedAnswers } from "./saved-answers.js"; // D140
import { receiptLane } from "./private-mode.js";
import { historyEdits, savedEntry } from "./harness-history-vault.js";

export const VERSION = 1;
export const KDF = "PBKDF2-SHA256";
export const ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 8;
export const MAX_CHATS = 40;
export const MAX_BYTES = 2_000_000;
const MIN_ROUNDS = 100_000;
const MAX_ROUNDS = 10_000_000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode("anyroute-private-history/" + VERSION);

export class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
  }
}

const MESSAGES = {
  wrong_passphrase: "That passphrase does not open this history.",
  unreadable: "This history cannot be read. Forget it to start again.",
  exists: "There is already a history in this browser.",
  weak_passphrase: `Use at least ${MIN_PASSPHRASE} characters.`,
  locked: "The history is locked.",
  no_vault: "There is no history in this browser.",
  too_large: "This conversation is too large to keep.",
  unsupported: "This browser cannot encrypt a history.",
};
const fail = (code) => new HistoryError(code, MESSAGES[code] || code);

const b64 = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- storage

/** A vault held in memory only: what browsers without IndexedDB get, and what the checks use. */
export function memoryStorage() {
  let held = null;
  return {
    persistent: false,
    get: async () => (held ? structuredClone(held) : null),
    set: async (record) => void (held = structuredClone(record)),
    delete: async () => void (held = null),
  };
}

/** The vault in IndexedDB (one database, one record). Falls back to memory where IndexedDB is missing. */
export function browserStorage({ name = "anyroute-private-history", scope = globalThis } = {}) {
  const idb = scope.indexedDB;
  if (!idb) return memoryStorage();
  const open = () =>
    new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("vault");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB is not available."));
    });
  const run = async (mode, op) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("vault", mode);
        const req = op(tx.objectStore("vault"));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB write failed."));
      });
    } finally {
      db.close();
    }
  };
  return {
    persistent: true,
    get: async () => (await run("readonly", (s) => s.get("history"))) ?? null,
    set: (record) => run("readwrite", (s) => s.put(record, "history")).then(() => undefined),
    // Deleting the database removes the record and the store, not just the value.
    delete: () =>
      new Promise((resolve, reject) => {
        const req = idb.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error("IndexedDB delete failed."));
      }),
  };
}

// ---------------------------------------------------------------- the vault

/**
 * An encrypted history over `storage`. `iterations` is the PBKDF2 round count used for a new vault (an existing vault
 * keeps the count it was made with). Calls are serialised, so a write never overtakes an earlier one or a forget.
 */
export function createHistory({ storage, crypto = globalThis.crypto, iterations = ITERATIONS, now = () => Date.now() }) {
  let session = null; // { key, salt, rounds, chats }
  let tail = Promise.resolve();
  const serial = (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  const subtle = () => {
    if (!crypto?.subtle) throw fail("unsupported");
    return crypto.subtle;
  };

  async function derive(passphrase, salt, rounds) {
    const base = await subtle().importKey("raw", enc.encode(String(passphrase).normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function seal(s, chats, prompts = s.prompts, savedAnswers = s.savedAnswers) { // V81: preserve prompts across history writes.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    if (savedAnswers !== undefined) validateSavedAnswers(savedAnswers); // D140
    const plain = enc.encode(JSON.stringify({ chats, ...(savedAnswers === undefined ? {} : { savedAnswers }), ...(prompts === undefined ? {} : { prompts }) })); // V81
    if (plain.length > MAX_BYTES + PRIVATE_PROMPT_BYTES + SAVED_ANSWER_BYTES + 4096) throw fail("too_large"); // D140: separate history, prompt and saved-answer budgets plus the envelope.
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD }, s.key, plain));
    await storage.set({ v: VERSION, kdf: KDF, iterations: s.rounds, salt: b64(s.salt), iv: b64(iv), ct: b64(ct) });
  }

  const shaped = (r) =>
    r && r.v === VERSION && r.kdf === KDF && Number.isInteger(r.iterations) && r.iterations >= MIN_ROUNDS && r.iterations <= MAX_ROUNDS && typeof r.salt === "string" && typeof r.iv === "string" && typeof r.ct === "string";

  const need = () => {
    if (!session) throw fail("locked");
    return session;
  };

  const turns = (chat) => Math.max(0, ...((chat.lanes || []).map((l) => (l.messages || []).filter((m) => m.role === "user").length)));

  return {
    ...savedAnswerEdits({ serial, need, seal }), // D140
    ...historyEdits({ serial, need, seal, maxBytes: MAX_BYTES, maxChats: MAX_CHATS }),
    ...promptVaultEdits({ serial, need, seal }), // V81
    /** Whether a vault is stored in this browser (locked or not). */
    exists: async () => !!(await storage.get()),
    /** False where the vault only lives in memory, so it is gone when the tab closes. */
    persistent: !!storage.persistent,
    get unlocked() {
      return !!session;
    },

    /** Start a new, empty vault under a passphrase and leave it unlocked. */
    create: (passphrase) =>
      serial(async () => {
        if (String(passphrase ?? "").length < MIN_PASSPHRASE) throw fail("weak_passphrase");
        if (await storage.get()) throw fail("exists");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const next = { key: await derive(passphrase, salt, iterations), salt, rounds: iterations, chats: [] };
        await seal(next, []);
        session = next;
      }),

    /** Open the stored vault. Throws HistoryError "wrong_passphrase" or "unreadable"; the vault stays locked. */
    unlock: (passphrase) =>
      serial(async () => {
        const record = await storage.get();
        if (!record) throw fail("no_vault");
        if (!shaped(record)) throw fail("unreadable");
        if (!String(passphrase ?? "")) throw fail("wrong_passphrase");
        let salt, iv, ct;
        try {
          [salt, iv, ct] = [unb64(record.salt), unb64(record.iv), unb64(record.ct)];
        } catch {
          throw fail("unreadable");
        }
        const key = await derive(passphrase, salt, record.iterations);
        let plain;
        try {
          plain = await subtle().decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, ct);
        } catch {
          throw fail("wrong_passphrase");
        }
        let doc;
        try {
          doc = JSON.parse(dec.decode(plain));
        } catch {
          throw fail("unreadable");
        }
        if (!Array.isArray(doc?.chats)) throw fail("unreadable");
        const savedAnswers = validateSavedAnswers(doc.savedAnswers); // D140
        session = { key, salt, rounds: record.iterations, chats: doc.chats, savedAnswers, ...(doc.prompts === undefined ? {} : { prompts: validatePrompts(doc.prompts) }) }; // V81
      }),

    /** Chats, newest first: id, title, when, and how many turns. Nothing else leaves the vault through this. */
    list: () => (session ? session.chats.map((c) => ({ id: c.id, title: c.title, at: c.at, turns: turns(c), ...(c.pinned ? { pinned: true } : {}) })) : []),
    get: (id) => {
      const chat = need().chats.find((c) => c.id === id);
      return chat ? structuredClone(chat) : null;
    },

    /** Add or replace a chat ({ id, title, lanes }) and write the vault. */
    put: (chat) =>
      serial(async () => {
        const s = need();
        const entry = savedEntry(chat, s.chats.find((c) => c.id === String(chat.id)), now());
        let chats = [entry, ...s.chats.filter((c) => c.id !== entry.id)].sort((a, b) => b.at - a.at).slice(0, MAX_CHATS);
        const size = (list) => enc.encode(JSON.stringify({ chats: list })).length;
        if (size([entry]) > MAX_BYTES) throw fail("too_large");
        while (chats.length > 1 && size(chats) > MAX_BYTES) chats = chats.slice(0, -1);
        await seal(s, chats);
        s.chats = chats;
      }),

    remove: (id) =>
      serial(async () => {
        const s = need();
        const chats = s.chats.filter((c) => c.id !== id);
        await seal(s, chats);
        s.chats = chats;
      }),

    /** Drop the key and the decrypted chats from memory. The vault stays stored. */
    lock: () => void (session = null),

    /** Delete the vault and everything in memory. Safe to call at any time, with or without a vault. */
    forget: () =>
      serial(async () => {
        session = null;
        await storage.delete();
      }),
  };
}

// ---------------------------------------------------------------- what is kept of a conversation

const stamp = (n) => (Number.isFinite(n) ? n : undefined);

/** The first thing the person said, as a short title. */
export function titleOf(lanes) {
  for (const l of lanes || []) for (const m of l.messages || []) if (m.role === "user" && m.text?.trim()) return m.text.trim().replace(/\s+/g, " ").slice(0, 60);
  return "Untitled";
}

/**
 * The parts of a conversation worth keeping, as plain data: text of both sides, the model, the receipt id with its
 * lane and the token counts and cost. Not kept: attachments (only their names), images, audio, reasoning, tool calls
 * and results, and any reply that failed or has no text.
 */
export function snapshotLanes(lanes) {
  return (lanes || []).map((l) => ({
    modelId: l.modelId || null,
    messages: (l.messages || []).flatMap((m) => {
      if (m.role === "user" && typeof m.text === "string" && m.text.trim()) return [{ id: m.id, role: "user", text: m.text, files: (m.attachments || []).map((a) => a.name).filter(Boolean) }];
      if (m.role !== "assistant" || !m.text || (m.toolCalls || []).length || m.status === "error") return [];
      const { lane, disclosure } = receiptLane(m.receipt);
      const u = m.usage || {};
      return [
        {
          id: m.id,
          role: "assistant",
          text: m.text,
          model: m.model,
          provider: m.provider || undefined,
          stopped: m.status === "stopped" || undefined,
          ms: stamp(m.ms),
          usage: { prompt_tokens: stamp(u.prompt_tokens), completion_tokens: stamp(u.completion_tokens), cost: stamp(u.cost) },
          receiptId: m.receipt?.id || undefined,
          lane: lane || undefined,
          disclosure: disclosure || undefined,
        },
      ];
    }),
  }));
}

/** A saved conversation back into the shape the Harness renders. `uid` makes ids for extra lanes. */
export function restoreLanes(saved, uid = () => Math.random().toString(36).slice(2, 10)) {
  const lanes = Array.isArray(saved) ? saved : [];
  return (lanes.length ? lanes : [{ modelId: null, messages: [] }]).map((l, i) => ({
    id: i === 0 ? "l0" : "l" + uid(),
    modelId: l.modelId || null,
    messages: (l.messages || []).map((m) =>
      m.role === "user"
        ? { id: m.id, role: "user", text: m.text, attachments: [] }
        : {
            id: m.id,
            role: "assistant",
            model: m.model,
            status: m.stopped ? "stopped" : "done",
            text: m.text,
            provider: m.provider || null,
            ms: m.ms,
            usage: m.usage || null,
            receipt: m.receiptId ? { id: m.receiptId, payload: m.disclosure ? { disclosure: m.disclosure } : {}, v2: { claims: { lane: m.lane || "", disclosure: m.disclosure || "" } } } : null,
          },
    ),
  }));
}
