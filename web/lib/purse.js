// "Private tokens": pay from your own wallet, end up holding blind tokens in this browser.
//
//   1. a one-time key is created (POST /api/v1/keys, no account) and kept in memory / this tab's sessionStorage
//   2. you pay it from your wallet: USDG to the key, or $ANYR to the escrow (which credits the sending wallet's account)
//   3. the page waits for the credit to appear
//   4. the page blinds tokens here, the router signs them blind, the page unblinds them (lib/blind-rsa.js)
//   5. the tokens are kept in IndexedDB and can be downloaded as a token file (lib/purse-file.js)
//   6. the one-time key is disabled on the router, overwritten in memory and removed from storage
//
// This file is the state machine (`reduce`), the purchase plan (`planPurchase`) and the flow that runs the steps
// (`PurseFlow`). It touches no browser global: the API, the wallet, storage and the clock are passed in, so each step
// and each failure can be exercised without a browser or a chain. The router keeps all the money logic; nothing here adds any.

import { blindTokens, finalizeTokens, fromBase64, toBase64Url } from "./blind-rsa.js";
import { creditEstimate, depositView, erc20TransferData, rateView, stageOf } from "./anyr-pay.js";
import { TOKEN_FILE_NAME, buildTokenFile, entryFor, picoToUsdText, serializeTokenFile, summarize, usdToPico } from "./purse-file.js";
import { KeyHolder, clearSession, loadSession, saveSession } from "./purse-store.js";

export const KEY_NAME = "One-time key for private tokens";
const USDG_AMOUNT = /^\d+(\.\d{1,6})?$/;
const MICRO = 1_000_000n; // pico-dollars per micro-dollar

// ---- money -----------------------------------------------------------------------------------------------------

/** A JSON number of dollars to pico-dollars, rounded down to a whole micro-dollar (never up: the plan must not overspend). */
export function usdNumberToPico(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.floor(n * 1e6 + 1e-6)) * MICRO;
}

// ---- state machine ---------------------------------------------------------------------------------------------

export const PHASES = ["choose", "keyed", "paying", "waiting", "funded", "buying", "minted", "discarded"];

export class IllegalTransition extends Error {
  constructor(phase, event) {
    super(`"${event}" is not possible while the page is in "${phase}".`);
    this.name = "IllegalTransition";
  }
}

export const initialState = () => ({
  phase: "choose",
  method: null, // "usdg" | "anyr"
  keyHash: null, // the on-chain key hash a USDG deposit names
  sent: false, // a payment was sent (or the person says it was)
  expectedUsd: null,
  spendablePico: "0", // what the tokens may be bought with, as a string of pico-dollars
  mintedCount: 0,
  mintedPico: "0",
  remainingPico: null,
  saved: null, // "browser" | "file": where the finished tokens are safe
  discarded: null, // { memory, stored, remote }
  error: null,
});

const big = (s) => BigInt(s ?? 0);

/** The next state for an event, or IllegalTransition. Pure: it never changes its input. */
export function reduce(state, event) {
  const s = { ...state };
  const bad = () => {
    throw new IllegalTransition(state.phase, event.type);
  };
  const from = (...phases) => {
    if (!phases.includes(state.phase)) bad();
  };
  switch (event.type) {
    case "key_created":
      from("choose");
      if (event.method !== "usdg" && event.method !== "anyr") bad();
      return { ...initialState(), phase: "keyed", method: event.method, keyHash: event.keyHash ?? null };
    case "restored": {
      from("choose");
      if (!["keyed", "waiting", "funded"].includes(event.phase)) bad();
      if (event.phase === "funded" && big(event.spendablePico) <= 0n && event.resume !== true) bad();
      return {
        ...initialState(),
        phase: event.phase,
        method: event.method,
        keyHash: event.keyHash ?? null,
        sent: !!event.sent || event.phase !== "keyed",
        expectedUsd: event.expectedUsd ?? null,
        spendablePico: String(event.spendablePico ?? "0"),
        mintedCount: event.mintedCount ?? 0,
        mintedPico: String(event.mintedPico ?? "0"),
      };
    }
    case "pay_started":
      from("keyed");
      return { ...s, phase: "paying", error: null };
    case "pay_failed":
      from("paying");
      return { ...s, phase: "keyed", error: event.error || "The payment did not go through." };
    case "pay_sent":
      from("keyed", "paying");
      return { ...s, phase: "waiting", sent: true, expectedUsd: event.expectedUsd ?? null, error: null };
    case "credit_seen":
      from("keyed", "waiting", "funded");
      if (big(event.spendablePico) <= 0n) bad();
      return { ...s, phase: "funded", sent: true, spendablePico: String(event.spendablePico), error: null };
    case "buy_started":
      from("funded");
      // Nothing to spend is only allowed to finish a purchase the router already charged (event.resume).
      if (big(s.spendablePico) <= 0n && event.resume !== true) bad();
      return { ...s, phase: "buying", error: null };
    case "batch_done":
      from("buying");
      return { ...s, mintedCount: s.mintedCount + event.count, mintedPico: String(big(s.mintedPico) + big(event.costPico)) };
    case "buy_paused":
      from("buying");
      return { ...s, phase: "funded", spendablePico: String(event.remainingPico ?? s.spendablePico), error: event.error ?? null };
    case "buy_finished":
      from("buying");
      if (s.mintedCount < 1) bad();
      return { ...s, phase: "minted", remainingPico: String(event.remainingPico ?? "0"), error: null };
    case "tokens_saved":
      from("minted");
      if (event.where !== "browser" && event.where !== "file") bad();
      return { ...s, saved: s.saved === "browser" ? "browser" : event.where };
    case "key_discarded": {
      // A key that never received a payment can always be dropped. After minting, only once the tokens are safe.
      // While money is on the key (paying, waiting, funded) it takes an explicit forfeit, because the key is the only way back to it.
      const ok = (state.phase === "keyed" && !state.sent) || (state.phase === "minted" && state.saved !== null) || (["keyed", "paying", "waiting", "funded"].includes(state.phase) && event.forfeit === true);
      if (!ok) bad();
      return { ...s, phase: "discarded", discarded: event.result ?? { memory: true, stored: true, remote: null }, error: null };
    }
    case "reset":
      from("discarded");
      return initialState();
    case "failed":
      if (state.phase === "discarded") bad();
      return { ...s, error: event.error || "Something went wrong." };
    case "clear_error":
      return { ...s, error: null };
    default:
      return bad();
  }
}

