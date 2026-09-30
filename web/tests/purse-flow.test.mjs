import test from "node:test";
import assert from "node:assert/strict";
import { IllegalTransition, PurseFlow, issuingKeys, planPurchase } from "../lib/purse.js";
import { parseTokenFile, usdToPico } from "../lib/purse-file.js";
import { SESSION_ITEM, openPurse } from "../lib/purse-store.js";
import { toBase64Url, verifyToken } from "../lib/blind-rsa.js";
import { ANYR_OFFICIAL, ESCROW, fakeIndexedDB, fakeRouter, fakeStorage, fakeWallet, issuerKeys, valuePico } from "./purse-helpers.mjs";

/** A page with everything it needs from outside replaced: a router, a wallet, sessionStorage and IndexedDB. */
function page(o = {}) {
  const router = o.router ?? fakeRouter(o.routerOptions);
  const session = o.session ?? fakeStorage(o.sessionFlags);
  const idb = o.idb ?? fakeIndexedDB(o.idbFlags);
  const wallet = o.wallet ?? fakeWallet(o.walletFlags);
  const slept = [];
  const make = () =>
    new PurseFlow({
      api: (path, opts) => router.api(path, opts),
      wallet,
      session,
      openPurse: () => openPurse({ indexedDB: idb, timeoutMs: 200 }),
      officialAnyr: ANYR_OFFICIAL,
      sleep: async (ms) => void slept.push(ms),
    });
  return { router, session, idb, wallet, slept, make };
}

const usdgPay = (p, secretOf, usd) => (p.wallet.flags.onSend = () => p.router.credit(secretOf(), usd));
const secretIn = (p) => JSON.parse(p.session.map.get(SESSION_ITEM)).secret;

/** Run the USDG route to the point where the credit is seen. */
async function fundedUsdg(p, usd = 5) {
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  const secret = secretIn(p);
  usdgPay(p, () => secret, usd);
  await flow.payUsdg(String(usd));
  assert.equal(flow.state.phase, "waiting");
  assert.equal(await flow.waitForCredit(), true);
  return { flow, secret };
}

const heldTokens = (flow) => flow.info.tokens;
const verifyAll = async (flow, router) => {
  const dir = (await router.api("/api/v1/blind/keys")).data;
  for (const t of heldTokens(flow)) {
    const key = dir.keys.find((k) => k.token_key_id === t.key_id);
    assert.ok(key, "a token names a key the router lists");
    assert.equal(await verifyToken(t.token, key, dir.challenge_digest), true);
  }
};

// ---- USDG, start to finish -------------------------------------------------------------------------------------

