import test from "node:test";
import assert from "node:assert/strict";
import { IllegalTransition, LINKABLE, NOT_HIDDEN, NOT_LINKABLE, PHASES, anyrTerms, initialState, issuingKeys, planPurchase, reduce, usdNumberToPico, usdgTerms } from "../lib/purse.js";
import { usdToPico } from "../lib/purse-file.js";

const step = (state, ...events) => events.reduce((s, e) => reduce(s, e), state);
const key = (denomination, value_usd, extra = {}) => ({ token_key_id: String(denomination).padStart(64, "0"), token_key: "x", epoch: 5, denomination, value_usd, status: "issuing", redeem_until: "2026-10-13T00:00:00.000Z", ...extra });
const directory = () => ({ keys: [key(1000, "0.002"), key(10000, "0.02"), key(100000, "0.2"), key(1000, "0.002", { epoch: 6, status: "upcoming" }), key(10000, "0.02", { epoch: 4, status: "closed" })] });
const funded = () => step(initialState(), { type: "key_created", method: "usdg", keyHash: "0xabc" }, { type: "pay_started" }, { type: "pay_sent", expectedUsd: 5 }, { type: "credit_seen", spendablePico: "5000000000000" });

test("a purchase walks choose, keyed, paying, waiting, funded, buying, minted, discarded", () => {
  let s = initialState();
  assert.equal(s.phase, "choose");
  s = reduce(s, { type: "key_created", method: "usdg", keyHash: "0xabc" });
  assert.deepEqual([s.phase, s.method, s.keyHash, s.sent], ["keyed", "usdg", "0xabc", false]);
  s = reduce(s, { type: "pay_started" });
  assert.equal(s.phase, "paying");
  s = reduce(s, { type: "pay_sent", expectedUsd: 5 });
  assert.deepEqual([s.phase, s.sent, s.expectedUsd], ["waiting", true, 5]);
  s = reduce(s, { type: "credit_seen", spendablePico: "5000000000000" });
  assert.deepEqual([s.phase, s.spendablePico], ["funded", "5000000000000"]);
  s = reduce(s, { type: "buy_started" });
  assert.equal(s.phase, "buying");
  s = step(s, { type: "batch_done", count: 32, costPico: "64000000000" }, { type: "batch_done", count: 3, costPico: "6000000000" });
  assert.deepEqual([s.mintedCount, s.mintedPico], [35, "70000000000"]);
  s = reduce(s, { type: "buy_finished", remainingPico: "1000000000" });
  assert.deepEqual([s.phase, s.remainingPico, s.saved], ["minted", "1000000000", null]);
  s = reduce(s, { type: "tokens_saved", where: "browser" });
  assert.equal(s.saved, "browser");
  s = reduce(s, { type: "key_discarded", result: { memory: true, stored: true, remote: true } });
  assert.deepEqual([s.phase, s.discarded], ["discarded", { memory: true, stored: true, remote: true }]);
  s = reduce(s, { type: "reset" });
  assert.deepEqual(s, initialState());
});

test("reduce never changes the state it is given", () => {
  const before = funded();
  const frozen = Object.freeze({ ...before });
  const next = reduce(frozen, { type: "buy_started" });
  assert.notEqual(next, frozen);
  assert.equal(frozen.phase, "funded");
  assert.deepEqual(before, funded());
});

