import test from "node:test";
import assert from "node:assert/strict";
import { KeyHolder, PurseError, SESSION_ITEM, clearSession, loadSession, openPurse, saveSession } from "../lib/purse-store.js";
import { fakeIndexedDB, fakeStorage } from "./purse-helpers.mjs";

const SECRET = "sk-ar-v1-" + "ab".repeat(32);
const record = (extra = {}) => ({ secret: SECRET, method: "usdg", hash: "h", keyHash: "0xabc", baselinePico: "0", known: [], sent: false, ...extra });
const tok = (n) => ({ token: `token-${n}`, key_id: "aa".repeat(32), denomination: 1000, epoch: 1, value_usd: "0.002", redeem_until: "2026-10-13T00:00:00.000Z", bought_at: "2026-09-30T00:00:00.000Z" });

// ---- the key in memory -----------------------------------------------------------------------------------------

test("a key held in memory is readable until it is wiped, and wiping zeroes the bytes", () => {
  const buffer = new Uint8Array(200).fill(7);
  const holder = new KeyHolder(SECRET, { buffer });
  assert.equal(holder.present, true);
  assert.equal(holder.reveal(), SECRET);
  assert.ok(buffer.subarray(0, SECRET.length).some((b) => b !== 0));
  holder.wipe();
  assert.equal(holder.present, false);
  assert.ok(buffer.subarray(0, SECRET.length).every((b) => b === 0), "the key bytes were overwritten with zeros");
  assert.throws(() => holder.reveal(), /discarded/);
  holder.wipe(); // wiping twice is harmless
  assert.equal(holder.present, false);
  assert.throws(() => new KeyHolder(SECRET, { buffer: new Uint8Array(4) }), /too small/);
});

test("a key holder does not expose the secret through its own properties", () => {
  const holder = new KeyHolder(SECRET);
  assert.ok(!JSON.stringify(holder).includes("ab"));
  assert.deepEqual(Object.keys(holder), []);
  assert.ok(!String(Object.getOwnPropertyNames(holder)).includes(SECRET));
});

// ---- the key in this tab's sessionStorage ------------------------------------------------------------------------

test("the stored key round-trips, and only in the storage it was given", () => {
  const session = fakeStorage();
  const local = fakeStorage();
  assert.deepEqual(saveSession(record({ sent: true, expectedUsd: 5 }), session), { ok: true });
  assert.equal(local.map.size, 0);
  const back = loadSession(session);
  assert.equal(back.secret, SECRET);
  assert.equal(back.sent, true);
  assert.equal(back.v, 1);
  assert.deepEqual([...session.map.keys()], [SESSION_ITEM]);
});

test("nothing here touches localStorage or IndexedDB for the key", () => {
  const trap = new Proxy({}, { get: () => { throw new Error("localStorage must not be used"); }, set: () => { throw new Error("localStorage must not be used"); } });
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: trap, configurable: true });
  try {
    const session = fakeStorage();
    saveSession(record(), session);
    loadSession(session);
    clearSession(session);
    new KeyHolder(SECRET).wipe();
  } finally {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete globalThis.localStorage;
  }
});

test("a stored value that is not ours or is damaged is removed, not trusted", () => {
  const cases = ["not json", "{}", JSON.stringify({ v: 2, secret: SECRET, method: "usdg" }), JSON.stringify({ v: 1, secret: "sk-not-a-key", method: "usdg" }), JSON.stringify({ v: 1, secret: SECRET, method: "other" }), JSON.stringify({ v: 1, secret: SECRET.toUpperCase(), method: "usdg" }), "null", ""];
  for (const raw of cases) {
    const session = fakeStorage();
    session.map.set(SESSION_ITEM, raw);
    assert.equal(loadSession(session), null, raw);
    assert.equal(session.map.has(SESSION_ITEM), false, `${raw} was left in storage`);
  }
  assert.equal(loadSession(fakeStorage()), null);
});

test("blocked session storage is a state the page reports, not a crash", () => {
  const blocked = fakeStorage({ throwOnSet: true, throwOnGet: true });
  const saved = saveSession(record(), blocked);
  assert.equal(saved.ok, false);
  assert.match(saved.error, /refused to store the key/);
  assert.equal(loadSession(blocked), null);
  const full = fakeStorage({ quota: true });
  assert.match(saveSession(record(), full).error, /full/);
  assert.equal(saveSession(record(), null).ok, false); // no storage object at all
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { get() { throw new Error("SecurityError"); }, configurable: true }); // reading it throws, as in a sandboxed frame
  try {
    assert.equal(saveSession(record()).ok, false);
    assert.equal(loadSession(), null);
    assert.deepEqual(clearSession(), { ok: true, overwritten: false });
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});

test("clearing removes the key and checks that it is gone", () => {
  const session = fakeStorage();
  saveSession(record(), session);
  assert.deepEqual(clearSession(session), { ok: true, overwritten: false });
  assert.equal(session.map.has(SESSION_ITEM), false);
  assert.deepEqual(clearSession(session), { ok: true, overwritten: false }); // nothing left is fine
});