test("USDG: one-time key, wallet payment, credit, blind purchase, tokens kept, key discarded", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  assert.equal(flow.info.blind, "available");
  assert.equal(flow.info.storage, "browser");
  assert.equal(flow.getSnapshot().state.phase, "choose");

  // 1. the key: made with no account, kept for this tab only
  await flow.begin("usdg");
  const secret = secretIn(p);
  assert.match(secret, /^sk-ar-v1-[0-9a-f]{64}$/);
  assert.equal(flow.state.phase, "keyed");
  assert.equal(flow.getSnapshot().holdsKey, true);
  assert.equal(flow.deposit.credits_contract.length, 42);
  assert.equal(flow.state.keyHash, flow.deposit.key_hash);
  assert.deepEqual(p.router.state.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/api/v1/keys"]);
  assert.equal(p.router.state.calls.find((c) => c.path === "/api/v1/keys").key, null, "no credential was sent to make the key");

  // 2. the wallet pays: approve, then deposit, both through the wallet the page already uses on the dashboard
  usdgPay(p, () => secret, 5);
  await flow.payUsdg("5");
  assert.deepEqual(p.wallet.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ["connect", "ensureChain", "send"]);
  assert.equal(p.wallet.calls[1][1], 4663);
  assert.equal(p.wallet.calls[2][2].length, 2, "approve and deposit");
  assert.equal(flow.state.phase, "waiting");
  assert.equal(flow.state.expectedUsd, 5);

  // 3. the credit shows up on the key
  assert.equal(await flow.waitForCredit(), true);
  assert.equal(flow.state.phase, "funded");
  assert.equal(flow.state.spendablePico, usdToPico("5").toString());

  // 4. the plan is shown before anything is bought, then everything is bought
  const plan = flow.planFor("balanced");
  assert.ok(plan.tokenCount > 0 && plan.leftoverPico < usdToPico("0.002"));
  await flow.mint("balanced");

  // 5. the tokens are in the browser and in a file
  const held = heldTokens(flow);
  assert.equal(held.length, plan.tokenCount);
  assert.equal(flow.getSnapshot().summary.valueUsd, "5.00");
  await verifyAll(flow, p.router);
  const stored = await (await openPurse({ indexedDB: p.idb })).list();
  assert.equal(stored.length, held.length);
  const file = flow.tokenFile();
  assert.equal(file.name, "anyroute-tokens.json");
  const read = parseTokenFile(file.text);
  assert.equal(read.tokens.length, held.length);
  assert.deepEqual(read.unconfirmed, []);
  assert.deepEqual(read.tokens.map((t) => t.token).sort(), held.map((t) => t.token).sort());

  // 6. the key is gone: disabled at the router, wiped in memory, removed from the tab
  assert.equal(flow.state.phase, "discarded");
  assert.deepEqual(flow.state.discarded, { memory: true, stored: true, remote: true });
  assert.equal(flow.getSnapshot().holdsKey, false);
  assert.equal(p.session.map.has(SESSION_ITEM), false);
  assert.equal(p.router.keyRecord(secret).disabled, true);
  await assert.rejects(p.router.api("/api/v1/credits", { key: secret }), /disabled/);
  assert.throws(() => flow.key());

  // the router took the whole credit for tokens, less the dust under one small token
  assert.equal(p.router.state.charged, plan.requests);
  assert.equal(p.router.balanceOf(secret), plan.leftoverPico);
  assert.ok(p.router.balanceOf(secret) < valuePico(1000));
});

test("the key never leaves memory and this tab: only sessionStorage, only under one item, and it holds no token", async () => {
  const p = page();
  const { flow, secret } = await fundedUsdg(p);
  assert.deepEqual([...p.session.map.keys()], [SESSION_ITEM]);
  // IndexedDB never sees the key
  await flow.mint("small");
  for (const db of p.idb.dbs.values()) for (const store of db.stores.values()) assert.ok(!JSON.stringify([...store.rows.values()]).includes(secret));
  // and the token file never does
  assert.ok(!flow.tokenFile().text.includes(secret));
});

test("the plan the person sees is the plan that runs", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p, 2);
  const plan = flow.planFor("large");
  await flow.mint("large");
  const bySize = new Map();
  for (const t of heldTokens(flow)) bySize.set(t.value_usd, (bySize.get(t.value_usd) ?? 0) + 1);
  for (const l of plan.lines) assert.equal(bySize.get(l.key.value_usd), l.count, l.key.value_usd);
  assert.equal(p.router.state.charged, plan.requests);
});

// ---- failures while paying -------------------------------------------------------------------------------------

test("a payment the wallet refuses returns to the start of the step with the key intact", async () => {
  const p = page({ walletFlags: { rejectSend: true } });
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  await assert.rejects(flow.payUsdg("5"));
  assert.equal(flow.state.phase, "keyed");
  assert.match(flow.state.error, /declined it in your wallet/);
  assert.equal(flow.state.sent, false);
  assert.equal(flow.getSnapshot().holdsKey, true);
  assert.ok(p.session.map.has(SESSION_ITEM));
  // try again
  p.wallet.flags.rejectSend = false;
  await flow.payUsdg("5");
  assert.equal(flow.state.phase, "waiting");
  assert.equal(flow.state.error, null);
});

test("amounts the router cannot take are refused before the wallet is opened", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  for (const bad of ["", "abc", "0", "-1", "1.1234567", "1e3"]) {
    await assert.rejects(flow.payUsdg(bad), /USDG amount/, bad);
    assert.equal(flow.state.phase, "keyed");
  }
  assert.equal(p.wallet.calls.length, 0);
  const noWallet = page({ walletFlags: { hasWallet: false } });
  const f2 = noWallet.make();
  await f2.init();
  await f2.begin("usdg");
  await assert.rejects(f2.payUsdg("5"), /No browser wallet was found/);
  assert.equal(f2.state.phase, "keyed");
  const noCredits = page({ routerOptions: { noCredits: true } });
  const f3 = noCredits.make();
  await f3.init();
  await f3.begin("usdg");
  await assert.rejects(f3.payUsdg("5"), /no Credits contract/);
});