test("every event is refused outside the phases it belongs to", () => {
  const legalFrom = {
    key_created: ["choose"],
    restored: ["choose"],
    pay_started: ["keyed"],
    pay_failed: ["paying"],
    pay_sent: ["keyed", "paying"],
    credit_seen: ["keyed", "waiting", "funded"],
    buy_started: ["funded"],
    batch_done: ["buying"],
    buy_paused: ["buying"],
    buy_finished: ["buying"],
    tokens_saved: ["minted"],
    reset: ["discarded"],
  };
  // A state in each phase, built by the legal path to it.
  const at = {
    choose: initialState(),
    keyed: step(initialState(), { type: "key_created", method: "usdg" }),
    paying: step(initialState(), { type: "key_created", method: "usdg" }, { type: "pay_started" }),
    waiting: step(initialState(), { type: "key_created", method: "usdg" }, { type: "pay_sent", expectedUsd: 1 }),
    funded: funded(),
    buying: step(funded(), { type: "buy_started" }, { type: "batch_done", count: 1, costPico: "1" }),
    minted: step(funded(), { type: "buy_started" }, { type: "batch_done", count: 1, costPico: "1" }, { type: "buy_finished", remainingPico: "0" }),
    discarded: step(initialState(), { type: "key_created", method: "usdg" }, { type: "key_discarded" }),
  };
  assert.deepEqual(Object.keys(at), PHASES);
  const payloads = { key_created: { method: "usdg" }, restored: { phase: "keyed", method: "usdg" }, credit_seen: { spendablePico: "5" }, batch_done: { count: 1, costPico: "1" }, buy_finished: { remainingPico: "0" }, tokens_saved: { where: "file" } };
  for (const [type, phases] of Object.entries(legalFrom)) {
    for (const phase of PHASES) {
      const event = { type, ...payloads[type] };
      if (phases.includes(phase)) assert.doesNotThrow(() => reduce(at[phase], event), `${type} from ${phase}`);
      else assert.throws(() => reduce(at[phase], event), IllegalTransition, `${type} from ${phase}`);
    }
  }
  assert.throws(() => reduce(initialState(), { type: "nonsense" }), IllegalTransition);
});

test("nothing can be bought before a credit is seen, and a credit must be positive", () => {
  const keyed = step(initialState(), { type: "key_created", method: "usdg" });
  assert.throws(() => reduce(keyed, { type: "buy_started" }), IllegalTransition);
  assert.throws(() => reduce(keyed, { type: "credit_seen", spendablePico: "0" }), IllegalTransition);
  assert.throws(() => reduce(keyed, { type: "credit_seen", spendablePico: "-5" }), IllegalTransition);
  const waiting = reduce(keyed, { type: "pay_sent", expectedUsd: 1 });
  assert.throws(() => reduce(waiting, { type: "buy_started" }), IllegalTransition);
  assert.equal(reduce(waiting, { type: "credit_seen", spendablePico: "1" }).phase, "funded");
});

test("a failed payment returns to keyed with the reason, and the key is still there to try again", () => {
  const paying = step(initialState(), { type: "key_created", method: "usdg", keyHash: "0xabc" }, { type: "pay_started" });
  const back = reduce(paying, { type: "pay_failed", error: "You declined it in your wallet." });
  assert.deepEqual([back.phase, back.keyHash, back.error, back.sent], ["keyed", "0xabc", "You declined it in your wallet.", false]);
  assert.equal(reduce(back, { type: "pay_started" }).error, null);
});

test("a purchase that stops early goes back to funded with what is left, and can be resumed", () => {
  const buying = step(funded(), { type: "buy_started" }, { type: "batch_done", count: 32, costPico: "64000000000" });
  const paused = reduce(buying, { type: "buy_paused", error: "Daily purchase cap reached.", remainingPico: "4936000000000" });
  assert.deepEqual([paused.phase, paused.spendablePico, paused.error, paused.mintedCount], ["funded", "4936000000000", "Daily purchase cap reached.", 32]);
  const again = reduce(paused, { type: "buy_started" });
  assert.equal(again.error, null);
  assert.equal(again.mintedCount, 32);
});

test("minting nothing is not a finished purchase", () => {
  assert.throws(() => step(funded(), { type: "buy_started" }, { type: "buy_finished", remainingPico: "5" }), IllegalTransition);
});