test("if removing fails, the key is overwritten with an empty value", () => {
  const session = fakeStorage();
  saveSession(record(), session);
  session.flags.throwOnRemove = true;
  assert.deepEqual(clearSession(session), { ok: true, overwritten: true });
  assert.equal(session.map.get(SESSION_ITEM), "");
  assert.ok(!session.map.get(SESSION_ITEM).includes("sk-ar"));
  assert.equal(loadSession(session), null); // an empty value is not a key
});

test("if the key can be neither removed nor overwritten, clearing says so", () => {
  const session = fakeStorage();
  saveSession(record(), session);
  session.flags.throwOnRemove = true;
  session.flags.throwOnSet = true;
  assert.deepEqual(clearSession(session), { ok: false, overwritten: false });
  assert.ok(session.map.get(SESSION_ITEM).includes(SECRET), "still there, and the caller was told");
});

test("if removal did nothing and reading is blocked, the key is treated as still stored", () => {
  const session = fakeStorage();
  saveSession(record(), session);
  session.flags.throwOnRemove = true;
  session.flags.throwOnGet = true;
  const result = clearSession(session);
  assert.equal(result.overwritten, true);
});

// ---- the tokens in IndexedDB -------------------------------------------------------------------------------------

test("tokens survive being stored and read back, and can be removed one by one", async () => {
  const idb = fakeIndexedDB();
  const purse = await openPurse({ indexedDB: idb });
  assert.deepEqual(await purse.list(), []);
  await purse.add([tok(1), tok(2), tok(3)]);
  assert.deepEqual((await purse.list()).map((t) => t.token).sort(), ["token-1", "token-2", "token-3"]);
  await purse.add([tok(2)]); // the same token again is one token
  assert.equal((await purse.list()).length, 3);
  await purse.remove(["token-2", "token-9"]);
  assert.deepEqual((await purse.list()).map((t) => t.token).sort(), ["token-1", "token-3"]);
  await purse.clear();
  assert.deepEqual(await purse.list(), []);
  await purse.add([]);
  await purse.remove([]);
  // a second open of the same database sees the same rows
  await purse.add([tok(7)]);
  const again = await openPurse({ indexedDB: idb });
  assert.deepEqual((await again.list()).map((t) => t.token), ["token-7"]);
  purse.close();
});

test("pending purchases are kept apart from finished tokens", async () => {
  const purse = await openPurse({ indexedDB: fakeIndexedDB() });
  await purse.putPending({ id: "p1", items: [1, 2] });
  await purse.putPending({ id: "p2", items: [3] });
  assert.deepEqual((await purse.listPending()).map((p) => p.id).sort(), ["p1", "p2"]);
  assert.deepEqual(await purse.list(), []);
  await purse.removePending("p1");
  assert.deepEqual((await purse.listPending()).map((p) => p.id), ["p2"]);
});

test("a write that runs out of room stores none of its tokens", async () => {
  const idb = fakeIndexedDB({ quotaOnPut: 2 });
  const purse = await openPurse({ indexedDB: idb });
  await assert.rejects(purse.add([tok(1), tok(2), tok(3)]), (e) => e instanceof PurseError && e.code === "quota" && /no room/.test(e.message));
  idb.flags.quotaOnPut = undefined;
  assert.deepEqual(await purse.list(), [], "the transaction was atomic: not even the first two were kept");
  await purse.add([tok(4)]);
  assert.equal((await purse.list()).length, 1);
});

test("an aborted transaction rejects, and leaves what was stored before untouched", async () => {
  const idb = fakeIndexedDB();
  const purse = await openPurse({ indexedDB: idb });
  await purse.add([tok(1)]);
  idb.flags.abortWrites = true;
  await assert.rejects(purse.add([tok(2)]), (e) => e instanceof PurseError && e.code === "failed");
  await assert.rejects(purse.remove(["token-1"]), PurseError);
  idb.flags.abortWrites = false;
  assert.deepEqual((await purse.list()).map((t) => t.token), ["token-1"]);
});

test("a database connection that is closing rejects with a PurseError", async () => {
  const idb = fakeIndexedDB();
  const purse = await openPurse({ indexedDB: idb });
  idb.flags.failTransaction = true;
  await assert.rejects(purse.list(), (e) => e instanceof PurseError && e.code === "failed" && /could not read or write/.test(e.message));
  await assert.rejects(purse.add([tok(1)]), PurseError);
});

test("storage that the browser will not open is reported with a reason", async () => {
  await assert.rejects(openPurse({ indexedDB: null }), (e) => e instanceof PurseError && e.code === "unavailable" && /private windows/.test(e.message));
  await assert.rejects(openPurse({ indexedDB: fakeIndexedDB({ failOpen: true }) }), (e) => e.code === "unavailable");
  await assert.rejects(openPurse({ indexedDB: fakeIndexedDB({ blocked: true }) }), (e) => e.code === "blocked");
  await assert.rejects(openPurse({ indexedDB: fakeIndexedDB({ hangOpen: true }), timeoutMs: 20 }), (e) => e.code === "unavailable" && /did not open/.test(e.message));
  const throwing = { open() { throw new Error("SecurityError: denied"); } };
  await assert.rejects(openPurse({ indexedDB: throwing }), (e) => e.code === "unavailable" && /denied/.test(e.message));
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { get() { throw new Error("blocked"); }, configurable: true });
  try {
    await assert.rejects(openPurse(), (e) => e.code === "unavailable");
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  }
});