test("paying from another wallet app: say it was sent, and the same wait applies", async () => {
  const p = page({ walletFlags: { hasWallet: false } });
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  flow.markSent(2);
  assert.equal(flow.state.phase, "waiting");
  // nothing has arrived yet: still waiting
  const first = await flow.checkCredit();
  assert.equal(first.funded, false);
  p.router.credit(secretIn(p), 1); // only part of it
  assert.equal((await flow.checkCredit()).funded, false);
  await flow.useArrivedBalance();
  assert.equal(flow.state.phase, "funded");
  assert.equal(flow.state.spendablePico, usdToPico("1").toString());
});

test("waiting for the credit can be stopped, and reading the balance failing is survivable", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  flow.markSent(3);
  const abort = new AbortController();
  let calls = 0;
  p.router.state.hooks.before = (method, path) => {
    if (path === "/api/v1/credits" && ++calls === 1) throw p.router.networkError();
    if (path === "/api/v1/credits" && calls === 3) abort.abort();
  };
  const result = await flow.waitForCredit({ signal: abort.signal });
  assert.equal(result, false);
  assert.equal(flow.state.phase, "waiting");
  assert.ok(calls >= 3, "it kept looking after the first failure");
  assert.match(flow.getSnapshot().progress.message, /Waiting for the deposit|Could not read/);
});

// ---- failures while buying -------------------------------------------------------------------------------------

test("a response lost after the router charged is retried with the same request and charged once", async () => {
  const p = page();
  const { flow, secret } = await fundedUsdg(p, 1);
  const bodies = [];
  p.router.state.hooks.purchase = (n, body) => bodies.push(body.blinded_msgs.join("|"));
  p.router.state.hooks.afterPurchase = (n) => {
    if (n === 1) throw p.router.networkError(); // processed and charged, but the page never hears
  };
  await flow.mint("small");
  assert.equal(bodies[0], bodies[1], "the retry carried exactly the same blinded messages");
  assert.equal(p.router.state.charged, flow.planFor("small").requests || Math.ceil(heldTokens(flow).length / 32));
  assert.equal(heldTokens(flow).length, 500);
  assert.ok(p.router.balanceOf(secret) < valuePico(1000));
  assert.ok(p.slept.some((ms) => ms >= 1000), "it backed off before retrying");
  await verifyAll(flow, p.router);
  assert.equal(flow.state.phase, "discarded");
});

test("the router's per-minute limit is waited out, not treated as a failure", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p, 1);
  p.router.state.hooks.purchase = (n) => {
    if (n === 2) throw p.router.apiError(429, "Rate limit exceeded", "rate_limited", { retry_after_ms: 7000 });
  };
  await flow.mint("small");
  assert.ok(p.slept.includes(7250), "it waited what the router asked for");
  assert.equal(heldTokens(flow).length, 500);
  assert.equal(flow.state.phase, "discarded");
});

test("the daily cap stops a purchase midway: tokens bought so far are kept, the key stays, and it can be resumed", async () => {
  const p = page({ routerOptions: { dayCapPico: usdToPico("0.4") } });
  const { flow, secret } = await fundedUsdg(p, 1);
  await assert.rejects(flow.mint("small"), /Daily purchase cap/);
  assert.equal(flow.state.phase, "funded");
  assert.match(flow.state.error, /Daily purchase cap/);
  assert.equal(heldTokens(flow).length, 192, "six requests of 32 fit under the cap");
  assert.equal(flow.getSnapshot().holdsKey, true, "the balance is still on the key, so the key stays");
  assert.ok(p.session.map.has(SESSION_ITEM));
  assert.equal(BigInt(flow.state.spendablePico), p.router.balanceOf(secret));
  // the next day
  p.router.state.dayCapPico = null;
  await flow.mint("small");
  assert.equal(heldTokens(flow).length, 500);
  assert.equal(flow.state.phase, "discarded");
});