test("failed records the reason and keeps the phase; the next step clears it", () => {
  const s = reduce(funded(), { type: "failed", error: "The API could not be reached." });
  assert.deepEqual([s.phase, s.error], ["funded", "The API could not be reached."]);
  assert.equal(reduce(s, { type: "buy_started" }).error, null);
  assert.equal(reduce(s, { type: "clear_error" }).error, null);
  assert.throws(() => reduce(step(initialState(), { type: "key_created", method: "usdg" }, { type: "key_discarded" }), { type: "failed", error: "x" }), IllegalTransition);
});

test("the key can be discarded only when that cannot lose money or tokens", () => {
  const keyed = step(initialState(), { type: "key_created", method: "usdg" });
  // nothing paid: always fine
  assert.equal(reduce(keyed, { type: "key_discarded" }).phase, "discarded");
  // money sent or on the key: refused unless the person explicitly gives it up
  for (const s of [step(keyed, { type: "pay_started" }), step(keyed, { type: "pay_sent", expectedUsd: 1 }), funded()]) {
    assert.throws(() => reduce(s, { type: "key_discarded" }), IllegalTransition, s.phase);
    assert.equal(reduce(s, { type: "key_discarded", forfeit: true }).phase, "discarded");
  }
  // a payment was sent, then the wallet step failed and returned to keyed: still refused
  const sentThenKeyed = { ...keyed, sent: true };
  assert.throws(() => reduce(sentThenKeyed, { type: "key_discarded" }), IllegalTransition);
  // while buying: never
  const buying = step(funded(), { type: "buy_started" });
  assert.throws(() => reduce(buying, { type: "key_discarded" }), IllegalTransition);
  assert.throws(() => reduce(buying, { type: "key_discarded", forfeit: true }), IllegalTransition);
  // minted: only once the tokens are safe (in the browser or in a downloaded file)
  const minted = step(buying, { type: "batch_done", count: 1, costPico: "1" }, { type: "buy_finished", remainingPico: "0" });
  assert.throws(() => reduce(minted, { type: "key_discarded" }), IllegalTransition);
  assert.throws(() => reduce(minted, { type: "key_discarded", forfeit: true }), IllegalTransition);
  assert.equal(reduce(reduce(minted, { type: "tokens_saved", where: "file" }), { type: "key_discarded" }).phase, "discarded");
  assert.equal(reduce(reduce(minted, { type: "tokens_saved", where: "browser" }), { type: "key_discarded" }).phase, "discarded");
  // and once discarded there is nothing left to discard
  assert.throws(() => reduce(reduce(keyed, { type: "key_discarded" }), { type: "key_discarded" }), IllegalTransition);
});

test("restoring a tab picks up in keyed, waiting or funded, and only from a fresh page", () => {
  const r = reduce(initialState(), { type: "restored", phase: "funded", method: "anyr", spendablePico: "600000000000", sent: true, mintedCount: 4, mintedPico: "8000000000" });
  assert.deepEqual([r.phase, r.method, r.sent, r.spendablePico, r.mintedCount], ["funded", "anyr", true, "600000000000", 4]);
  assert.throws(() => reduce(initialState(), { type: "restored", phase: "buying", method: "usdg" }), IllegalTransition);
  assert.throws(() => reduce(r, { type: "restored", phase: "keyed", method: "usdg" }), IllegalTransition);
  assert.equal(reduce(initialState(), { type: "restored", phase: "waiting", method: "usdg" }).sent, true);
});

// ---- the purchase plan -----------------------------------------------------------------------------------------

const smallest = usdToPico("0.002");

test("issuingKeys takes one issuing key per size, the one that lasts longest, smallest first", () => {
  const dir = { keys: [key(10000, "0.02", { redeem_until: "2026-10-13T00:00:00.000Z" }), key(10000, "0.02", { token_key_id: "b".repeat(64), epoch: 6, redeem_until: "2026-10-20T00:00:00.000Z" }), key(1000, "0.002"), key(100000, "0.2", { status: "upcoming" })] };
  const sizes = issuingKeys(dir);
  assert.deepEqual(sizes.map((s) => s.key.denomination), [1000, 10000]);
  assert.equal(sizes[1].key.token_key_id, "b".repeat(64));
  assert.deepEqual(issuingKeys({ keys: [key(1000, "abc"), key(10000, "0")] }), []);
  assert.deepEqual(issuingKeys(null), []);
});