// ---- what to buy ---------------------------------------------------------------------------------------------

/**
 * The tokens a budget buys. Sizes are the directory's issuing keys (one per denomination, the latest epoch).
 * mix: "balanced" spreads the budget over the sizes (half in the smallest), or "small" | "medium" | "large" puts it in
 * one size first. Whatever is left is filled with the largest sizes that still fit, so less than one of the smallest
 * token is ever left over. No more than `maxTokens` tokens are planned: past that, groups of smaller tokens are merged
 * into the next size up. Each purchase request is split at `maxBatch`.
 */
export const MIXES = ["balanced", "small", "medium", "large"];

export function issuingKeys(directory) {
  const best = new Map();
  for (const k of directory?.keys ?? []) {
    if (k.status !== "issuing") continue;
    let value;
    try {
      value = usdToPico(k.value_usd);
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    const prev = best.get(k.denomination);
    if (!prev || Date.parse(k.redeem_until) > Date.parse(prev.key.redeem_until)) best.set(k.denomination, { key: k, valuePico: value });
  }
  return [...best.values()].sort((a, b) => (a.valuePico < b.valuePico ? -1 : a.valuePico > b.valuePico ? 1 : 0));
}

const WEIGHTS = { balanced: { 1: [1000], 2: [600, 400], 3: [500, 300, 200] } };

function weightsFor(mix, n) {
  if (mix === "small") return Array.from({ length: n }, (_, i) => (i === 0 ? 1000 : 0));
  if (mix === "medium") return Array.from({ length: n }, (_, i) => (i === Math.min(1, n - 1) ? 1000 : 0));
  if (mix === "large") return Array.from({ length: n }, (_, i) => (i === n - 1 ? 1000 : 0));
  return WEIGHTS.balanced[Math.min(n, 3)] ?? [1000];
}

export function planPurchase({ budgetPico, directory, mix = "balanced", maxBatch = 32, maxTokens = 600 }) {
  const budget = BigInt(budgetPico);
  const sizes = issuingKeys(directory);
  const empty = { lines: [], batches: [], tokenCount: 0, costPico: 0n, leftoverPico: budget, requests: 0 };
  if (!sizes.length || budget <= 0n) return empty;
  const w = weightsFor(mix, sizes.length);
  const counts = sizes.map((s, i) => (budget * BigInt(w[i] ?? 0)) / 1000n / s.valuePico);
  let spent = counts.reduce((sum, c, i) => sum + c * sizes[i].valuePico, 0n);
  // Fill what is left with the largest sizes that fit.
  for (let i = sizes.length - 1; i >= 0; i--) {
    const c = (budget - spent) / sizes[i].valuePico;
    counts[i] += c;
    spent += c * sizes[i].valuePico;
  }
  // Too many tokens: merge groups of a size into the next size up. Sizes are exact multiples of each other, so the
  // value stays the same; a size that does not divide evenly is left alone.
  const total = () => counts.reduce((a, c) => a + c, 0n);
  for (let i = 0; i < sizes.length - 1 && total() > BigInt(maxTokens); i++) {
    if (sizes[i + 1].valuePico % sizes[i].valuePico !== 0n) continue;
    const ratio = sizes[i + 1].valuePico / sizes[i].valuePico;
    if (ratio < 2n) continue;
    const groups = (total() - BigInt(maxTokens) + ratio - 2n) / (ratio - 1n); // each merge removes ratio - 1 tokens
    const merge = groups < counts[i] / ratio ? groups : counts[i] / ratio;
    counts[i] -= merge * ratio;
    counts[i + 1] += merge;
  }
  spent = counts.reduce((sum, c, i) => sum + c * sizes[i].valuePico, 0n);
  const lines = sizes.map((s, i) => ({ key: s.key, valuePico: s.valuePico, count: Number(counts[i]) })).filter((l) => l.count > 0).sort((a, b) => (a.valuePico < b.valuePico ? 1 : -1));
  const batches = [];
  for (const l of lines) for (let left = l.count; left > 0; left -= maxBatch) batches.push({ key: l.key, valuePico: l.valuePico, count: Math.min(maxBatch, left) });
  return { lines, batches, tokenCount: lines.reduce((n, l) => n + l.count, 0), costPico: spent, leftoverPico: budget - spent, requests: batches.length };
}

// ---- what the page says --------------------------------------------------------------------------------------

export const LINKABLE = [
  ["Your payment.", "Sending USDG or $ANYR is a public transaction on the chain, and the router reads it from there. Anyone, the router included, can see that your wallet paid, how much, and to which one-time key (USDG) or to the escrow address ($ANYR)."],
  ["The purchase.", "The router records that the one-time key spent an amount on tokens: how many, and of which sizes. For $ANYR the credit sits on your wallet’s account, so the purchase is recorded against that wallet. Put together, “this wallet bought N tokens” is on record."],
  ["Your network address, and when.", "Buying over the clearnet shows the router your address, and buying right before you spend links the two by time. This page also works at the router’s onion address, where the router sees no address; the USDG route lets you pay from any wallet app, so the rest can run in Tor Browser."],
];
export const NOT_LINKABLE = [
  ["Which prompts the tokens paid for.", "The router signs each token blind: it never sees the token it signs. When you spend one, the router can check that it is genuine and unspent, but it cannot tell which purchase or wallet it came from. A call paid with a token is recorded against a hash of the token, with no key, account or wallet, and its receipt says the same."],
];
export const NOT_HIDDEN = [
  ["The text of a request.", "On every lane the router reads a request in memory to route it, and that includes a call paid with a token. Tokens hide who is paying, not what is sent."],
  ["Your address while you spend, unless you use Tor.", "Spend tokens through the router’s onion address to keep your network address from it. Calls on one Tor circuit can be linked to each other."],
  ["Nothing is refunded.", "A token pays for one call, up to its value, and the unused part is not returned. Tokens stop working after the date shown with them, and the router keeps no record of who holds them, so a lost token cannot be replaced."],
];

/** How each payment method is credited, in words the page shows before anything is sent. */
export function usdgTerms() {
  return "USDG is credited to the one-time key one for one, with no haircut. The page then converts the whole credit into tokens at the same value.";
}
export function anyrTerms(anyr) {
  if (!anyr) return null;
  const haircut = anyr.haircut_bps ? ` minus a ${anyr.haircut_bps / 100}% haircut` : " with no haircut";
  return `$${anyr.symbol} is a payment method here. It is valued at its pool price (the lower of the spot price and the ${anyr.twap_minutes}-minute time-weighted average)${haircut}, and credited up to $${anyr.max_usd_per_deposit.toLocaleString("en-US")} per deposit; anything above that is held for operator review. The credit lands on your wallet’s account, and the page turns only the newly credited amount into tokens.`;
}

export const chainFromStatus = (status) => {
  const c = status?.chain || {};
  return { id: c.chain_id, name: c.chain_id === 4663 ? "Robinhood Chain" : "Chain " + c.chain_id, rpc: c.public_rpc, explorer: c.explorer };
};

// ---- the flow --------------------------------------------------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const min = (a, b) => (a < b ? a : b);
const newId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
const errText = (e) => (e?.code === 4001 || /user (rejected|denied)/i.test(String(e?.message)) ? "You declined it in your wallet. Nothing was sent." : e?.message || String(e));
const STALE_KEY = ["epoch_closed", "token_key_revoked", "epoch_not_open", "unknown_token_key"];

/**
 * deps: { api(path, {key, method, body}), wallet: { hasWallet, connect, ensureChain, sendTransactions, personalSign },
 *         openPurse(), session (a Storage), officialAnyr (the $ANYR contract this page accepts), sleep(ms), random }.
 * Everything a step needs from outside comes through here.
 */
export class PurseFlow {
  constructor(deps) {
    this.d = { sleep: wait, ...deps };
    this.state = initialState();
    this.info = { blind: "loading", directory: null, status: null, storage: "unknown", storageError: null, sessionKept: null, tokens: [] };
    this.progress = { message: "", available: null, deposit: null, minted: 0, target: 0 };
    this.busy = null;
    this.holder = null; // the one-time key, as bytes that can be overwritten
    this.meta = null; // what is known about that key besides its secret
    this.purse = null; // IndexedDB, or null when the browser will not give it
    this.pending = new Map(); // this key's purchases sent but not yet unblinded, by id
    this.stored = []; // every unfinished purchase found in IndexedDB, whichever key made it
    this.run = { budget: 0n, spent: 0n };
    this.unsaved = 0; // tokens that reached memory but not IndexedDB
    this.listeners = new Set();
    this.snapshot = null;
    this.emit();
  }

  // -- observation (React's useSyncExternalStore reads these)
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;
  emit() {
    this.snapshot = { state: this.state, info: { ...this.info }, progress: { ...this.progress }, busy: this.busy, summary: summarize(this.info.tokens), holdsKey: !!this.holder?.present };
    for (const fn of this.listeners) fn(this.snapshot);
  }
  dispatch(event) {
    this.state = reduce(this.state, event);
    this.persist();
    this.emit();
  }
  say(message) {
    this.progress = { ...this.progress, message };
    this.emit();
  }
  fail(e) {
    this.dispatch({ type: "failed", error: errText(e) });
  }
  get deposit() {
    return this.meta?.deposit ?? null;
  }
  get wallet() {
    return this.meta?.wallet ?? null;
  }

  async guard(name, fn) {
    if (this.busy) throw new Error("Another step is still running.");
    this.busy = name;
    this.emit();
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  // -- setup
  /** Read the router and the browser's storage once; calling it again returns the same promise. */
  init() {
    this.startup ??= this.load();
    return this.startup;
  }

  async load() {
    const { api } = this.d;
    const [status, directory] = await Promise.allSettled([api("/api/v1/status"), api("/api/v1/blind/keys")]);
    this.info.status = status.status === "fulfilled" ? status.value.data : null;
    if (directory.status === "fulfilled" && directory.value?.data?.keys) {
      this.info.directory = directory.value.data;
      this.info.blind = issuingKeys(directory.value.data).length ? "available" : "closed";
    } else this.info.blind = directory.reason?.status === 404 ? "off" : "error";
    try {
      this.purse = await this.d.openPurse();
      this.info.tokens = await this.purse.list();
      this.info.storage = "browser";
      this.stored = await this.purse.listPending(); // purchases any tab of this browser left unfinished; each is picked up only by the key that made it
    } catch (e) {
      this.purse = null;
      this.info.storage = "none";
      this.info.storageError = e?.message || "Token storage is not available.";
    }
    await this.restore();
    this.emit();
  }

  /** Pick a stored one-time key back up after a reload, and find out where its money is. */
  async restore() {
    const rec = loadSession(this.d.session);
    if (!rec) return;
    this.holder = new KeyHolder(rec.secret);
    this.meta = { method: rec.method, hash: rec.hash, keyHash: rec.keyHash, baselinePico: rec.baselinePico ?? "0", known: rec.known ?? [], wallet: rec.wallet ?? null };
    const sent = !!rec.sent || !!rec.paying; // a reload in the middle of the wallet step may have followed a payment that went through
    for (const p of this.stored) if (p.owner === this.meta.hash) this.pending.set(p.id, p);
    let phase = sent ? "waiting" : "keyed";
    let spendable = "0";
    try {
      const k = await this.d.api("/api/v1/key", { key: rec.secret });
      this.meta.hash = k.data?.hash ?? this.meta.hash;
      if (rec.method === "usdg") this.meta.deposit = k.data?.deposit ?? null;
      const usable = (await this.creditPico()) - big(this.meta.baselinePico);
      if (usable > 0n) {
        phase = "funded";
        spendable = String(usable);
      } else if (this.pending.size > 0) phase = "funded"; // a purchase the router may already have charged is waiting to be finished
    } catch (e) {
      if (e?.status === 401 || e?.type === "key_disabled") {
        this.forgetKey(); // the router no longer honours it: nothing to resume
        return;
      }
      // Any other failure (offline): resume from what the tab remembers; the next check finds the balance.
    }
    this.state = reduce(this.state, { type: "restored", phase, method: rec.method, keyHash: rec.keyHash, sent, expectedUsd: rec.expectedUsd ?? null, spendablePico: spendable, resume: this.pending.size > 0, mintedCount: rec.minted ?? 0, mintedPico: rec.mintedPico ?? "0" });
    this.info.sessionKept = true;
  }

  forgetKey() {
    this.holder?.wipe();
    this.holder = null;
    this.meta = null;
    return clearSession(this.d.session);
  }

  persist() {
    if (!this.holder?.present || !this.meta) return;
    const r = saveSession({ secret: this.holder.reveal(), method: this.meta.method, hash: this.meta.hash, keyHash: this.meta.keyHash, baselinePico: this.meta.baselinePico, known: this.meta.known, wallet: this.meta.wallet, sent: this.state.sent, paying: this.state.phase === "paying", expectedUsd: this.state.expectedUsd, minted: this.state.mintedCount, mintedPico: this.state.mintedPico }, this.d.session);
    this.info.sessionKept = r.ok;
  }

  key() {
    return this.holder.reveal();
  }
  /** The key for the person to copy, or "" when there is none. Called only when they press "Copy recovery key". */
  recoveryKey() {
    return this.holder?.present ? this.holder.reveal() : "";
  }
  async creditPico() {
    const c = await this.d.api("/api/v1/credits", { key: this.key() });
    return usdNumberToPico(c.data?.available);
  }

  /** Disable the key on the router (up to three tries). true: disabled; false: could not; null: no key to disable. */
  async disableRemote() {
    if (!this.holder?.present || !this.meta?.hash) return null;
    for (let i = 0; i < 3; i++) {
      try {
        await this.d.api(`/api/v1/keys/${this.meta.hash}`, { key: this.key(), method: "PATCH", body: { disabled: true } });
        return true;
      } catch (e) {
        if (e?.type === "key_disabled") return true;
        if (i < 2) await this.d.sleep(500);
      }
    }
    return false;
  }

  // -- 1. the one-time key
  begin(method) {
    return this.guard("key", async () => {
      if (this.state.phase !== "choose") throw new IllegalTransition(this.state.phase, "begin");
      if (this.info.blind !== "available") throw new Error("This router is not issuing blind tokens right now.");
      const { api } = this.d;
      try {
        if (method === "usdg") {
          const r = await api("/api/v1/keys", { method: "POST", body: { name: KEY_NAME } });
          this.holder = new KeyHolder(r.key);
          this.meta = { method, hash: r.data.hash, keyHash: r.deposit.key_hash, baselinePico: "0", known: [], wallet: null, deposit: r.deposit };
        } else {
          // $ANYR sent to the escrow is credited to the sending wallet's account, so the key that buys the tokens is a
          // fresh key on that account, made with one signature. It is disabled again when the tokens are safe.
          const w = this.d.wallet;
          if (!w.hasWallet()) throw new Error("No browser wallet was found. Pay with USDG instead: the page shows the key hash to send to from any wallet app.");
          const address = await w.connect();
          const { data: challenge } = await api("/api/v1/auth/wallet/challenge", { method: "POST", body: { address } });
          const signature = await w.personalSign(address, challenge.message);
          const r = await api("/api/v1/auth/wallet", { method: "POST", body: { address, nonce: challenge.nonce, signature, name: KEY_NAME } });
          this.holder = new KeyHolder(r.key);
          this.meta = { method, hash: r.data.hash, keyHash: null, baselinePico: "0", known: [], wallet: address };
          try {
            this.meta.baselinePico = String(await this.creditPico()); // credit the account already had: never touched
            this.meta.known = ((await api("/api/v1/escrow/deposits", { key: this.key() })).data?.deposits ?? []).map((x) => x.id);
          } catch (e) {
            await this.disableRemote();
            throw e;
          }
        }
        this.dispatch({ type: "key_created", method, keyHash: this.meta.keyHash });
      } catch (e) {
        this.forgetKey();
        this.fail(e);
        throw e;
      }
    });
  }

  // -- 2. pay
  payUsdg(amountText) {
    return this.guard("pay", async () => {
      this.dispatch({ type: "pay_started" });
      try {
        const amount = String(amountText).trim();
        if (!USDG_AMOUNT.test(amount) || Number(amount) <= 0) throw new Error("Enter a USDG amount with up to 6 decimals.");
        const w = this.d.wallet;
        if (!w.hasWallet()) throw new Error("No browser wallet was found. Send USDG to the key hash shown below from any wallet app, then choose “I have sent it”.");
        if (!this.meta.deposit?.credits_contract) throw new Error("This router has no Credits contract configured, so it cannot take USDG.");
        const from = await w.connect();
        await w.ensureChain(chainFromStatus(this.info.status));
        const tx = (await this.d.api("/api/v1/credits/deposit-tx", { key: this.key(), method: "POST", body: { amount } })).data;
        await w.sendTransactions(from, tx.transactions, (m) => this.say(m));
        this.dispatch({ type: "pay_sent", expectedUsd: Number(amount) });
      } catch (e) {
        this.dispatch({ type: "pay_failed", error: errText(e) });
        throw e;
      }
    });
  }

  payAnyr(amountText) {
    return this.guard("pay", async () => {
      this.dispatch({ type: "pay_started" });
      try {
        const anyr = this.info.status?.escrow?.anyr;
        const [escrow, price] = await Promise.all([this.d.api("/api/v1/escrow"), this.d.api("/api/v1/escrow/anyr/price")]);
        if (!anyr || !escrow.data?.address) throw new Error("This router does not take $ANYR.");
        if (this.d.officialAnyr && anyr.address.toLowerCase() !== this.d.officialAnyr.toLowerCase()) throw new Error("The router lists a $ANYR contract that is not the official one. Nothing was sent.");
        const rate = rateView(price.data);
        if (rate.state !== "live") throw new Error("There is no $ANYR price at the moment, so the credit cannot be shown before you send. Try again shortly.");
        const estimate = creditEstimate({ amountText, decimals: anyr.decimals, rate: rate.rate, limit: anyr.max_usd_per_deposit ?? null });
        if (!estimate.ok) throw new Error(estimate.error);
        if (estimate.capped) throw new Error(`That is above the $${anyr.max_usd_per_deposit} credited per deposit. Send less, or send it in parts.`);
        const w = this.d.wallet;
        const from = await w.connect();
        if (from.toLowerCase() !== this.meta.wallet.toLowerCase()) throw new Error("Switch your wallet back to the account you signed in with. Tokens sent from another wallet are credited to that wallet.");
        await w.ensureChain(chainFromStatus(this.info.status));
        const data = erc20TransferData(escrow.data.address, estimate.raw);
        await w.sendTransactions(from, [{ to: anyr.address, data, description: `Send ${String(amountText).trim()} ${anyr.symbol} to the escrow address` }], (m) => this.say(m));
        this.dispatch({ type: "pay_sent", expectedUsd: estimate.credit });
      } catch (e) {
        this.dispatch({ type: "pay_failed", error: errText(e) });
        throw e;
      }
    });
  }

  /** The person paid from a wallet app of their own: start waiting for the credit. */
  markSent(expectedUsd = null) {
    this.dispatch({ type: "pay_sent", expectedUsd });
  }

  // -- 3. wait for the credit
  /** Look once. Moves to "funded" when the credit is there. */
  async checkCredit() {
    const { api } = this.d;
    const available = await this.creditPico();
    let usable = available - big(this.meta.baselinePico);
    let deposit = null;
    if (this.meta.method === "anyr") {
      const [deps, esc] = await Promise.all([api("/api/v1/escrow/deposits", { key: this.key() }), api("/api/v1/escrow").catch(() => null)]);
      const fresh = (deps.data?.deposits ?? []).filter((x) => !this.meta.known.includes(x.id));
      const credited = fresh.reduce((n, x) => (stageOf(x) === "credited" ? n + usdNumberToPico(x.credited_usd) : n), 0n);
      if (fresh[0]) deposit = { ...depositView(fresh[0], esc?.data), symbol: fresh[0].symbol, amount: fresh[0].amount };
      usable = min(usable, credited); // only what the new deposits were credited, never the balance the account already had
    }
    this.progress = { ...this.progress, available: picoToUsdText(available - big(this.meta.baselinePico)), deposit };
    const expected = this.state.expectedUsd;
    const funded = usable > 0n && (this.meta.method === "anyr" || expected == null || usable >= usdNumberToPico(expected) - MICRO);
    if (funded) this.dispatch({ type: "credit_seen", spendablePico: String(usable) });
    else this.emit();
    return { usablePico: usable, funded };
  }

  /** Poll until the credit appears or `signal` aborts. */
  async waitForCredit({ signal, intervalMs = 3000 } = {}) {
    while (!signal?.aborted && this.state.phase === "waiting") {
      try {
        if ((await this.checkCredit()).funded) return true;
        this.say(this.meta.method === "anyr" ? "Waiting for the chain to finalize the transfer and for the router to credit it." : "Waiting for the deposit to appear on the key.");
      } catch (e) {
        this.say(`Could not read the balance (${e?.message || "error"}). Trying again.`);
      }
      await this.d.sleep(intervalMs);
    }
    return this.state.phase === "funded";
  }

  /** Use the credit that has arrived, when it is less than the amount the person said they sent. */
  useArrivedBalance() {
    return this.guard("use", async () => {
      const arrived = (await this.creditPico()) - big(this.meta.baselinePico);
      if (arrived <= 0n) throw new Error("Nothing has arrived on the key yet.");
      this.dispatch({ type: "credit_seen", spendablePico: String(arrived) });
    });
  }

  // -- 4. buy blind tokens
  /** The plan for the credit that is there, for showing before anything is bought. */
  planFor(mix) {
    const budget = big(this.state.spendablePico);
    const dir = this.info.directory;
    return planPurchase({ budgetPico: budget, directory: dir, mix, maxBatch: dir?.max_batch ?? 32 });
  }

  mint(mix = "balanced") {
    return this.guard("mint", async () => {
      this.dispatch({ type: "buy_started", resume: this.pending.size > 0 });
      this.run = { budget: big(this.state.spendablePico), spent: 0n };
      try {
        const resumed = await this.resumePending(); // finish anything a lost response left behind
        const dir = await this.refreshDirectory();
        const usable = (await this.creditPico()) - big(this.meta.baselinePico);
        const budget = min(usable, this.run.budget - this.run.spent);
        const plan = planPurchase({ budgetPico: budget, directory: dir, mix, maxBatch: dir.max_batch });
        if (!plan.batches.length && resumed === 0) {
          const smallest = issuingKeys(dir)[0];
          throw new Error(smallest ? `The smallest token costs $${picoToUsdText(smallest.valuePico)}, more than the $${picoToUsdText(budget)} on the key.` : "The router has no token size open right now.");
        }
        this.progress = { ...this.progress, minted: 0, target: plan.tokenCount };
        for (const batch of plan.batches) {
          const r = await this.buyBatch(batch, dir);
          this.progress = { ...this.progress, minted: this.progress.minted + r.count };
          this.emit();
          if (r.short) break; // the balance ran out a hair before the plan did
        }
      } catch (e) {
        this.dispatch({ type: "buy_paused", error: errText(e), remainingPico: String(await this.leftover()) });
        throw e;
      }
      const left = await this.leftover();
      const smallest = issuingKeys(this.info.directory)[0];
      if (this.state.mintedCount < 1) {
        const message = "No token could be bought with what is on the key.";
        this.dispatch({ type: "buy_paused", error: message, remainingPico: String(left) });
        throw new Error(message);
      }
      if (!smallest || left < smallest.valuePico) {
        this.dispatch({ type: "buy_finished", remainingPico: String(left) });
        await this.afterMint();
      } else this.dispatch({ type: "buy_paused", error: null, remainingPico: String(left) });
    });
  }

  /** What is still on the key and may be spent: the router's balance, capped by what this purchase started with. */
  async leftover() {
    const cap = this.run.budget - this.run.spent;
    try {
      const usable = (await this.creditPico()) - big(this.meta.baselinePico);
      return min(usable > 0n ? usable : 0n, cap > 0n ? cap : 0n);
    } catch {
      return cap > 0n ? cap : 0n;
    }
  }

  async refreshDirectory() {
    const r = await this.d.api("/api/v1/blind/keys");
    this.info.directory = r.data;
    return r.data;
  }

  /** Finish purchases a lost response left behind; returns how many tokens that gave. */
  async resumePending() {
    let tokens = 0;
    for (const record of [...this.pending.values()]) {
      this.say("Finishing a purchase that was interrupted.");
      tokens += (await this.submit(record, this.info.directory)).count;
    }
    return tokens;
  }

  async buyBatch(batch, dir) {
    let key = batch.key;
    for (let round = 0; round < 3; round++) {
      const record = await this.prepare(key, dir, batch.count);
      try {
        return await this.submit(record, dir);
      } catch (e) {
        if (!STALE_KEY.includes(e?.type)) throw e;
        // The key stopped issuing between listing and buying (nothing was charged): blind again under the key that issues now.
        await this.dropPending(record.id);
        dir = await this.refreshDirectory();
        const next = issuingKeys(dir).find((s) => s.key.denomination === key.denomination);
        if (!next) throw e;
        key = next.key;
      }
    }
    throw new Error("The router’s token keys kept changing. Try again in a moment.");
  }

  /** Blind a batch and remember it (in memory, and in IndexedDB when it works) before anything is sent. */
  async prepare(key, dir, count) {
    const items = await blindTokens(key, dir.challenge_digest, count, this.d.random);
    const record = {
      id: newId(),
      owner: this.meta.hash,
      key: { token_key: key.token_key, token_key_id: key.token_key_id, denomination: key.denomination, value_usd: key.value_usd, epoch: key.epoch, redeem_until: key.redeem_until },
      items: items.map((p) => ({ input: toBase64Url(p.input), blinded: toBase64Url(p.blindedMsg), inv: toBase64Url(p.inv) })),
    };
    await this.rememberPending(record);
    return record;
  }

  async rememberPending(record) {
    this.pending.set(record.id, record);
    await this.purse?.putPending(record).catch(() => undefined); // best effort: retries work from memory either way
  }
  async dropPending(id) {
    this.pending.delete(id);
    await this.purse?.removePending(id).catch(() => undefined);
  }

  /** Send a prepared purchase, riding out limits and lost responses, then unblind, keep and forget it. */
  async submit(record, dir) {
    let failures = 0;
    let waits = 0;
    for (;;) {
      try {
        const res = await this.d.api("/api/v1/blind/purchase", { key: this.key(), method: "POST", body: { token_key_id: record.key.token_key_id, blinded_msgs: record.items.map((x) => x.blinded) } });
        const items = record.items.map((x) => ({ keyId: record.key.token_key_id, input: fromBase64(x.input), blindedMsg: fromBase64(x.blinded), inv: fromBase64(x.inv) }));
        const tokens = await finalizeTokens(record.key, items, res.data.signatures); // throws unless every signature verifies
        await this.keep(tokens.map((t) => entryFor(t, record.key)));
        await this.dropPending(record.id);
        const costPico = usdToPico(res.data.cost_usd);
        this.run.spent += costPico;
        this.dispatch({ type: "batch_done", count: tokens.length, costPico: String(costPico) });
        return { count: tokens.length, costPico, short: false };
      } catch (e) {
        const type = e?.type;
        if (type === "rate_limited") {
          const ms = Number(e.metadata?.retry_after_ms) || (Number(e.retryAfter) > 0 ? Number(e.retryAfter) * 1000 : 6000);
          this.say(`The router limits purchases per minute. Waiting ${Math.ceil(ms / 1000)} seconds.`);
          await this.d.sleep(ms + 250);
          continue;
        }
        if (type === "purchase_in_progress" && ++waits <= 20) {
          await this.d.sleep(1500);
          continue;
        }
        if (type === "insufficient_credits") {
          // The balance is a hair short of the plan (nothing was charged): drop the last token and ask again.
          await this.dropPending(record.id);
          if (record.items.length < 2) return { count: 0, costPico: 0n, short: true };
          record = { ...record, id: newId(), items: record.items.slice(0, -1) };
          await this.rememberPending(record);
          continue;
        }
        if ((e?.status === 0 || e?.status >= 500) && ++failures <= 5) {
          this.say("The connection dropped. Sending the same request again; it cannot be charged twice.");
          await this.d.sleep(1000 * failures);
          continue;
        }
        throw e;
      }
    }
  }

  // -- 5. keep the tokens
  /** Add finished tokens to what the page holds, and to IndexedDB when it works. A token that reached memory is never dropped. */
  async keep(entries) {
    const have = new Set(this.info.tokens.map((t) => t.token));
    const fresh = entries.filter((e) => !have.has(e.token));
    this.info.tokens = [...this.info.tokens, ...fresh];
    if (this.purse) {
      try {
        await this.purse.add(fresh);
      } catch (e) {
        this.info.storageError = e?.message || "The tokens could not be stored in this browser.";
        this.unsaved += fresh.length;
      }
    } else this.unsaved += fresh.length;
    this.emit();
  }

  async afterMint() {
    if (this.purse && this.unsaved === 0) {
      this.dispatch({ type: "tokens_saved", where: "browser" });
      await this.discard();
    }
    // Otherwise the page asks for the download, and discards the key once the file is saved.
  }

  /** The token file for everything held. */
  tokenFile() {
    const file = buildTokenFile(this.info.tokens);
    return { name: TOKEN_FILE_NAME, text: serializeTokenFile(file), count: file.tokens.length };
  }

  /** The person saved the file. That makes the tokens safe even when browser storage failed, so the key can go. */
  async fileSaved() {
    if (this.state.phase !== "minted") return;
    this.dispatch({ type: "tokens_saved", where: "file" });
    await this.discard();
  }

  async deleteTokens(tokens) {
    const gone = new Set(tokens);
    if (this.purse) await this.purse.remove([...gone]);
    this.info.tokens = this.info.tokens.filter((t) => !gone.has(t.token));
    this.emit();
  }

  // -- 6. let the key go
  /**
   * Disable the key on the router, overwrite the copy in memory, remove the copy in sessionStorage. Never throws.
   * Allowed after the tokens are safe, before anything was paid, or with `forfeit` (see the state machine).
   */
  async discard({ forfeit = false } = {}) {
    reduce(this.state, { type: "key_discarded", forfeit, result: {} }); // refuses (throws) if the state does not allow it, before anything is destroyed
    const remote = await this.disableRemote();
    for (const id of [...this.pending.keys()]) await this.dropPending(id); // useless once the key is gone
    this.holder?.wipe();
    const cleared = clearSession(this.d.session);
    this.holder = null;
    this.meta = null;
    this.dispatch({ type: "key_discarded", forfeit, result: { memory: true, stored: cleared.ok, remote } });
  }

  /** Cancel before anything was paid: nothing is on the key, so it just goes. */
  cancel() {
    return this.guard("cancel", () => this.discard());
  }

  startOver() {
    this.dispatch({ type: "reset" });
    this.progress = { message: "", available: null, deposit: null, minted: 0, target: 0 };
    this.unsaved = 0;
    this.emit();
  }
}