test("a balance a hair short of the plan drops the last token and asks again", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p, 1);
  p.router.state.hooks.purchase = (n, body) => {
    if (n === 1) throw p.router.apiError(402, "Insufficient credits.", "insufficient_credits");
  };
  // the first request of 32 is refused once; the retry sends 31, and everything else goes as planned
  await flow.mint("small");
  assert.equal(heldTokens(flow).length, 499);
  assert.equal(flow.state.phase, "funded", "one token's worth is left, so the purchase is offered again");
  assert.ok(BigInt(flow.state.spendablePico) >= valuePico(1000));
  p.router.state.hooks.purchase = undefined;
  await flow.mint("small");
  assert.equal(flow.state.phase, "discarded");
  assert.equal(heldTokens(flow).length, 500);
});

test("a key that stops issuing between listing and buying is replaced by the one that issues now", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p, 1);
  issuerKeys(1); // the next epoch's keys
  p.router.state.hooks.purchase = (n) => {
    if (n === 1) p.router.state.generation = 1; // the epoch rolled over
  };
  await flow.mint("medium");
  assert.equal(flow.state.phase, "discarded");
  const dir = (await p.router.api("/api/v1/blind/keys")).data;
  const ids = new Set(heldTokens(flow).map((t) => t.key_id));
  assert.ok([...ids].every((id) => dir.keys.some((k) => k.token_key_id === id)), "every token is under a key that is listed now");
  await verifyAll(flow, p.router);
});

test("a purchase that cannot be sent leaves its blinded messages to resume, and a reloaded page finishes it without charging twice", async () => {
  const p = page();
  const { flow, secret } = await fundedUsdg(p, 1);
  // the router charges and signs, but every answer is lost
  p.router.state.hooks.afterPurchase = () => {
    throw p.router.networkError();
  };
  await assert.rejects(flow.mint("large"));
  assert.equal(flow.state.phase, "funded");
  assert.equal(flow.pending.size, 1);
  assert.equal(heldTokens(flow).length, 0);
  assert.equal(p.router.state.charged, 1);
  const chargedBefore = p.router.balanceOf(secret);
  // the tab is reloaded: a new page over the same sessionStorage and IndexedDB
  p.router.state.hooks.afterPurchase = undefined;
  const reloaded = p.make();
  await reloaded.init();
  assert.equal(reloaded.state.phase, "funded", "the key came back from the tab");
  assert.equal(reloaded.pending.size, 1, "and so did the interrupted purchase");
  await reloaded.mint("large");
  assert.equal(p.router.state.charged, 1, "the router charged this purchase once, however often it was sent");
  assert.equal(reloaded.pending.size, 0);
  await verifyAll(reloaded, p.router);
  assert.ok(heldTokens(reloaded).length >= 5);
  assert.ok(p.router.balanceOf(secret) <= chargedBefore, "the interrupted purchase was not paid for a second time");
  assert.equal(reloaded.state.phase, "discarded");
});

test("nothing can be bought with less than one small token", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  flow.markSent(0.001);
  p.router.credit(secretIn(p), 0.001);
  await flow.useArrivedBalance();
  assert.equal(flow.planFor("balanced").batches.length, 0);
  await assert.rejects(flow.mint("balanced"), /smallest token costs \$0.002/);
  assert.equal(flow.state.phase, "funded");
  assert.equal(p.router.state.purchaseCalls, 0);
});

// ---- the key, and letting it go --------------------------------------------------------------------------------

test("cancelling before anything is paid discards the key at once", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  const secret = secretIn(p);
  await flow.cancel();
  assert.equal(flow.state.phase, "discarded");
  assert.equal(p.session.map.has(SESSION_ITEM), false);
  assert.equal(p.router.keyRecord(secret).disabled, true);
  assert.equal(flow.getSnapshot().holdsKey, false);
  flow.startOver();
  assert.equal(flow.state.phase, "choose");
});

test("a key with money on it is not discarded by cancel", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p);
  await assert.rejects(flow.cancel(), IllegalTransition);
  assert.equal(flow.state.phase, "funded");
  assert.equal(flow.getSnapshot().holdsKey, true);
  assert.ok(p.session.map.has(SESSION_ITEM), "and its stored copy is untouched");
});