test("a balanced plan spends the budget across the sizes and leaves less than one small token", () => {
  // Uncapped: half the budget in small tokens, 30% in medium, 20% in large.
  const plan = planPurchase({ budgetPico: usdToPico("5"), directory: directory(), maxTokens: 5000 });
  assert.equal(plan.costPico + plan.leftoverPico, usdToPico("5"));
  assert.ok(plan.leftoverPico < smallest);
  assert.deepEqual(plan.lines.map((l) => [l.key.denomination, l.count]), [[100000, 5], [10000, 75], [1000, 1250]]); // $1.00 + $1.50 + $2.50
  assert.equal(plan.tokenCount, 1330);
  // With the default cap the smallest tokens are merged into medium ones until the count fits.
  const capped = planPurchase({ budgetPico: usdToPico("5"), directory: directory() });
  assert.deepEqual(capped.lines.map((l) => [l.key.denomination, l.count]), [[100000, 5], [10000, 157], [1000, 430]]);
  assert.equal(capped.tokenCount, 592);
  assert.equal(capped.costPico, usdToPico("5"));
});

test("the plan never asks for more tokens than the cap, and never more per request than the router allows", () => {
  const plan = planPurchase({ budgetPico: usdToPico("5"), directory: directory(), maxTokens: 600, maxBatch: 32 });
  assert.ok(plan.tokenCount <= 600, String(plan.tokenCount));
  assert.equal(plan.costPico + plan.leftoverPico, usdToPico("5"));
  assert.ok(plan.leftoverPico < smallest);
  assert.ok(plan.batches.every((b) => b.count >= 1 && b.count <= 32));
  assert.equal(plan.batches.reduce((n, b) => n + b.count, 0), plan.tokenCount);
  assert.equal(plan.requests, plan.batches.length);
});

test("money is conserved for any budget and any mix, and the leftover is below the smallest token", () => {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  for (const mix of ["balanced", "small", "medium", "large"]) {
    for (let i = 0; i < 40; i++) {
      const budget = BigInt(next() % 90_000_000) * 1_000_000n + BigInt(next() % 1000); // up to $90 with odd picos
      const plan = planPurchase({ budgetPico: budget, directory: directory(), mix });
      assert.equal(plan.costPico + plan.leftoverPico, budget, `${mix} ${budget}`);
      assert.ok(plan.leftoverPico >= 0n);
      assert.ok(plan.leftoverPico < smallest, `${mix} ${budget} leaves ${plan.leftoverPico}`);
      assert.ok(plan.tokenCount <= 600);
      const lineCost = plan.lines.reduce((n, l) => n + BigInt(l.count) * l.valuePico, 0n);
      assert.equal(lineCost, plan.costPico);
    }
  }
});

test("one size first: small, medium and large put the budget in that size, then fill the rest", () => {
  const dir = directory();
  const small = planPurchase({ budgetPico: usdToPico("1"), directory: dir, mix: "small" });
  assert.deepEqual(small.lines.map((l) => [l.key.denomination, l.count]), [[1000, 500]]);
  const medium = planPurchase({ budgetPico: usdToPico("1"), directory: dir, mix: "medium" });
  assert.deepEqual(medium.lines.map((l) => [l.key.denomination, l.count]), [[10000, 50]]);
  const large = planPurchase({ budgetPico: usdToPico("0.5"), directory: dir, mix: "large" });
  assert.deepEqual(large.lines.map((l) => [l.key.denomination, l.count]), [[100000, 2], [10000, 5]]); // $0.40 + $0.10
});