test("if the router cannot be reached to disable the key, the local copy is still destroyed and the page says what happened", async () => {
  const p = page();
  const { flow, secret } = await fundedUsdg(p, 1);
  p.router.state.hooks.patchFails = true;
  await flow.mint("small");
  assert.equal(flow.state.phase, "discarded");
  assert.deepEqual(flow.state.discarded, { memory: true, stored: true, remote: false });
  assert.equal(p.session.map.has(SESSION_ITEM), false);
  assert.throws(() => flow.key());
  assert.equal(p.router.keyRecord(secret).disabled, false, "still enabled at the router, which the result reports");
  assert.equal(p.router.state.calls.filter((c) => c.method === "PATCH").length, 3, "tried three times");
});

test("if the stored copy of the key cannot be removed it is overwritten, and if that fails too the result says so", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p, 1);
  p.session.flags.throwOnRemove = true;
  await flow.mint("small");
  assert.deepEqual(flow.state.discarded, { memory: true, stored: true, remote: true });
  assert.equal(p.session.map.get(SESSION_ITEM), "");

  const q = page();
  const { flow: f2 } = await fundedUsdg(q, 1);
  q.session.flags.throwOnRemove = true;
  q.session.flags.throwOnSet = true;
  await f2.mint("small");
  assert.equal(f2.state.phase, "discarded");
  assert.deepEqual(f2.state.discarded, { memory: true, stored: false, remote: true });
  assert.equal(f2.getSnapshot().holdsKey, false, "the memory copy is gone either way");
});

test("session storage that refuses the key does not stop the flow, and the page knows the key is memory only", async () => {
  const p = page({ sessionFlags: { throwOnSet: true } });
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  assert.equal(flow.info.sessionKept, false);
  assert.equal(flow.getSnapshot().holdsKey, true);
  const secret = flow.key();
  p.wallet.flags.onSend = () => p.router.credit(secret, 1);
  await flow.payUsdg("1");
  await flow.waitForCredit();
  await flow.mint("small");
  assert.equal(flow.state.phase, "discarded");
  assert.equal(heldTokens(flow).length, 500);
});

// ---- failures while keeping the tokens -------------------------------------------------------------------------

test("with no browser storage the tokens stay in memory, the page asks for the file, and the key goes once it is saved", async () => {
  const p = page({ idbFlags: { failOpen: true } });
  const { flow, secret } = await fundedUsdg(p, 1);
  assert.equal(flow.info.storage, "none");
  assert.ok(flow.info.storageError);
  await flow.mint("small");
  assert.equal(flow.state.phase, "minted", "not discarded: the tokens have nowhere safe yet");
  assert.equal(flow.state.saved, null);
  assert.equal(flow.getSnapshot().holdsKey, true);
  assert.equal(heldTokens(flow).length, 500);
  await assert.rejects(flow.discard(), IllegalTransition);
  assert.equal(parseTokenFile(flow.tokenFile().text).tokens.length, 500, "the file has every token");
  await flow.fileSaved();
  assert.equal(flow.state.phase, "discarded");
  assert.equal(flow.state.saved, "file");
  assert.equal(p.session.map.has(SESSION_ITEM), false);
  assert.equal(p.router.keyRecord(secret).disabled, true);
});

test("storage that fills up midway keeps every token in memory and in the file, and waits for the file before discarding", async () => {
  const p = page({ idbFlags: { quotaOnPut: 100 } });
  const { flow } = await fundedUsdg(p, 1);
  // the purse accepts 100 writes: three requests of 32 fit, the fourth does not
  await flow.mint("small");
  assert.equal(flow.state.phase, "minted");
  assert.equal(flow.state.saved, null);
  assert.match(flow.info.storageError, /no room/);
  assert.equal(heldTokens(flow).length, 500);
  const stored = await (await openPurse({ indexedDB: p.idb })).list();
  assert.equal(stored.length, 96, "the first three requests were stored, and the fourth left nothing behind");
  assert.equal(parseTokenFile(flow.tokenFile().text).tokens.length, 500);
  await flow.fileSaved();
  assert.equal(flow.state.phase, "discarded");
});

test("storage that opens but cannot write behaves the same way", async () => {
  const p = page({ idbFlags: { abortWrites: true } });
  const { flow } = await fundedUsdg(p, 1);
  await flow.mint("small");
  assert.equal(flow.state.phase, "minted");
  assert.equal(heldTokens(flow).length, 500);
  await flow.fileSaved();
  assert.equal(flow.state.phase, "discarded");
});

test("tokens from earlier visits are listed, counted and can be deleted", async () => {
  const p = page();
  const { flow } = await fundedUsdg(p, 1);
  await flow.mint("small");
  const later = p.make();
  await later.init();
  assert.equal(later.info.tokens.length, 500);
  assert.equal(later.getSnapshot().summary.count, 500);
  assert.equal(later.state.phase, "choose", "no key is left over");
  const some = later.info.tokens.slice(0, 10).map((t) => t.token);
  await later.deleteTokens(some);
  assert.equal(later.info.tokens.length, 490);
  assert.equal((await (await openPurse({ indexedDB: p.idb })).list()).length, 490);
});

// ---- reloads ---------------------------------------------------------------------------------------------------

test("a reload while waiting for the payment picks the key back up", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  const secret = secretIn(p);
  flow.markSent(3);
  const back = p.make();
  await back.init();
  assert.equal(back.state.phase, "waiting");
  assert.equal(back.state.expectedUsd, 3);
  assert.equal(back.deposit.key_hash, flow.deposit.key_hash, "the deposit instructions are read from the router again");
  p.router.credit(secret, 3);
  assert.equal(await back.waitForCredit(), true);
  await back.mint("small");
  assert.equal(back.state.phase, "discarded");
});

test("a reload in the middle of the wallet step waits for the payment instead of offering to pay twice", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  const secret = secretIn(p);
  p.wallet.flags.onSend = () => new Promise(() => {}); // the wallet is still open when the tab is reloaded
  void flow.payUsdg("5").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flow.state.phase, "paying");
  const back = p.make();
  await back.init();
  assert.equal(back.state.phase, "waiting", "the payment may have gone through, so it is not offered again");
  assert.equal(back.state.sent, true);
  p.router.credit(secret, 5);
  assert.equal(await back.waitForCredit(), true);
});

test("an unfinished purchase belongs to the key that made it: another key in the same browser leaves it alone", async () => {
  const a = page();
  const { flow: flowA } = await fundedUsdg(a, 1);
  a.router.state.hooks.afterPurchase = () => {
    throw a.router.networkError();
  };
  await assert.rejects(flowA.mint("large"));
  assert.equal(flowA.pending.size, 1);
  // a second tab of the same browser (same IndexedDB), with a key of its own, on the same router
  const b = page({ router: a.router, idb: a.idb });
  const flowB = b.make();
  await flowB.init();
  assert.equal(flowB.pending.size, 0, "it does not pick up a purchase another key made");
  a.router.state.hooks.afterPurchase = undefined;
  await flowB.begin("usdg");
  b.wallet.flags.onSend = () => a.router.credit(secretIn(b), 1);
  await flowB.payUsdg("1");
  await flowB.waitForCredit();
  const chargedBefore = a.router.state.charged;
  await flowB.mint("large");
  assert.equal(a.router.state.charged, chargedBefore + 1, "only its own purchase was made");
  assert.equal(flowB.info.tokens.length >= 5, true);
  // the first tab still has its purchase to finish
  const pendingLeft = await (await openPurse({ indexedDB: a.idb })).listPending();
  assert.equal(pendingLeft.length, 1);
  const reloaded = a.make();
  await reloaded.init();
  assert.equal(reloaded.pending.size, 1);
  await reloaded.mint("large");
  assert.equal(reloaded.pending.size, 0);
  assert.equal(reloaded.state.phase, "discarded");
  assert.deepEqual(await (await openPurse({ indexedDB: a.idb })).listPending(), []);
});

test("a reload after the key was disabled, or with a key the router no longer knows, starts clean", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  await flow.cancel();
  p.session.map.set(SESSION_ITEM, JSON.stringify({ v: 1, secret: "sk-ar-v1-" + "cd".repeat(32), method: "usdg", sent: true }));
  const back = p.make();
  await back.init();
  assert.equal(back.state.phase, "choose");
  assert.equal(back.getSnapshot().holdsKey, false);
  assert.equal(p.session.map.has(SESSION_ITEM), false, "the dead key was removed");
});

test("a reload while offline resumes from what the tab remembers", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await flow.begin("usdg");
  flow.markSent(3);
  p.router.state.hooks.before = (method, path) => {
    if (path === "/api/v1/key" || path === "/api/v1/credits") throw p.router.networkError();
  };
  const back = p.make();
  await back.init();
  assert.equal(back.state.phase, "waiting");
  assert.equal(back.getSnapshot().holdsKey, true);
});