test("a budget below the smallest token buys nothing and says so", () => {
  const plan = planPurchase({ budgetPico: usdToPico("0.0019"), directory: directory() });
  assert.deepEqual([plan.batches.length, plan.tokenCount, plan.costPico, plan.leftoverPico], [0, 0, 0n, usdToPico("0.0019")]);
  assert.equal(planPurchase({ budgetPico: 0n, directory: directory() }).batches.length, 0);
  assert.equal(planPurchase({ budgetPico: usdToPico("5"), directory: { keys: [] } }).batches.length, 0);
});

test("a router with one size, or two, still gets a whole plan", () => {
  const one = planPurchase({ budgetPico: usdToPico("1"), directory: { keys: [key(10000, "0.02")] } });
  assert.deepEqual(one.lines.map((l) => [l.key.denomination, l.count]), [[10000, 50]]);
  const two = planPurchase({ budgetPico: usdToPico("1"), directory: { keys: [key(1000, "0.002"), key(100000, "0.2")] } });
  assert.equal(two.costPico + two.leftoverPico, usdToPico("1"));
  assert.ok(two.leftoverPico < smallest);
});

test("dollar amounts from the API become exact micro-dollars, rounded down", () => {
  assert.equal(usdNumberToPico(5), 5_000_000_000_000n);
  assert.equal(usdNumberToPico(0.6), 600_000_000_000n);
  assert.equal(usdNumberToPico(0.1 + 0.2), 300_000_000_000n);
  assert.equal(usdNumberToPico(4.9999999), 4_999_999_000_000n);
  for (const bad of [0, -1, NaN, null, undefined, "x"]) assert.equal(usdNumberToPico(bad), 0n);
});

// ---- what the page says ----------------------------------------------------------------------------------------

const IMPOSTOR = "0x57eb1e4514e6c97baa1732e67b6845ec51943e6b";
const copy = () => [...LINKABLE, ...NOT_LINKABLE, ...NOT_HIDDEN].flat().join("\n") + "\n" + usdgTerms() + "\n" + anyrTerms({ symbol: "ANYR", haircut_bps: 300, twap_minutes: 30, max_usd_per_deposit: 500 });

test("the page's claims say what is linkable, what is not, and what tokens do not hide", () => {
  const text = copy();
  assert.match(LINKABLE.flat().join(" "), /public transaction on the chain, and the router reads it from there/);
  assert.doesNotMatch(copy(), /never learns which wallet/i);
  assert.match(LINKABLE.flat().join(" "), /this wallet bought N tokens/);
  assert.match(NOT_LINKABLE.flat().join(" "), /Which prompts the tokens paid for/);
  // The router reads requests in memory on every lane; the page must never say otherwise.
  assert.match(NOT_HIDDEN.flat().join(" "), /reads a request in memory to route it/);
  assert.doesNotMatch(text, /cannot read|can’t read|can't read|never sees your prompt|no logs|untraceable|anonymous|guarantee/i);
  assert.match(text, /Nothing is refunded/);
});

test("$ANYR is described as a payment method, with its haircut and averaging rules and no market language", () => {
  const t = anyrTerms({ symbol: "ANYR", haircut_bps: 300, twap_minutes: 30, max_usd_per_deposit: 500 });
  assert.match(t, /payment method/);
  assert.match(t, /lower of the spot price and the 30-minute time-weighted average/);
  assert.match(t, /3% haircut/);
  assert.match(t, /\$500 per deposit/);
  assert.equal(anyrTerms(null), null);
  assert.doesNotMatch(copy(), /\b(invest\w*|returns?|yield|APY|profit|gains?|upside|moon|price target|appreciat\w*|hodl|stake|staking)\b/i);
});

test("public wording avoids the words the site does not use, and the wrong contract never appears", () => {
  const text = copy();
  assert.doesNotMatch(text, /\b(demo|test|tested|testing|mock|mocked|simulated|placeholder)\b/i);
  assert.ok(!text.toLowerCase().includes(IMPOSTOR));
});