// ---- the router --------------------------------------------------------------------------------------------------

test("a router that does not issue blind tokens is reported, and no key is made for it", async () => {
  const p = page({ routerOptions: { blindOff: true } });
  const flow = p.make();
  await flow.init();
  assert.equal(flow.info.blind, "off");
  await assert.rejects(flow.begin("usdg"), /not issuing blind tokens/);
  assert.equal(p.router.state.keys.size, 0);
  assert.equal(p.session.map.has(SESSION_ITEM), false);
});

test("a second step cannot start while one is running, and steps out of order are refused", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  await assert.rejects(flow.payUsdg("5"), Error); // no key yet
  const first = flow.begin("usdg");
  await assert.rejects(flow.begin("usdg"), /still running/);
  await first;
  await assert.rejects(flow.begin("usdg"), IllegalTransition);
  await assert.rejects(flow.mint("balanced"), IllegalTransition);
  assert.equal(flow.state.phase, "keyed");
});

test("subscribers see each change, and can stop listening", async () => {
  const p = page();
  const flow = p.make();
  const phases = [];
  const off = flow.subscribe((snap) => phases.push(snap.state.phase));
  await flow.init();
  await flow.begin("usdg");
  off();
  await flow.cancel();
  assert.ok(phases.includes("keyed"));
  assert.ok(!phases.includes("discarded"));
});

// ---- $ANYR -------------------------------------------------------------------------------------------------------

async function anyrPage(o = {}) {
  const p = page(o);
  const flow = p.make();
  await flow.init();
  const account = p.router.walletAccount(p.wallet.address);
  p.router.credit(account, 2); // the wallet's account already holds $2.00 from earlier
  return { p, flow, account };
}

test("$ANYR: the credit lands on the wallet's account, and only the newly credited amount is turned into tokens", async () => {
  const { p, flow, account } = await anyrPage();
  await flow.begin("anyr");
  assert.equal(flow.state.method, "anyr");
  assert.equal(flow.wallet, p.wallet.address);
  assert.deepEqual(p.wallet.calls.filter((c) => typeof c === "string"), ["connect", "personalSign"]);
  const key = flow.key();
  assert.equal(p.router.keyRecord(key).account, account, "the key belongs to the sending wallet's account");

  p.wallet.flags.onSend = (txs) => {
    assert.equal(txs.length, 1);
    assert.equal(txs[0].to, ANYR_OFFICIAL);
    assert.match(txs[0].data, /^0xa9059cbb/);
    assert.ok(txs[0].data.includes(ESCROW.slice(2)), "sent to the escrow address");
    assert.ok(txs[0].data.endsWith((1000n * 10n ** 18n).toString(16).padStart(64, "0")), "1000 tokens, exactly");
    p.router.escrow(p.wallet.address, { usd: 0.6, stage: "confirming" });
  };
  await flow.payAnyr("1000");
  assert.equal(flow.state.phase, "waiting");
  assert.ok(Math.abs(flow.state.expectedUsd - 0.2) < 1e-9, "1000 x $0.0002 in credit");

  // not credited yet: the deposit is on its way
  assert.equal((await flow.checkCredit()).funded, false);
  assert.equal(flow.getSnapshot().progress.deposit.stage, "confirming");
  // credited
  p.router.state.escrowDeposits.get(account)[0].stage = "credited";
  p.router.state.escrowDeposits.get(account)[0].status = "credited";
  p.router.state.escrowDeposits.get(account)[0].credited_usd = 0.6;
  p.router.credit(account, 0.6);
  assert.equal((await flow.checkCredit()).funded, true);
  assert.equal(flow.state.spendablePico, usdToPico("0.6").toString(), "$0.60, not the $2.60 the account holds");

  await flow.mint("balanced");
  const spent = heldTokens(flow).reduce((n, t) => n + usdToPico(t.value_usd), 0n);
  assert.ok(spent <= usdToPico("0.6") && spent > usdToPico("0.598"), `spent ${spent}`);
  assert.ok(p.router.balanceOf(account) >= usdToPico("2"), "the $2.00 the account already had was not touched");
  await verifyAll(flow, p.router);

  // the wallet key goes; the wallet account, which holds the remainder, stays
  assert.equal(flow.state.phase, "discarded");
  assert.equal(p.router.keyRecord(key).disabled, true);
  assert.equal(flow.state.discarded.remote, true);
});

test("$ANYR: nothing is bought from a balance that was there before, even when the deposit is not credited", async () => {
  const { p, flow } = await anyrPage();
  await flow.begin("anyr");
  flow.markSent(1);
  assert.equal((await flow.checkCredit()).funded, false, "$2.00 was already on the account and is not offered");
  await assert.rejects(flow.mint("balanced"), IllegalTransition);
});

test("$ANYR: no price, a capped amount, another contract or another wallet stops the transfer before it is sent", async () => {
  const noPrice = await anyrPage({ routerOptions: { anyrPrice: null } });
  await noPrice.flow.begin("anyr");
  await assert.rejects(noPrice.flow.payAnyr("1000"), /no \$ANYR price/);
  assert.equal(noPrice.flow.state.phase, "keyed");
  assert.ok(!noPrice.p.wallet.calls.some((c) => Array.isArray(c) && c[0] === "send"));

  const capped = await anyrPage();
  await capped.flow.begin("anyr");
  await assert.rejects(capped.flow.payAnyr("10000000"), /credited per deposit/); // 10M x $0.0002 = $2,000 > $500
  await assert.rejects(capped.flow.payAnyr("0"), /above zero/);
  await assert.rejects(capped.flow.payAnyr("abc"), /number/);
  assert.ok(!capped.p.wallet.calls.some((c) => Array.isArray(c) && c[0] === "send"));

  const unofficial = await anyrPage({ routerOptions: { anyrAddress: "0x" + "12".repeat(20) } });
  await unofficial.flow.begin("anyr");
  await assert.rejects(unofficial.flow.payAnyr("1000"), /not the official one/);
  assert.ok(!unofficial.p.wallet.calls.some((c) => Array.isArray(c) && c[0] === "send"));

  const switched = await anyrPage();
  await switched.flow.begin("anyr");
  switched.p.wallet.address = "0x" + "cd".repeat(20);
  await assert.rejects(switched.flow.payAnyr("1000"), /Switch your wallet back/);
  assert.ok(!switched.p.wallet.calls.some((c) => Array.isArray(c) && c[0] === "send"));
});

test("$ANYR: no wallet, or a refused signature, makes no key", async () => {
  const none = page({ walletFlags: { hasWallet: false } });
  const f1 = none.make();
  await f1.init();
  await assert.rejects(f1.begin("anyr"), /No browser wallet/);
  assert.equal(f1.state.phase, "choose");
  const refused = page({ walletFlags: { rejectSign: true } });
  const f2 = refused.make();
  await f2.init();
  await assert.rejects(f2.begin("anyr"));
  assert.equal(f2.state.phase, "choose");
  assert.equal(refused.router.state.keys.size, 0);
  assert.equal(refused.session.map.has(SESSION_ITEM), false);
});

test("$ANYR: a reload restores the wallet key with the balance it must not touch", async () => {
  const { p, account } = await anyrPage();
  const a = p.make();
  await a.init();
  await a.begin("anyr");
  a.markSent(0.2);
  const b = p.make();
  await b.init();
  assert.equal(b.state.phase, "waiting", "$2.00 of older balance does not count as a credit");
  assert.equal(b.wallet, p.wallet.address);
  p.router.escrow(p.wallet.address, { usd: 0.6, stage: "credited" });
  assert.equal(await b.waitForCredit(), true);
  assert.equal(b.state.spendablePico, usdToPico("0.6").toString());
  assert.ok(p.router.balanceOf(account) >= usdToPico("2.6"));
});

// ---- the plan sees the directory the router lists ---------------------------------------------------------------

test("the plan the page shows uses only keys that issue now", async () => {
  const p = page();
  const flow = p.make();
  await flow.init();
  const sizes = issuingKeys(flow.info.directory);
  assert.deepEqual(sizes.map((s) => s.key.denomination), [1000, 10000, 100000]);
  assert.equal(planPurchase({ budgetPico: usdToPico("1"), directory: flow.info.directory }).costPico, usdToPico("1"));
  assert.ok(toBase64Url(new Uint8Array(3)).length > 0);
});
