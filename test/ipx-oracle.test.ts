import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createHmac } from "node:crypto";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { startRouter, type Harness, ADMIN } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { generations } from "../src/db/schema.ts";
import { usdToPico } from "../src/lib/money.ts";
import { ipxFeedAbi, ipxSnapshot, type IpxSnapshot } from "../src/services/ipx.ts";
import {
  IpxOracle,
  KvOracleStore,
  MemoryOracleStore,
  cleanReason,
  clampMove,
  decide,
  oracleView,
  runIpxOracle,
  setOracleHalt,
  type OracleAlert,
  type OraclePublisher,
  type OracleStore,
  type PublishResult,
} from "../src/services/ipx-oracle.ts";
import { OracleSigner, assess, publicKeyOf, signUpdate, updateDigest, verifySignature, verifyUpdate, type OracleAlgorithm, type SignedUpdate } from "../src/services/ipx-oracle-sign.ts";
import { HttpsPushPublisher, OnchainFeedPublisher, parsePushConfig, renderTemplate, usdgBaseUnits } from "../src/services/ipx-oracle-push.ts";

const KEY = ("0x" + "11".repeat(32)) as Hex;
const OTHER_KEY = ("0x" + "22".repeat(32)) as Hex;
const HOUR = 3_600_000;
const T = Date.UTC(2026, 8, 29, 12, 0, 0); // end of the sample hour [11:00, 12:00)
const NOW = T + 25 * 60_000;
const CLASS = { id: "IPX-OPEN-70B", models: ["meta-llama/llama-3.3-70b-instruct"] };
const ROOT = keccak256(toHex("root"));

function snapshot(o: Partial<IpxSnapshot> = {}): IpxSnapshot {
  return {
    class: CLASS.id,
    window: { from: new Date(T - HOUR), to: new Date(T) },
    asOf: new Date(T),
    priceE8: 42_300_000n, // 0.423 USDG per 1M tokens
    price24hE8: 42_000_000n,
    tokens24h: 10_000_000n,
    volumeUsdg24h: 60_000_000_000n, // 60,000 USDG
    fills24h: 10,
    accounts24h: 3,
    thin: false,
    thinThresholdUsdg: 50_000_000_000n, // 50,000 USDG
    receiptRoot: ROOT,
    receiptsInRoot: 4,
    history: [],
    ...o,
  };
}

/** Run with the router's JSON log lines swallowed. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const [e, l] = [console.error, console.log];
  console.error = console.log = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.log = l;
  }
}

class Sink implements OraclePublisher {
  calls: SignedUpdate[] = [];
  constructor(readonly name: string, private behave: (u: SignedUpdate) => Promise<PublishResult> | PublishResult = () => ({ status: "sent" })) {}
  async publish(u: SignedUpdate) {
    this.calls.push(u);
    return this.behave(u);
  }
}

function make(o: { snap?: () => IpxSnapshot; halted?: boolean; sinks?: OraclePublisher[]; maxMoveBps?: number; store?: OracleStore; algorithm?: OracleAlgorithm; timeoutMs?: number } = {}) {
  const clock = { t: NOW };
  const alerts: OracleAlert[] = [];
  const store = o.store ?? new MemoryOracleStore();
  const signer = new OracleSigner(o.algorithm ?? "ed25519", KEY);
  let current = o.snap ?? (() => snapshot());
  const oracle = new IpxOracle({
    classes: [CLASS],
    rules: { staleAfterS: 1800, maxMoveBps: o.maxMoveBps ?? 1000 },
    configHalted: o.halted ?? false,
    store,
    signer,
    snapshot: async () => current(),
    publishers: o.sinks ?? [],
    alert: async (a) => void alerts.push(a),
    now: () => clock.t,
    publishTimeoutMs: o.timeoutMs,
  });
  return { oracle, store, signer, alerts, clock, setSnap: (f: () => IpxSnapshot) => (current = f) };
}

describe("IPX oracle: signing", () => {
  for (const algorithm of ["ed25519", "secp256k1-eip191"] as const) {
    test(`${algorithm}: a signed update verifies, and tampering or a wrong pinned key does not`, async () => {
      const { oracle, store, signer } = make({ algorithm });
      await oracle.tick();
      const u = (await store.latest(CLASS.id))!;
      expect(u.signature.algorithm).toBe(algorithm);
      expect(u.signature.signer).toBe(signer.publicKey);
      expect(u.signature.digest).toBe(updateDigest(u));
      const nowS = NOW / 1000;
      const good = await verifyUpdate(u, { publicKey: signer.publicKey, nowS });
      expect(good).toMatchObject({ ok: true, signature_valid: true, digest_valid: true, pinned: true, problems: [] });
      expect(good.assessment.consumer_action).toBe("normal");

      const tampered = { ...u, price: "9.999", price_e8: "999900000" };
      const bad = await verifyUpdate(tampered, { publicKey: signer.publicKey, nowS });
      expect(bad.ok).toBe(false);
      expect(bad.digest_valid).toBe(false);

      // Re-signed by somebody else: the digest and signature are consistent, the signer is not the pinned one.
      const other = new OracleSigner(algorithm, OTHER_KEY);
      const { signature: _s, ...body } = u;
      const forged = await signUpdate(other, body);
      expect((await verifyUpdate(forged, { nowS })).ok).toBe(true); // self-consistent without a pin
      const pinnedCheck = await verifyUpdate(forged, { publicKey: signer.publicKey, nowS });
      expect(pinnedCheck.ok).toBe(false);
      expect(pinnedCheck.problems).toContain("signer is not the pinned public key");
    });
  }

  test("verifySignature rejects malformed input instead of throwing", async () => {
    const digest = keccak256(toHex("x"));
    expect(await verifySignature("ed25519", "0x12", digest, "0x00")).toBe(false);
    expect(await verifySignature("secp256k1-eip191", "nope", digest, "0x00")).toBe(false);
    expect(await verifySignature("rsa" as never, "0x", digest, "0x")).toBe(false);
    expect((await verifyUpdate({ hello: "world" })).ok).toBe(false);
    expect((await verifyUpdate(null)).ok).toBe(false);
  });

  test("the key never appears in JSON, inspect output, string conversion or logs", async () => {
    const logs: string[] = [];
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    const [e, l] = [console.error, console.log];
    console.error = capture;
    console.log = capture;
    try {
      const signer = new OracleSigner("ed25519", KEY);
      const sinks = [new Sink("boom", () => { throw new Error("upstream said no"); })];
      const { oracle } = make({ sinks });
      await oracle.tick();
      const seen = [JSON.stringify(signer), inspect(signer, { depth: 6, showHidden: true }), String(signer), `${signer.publicKey}`, ...logs].join("\n");
      expect(seen).not.toContain(KEY.slice(2));
      expect(seen).not.toContain(KEY);
      expect(signer.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(publicKeyOf("secp256k1-eip191", KEY)).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(() => new OracleSigner("ed25519", "0x1234" as Hex)).toThrow(/32 bytes/);
    } finally {
      console.error = e;
      console.log = l;
    }
  });
});

describe("IPX oracle: the payload", () => {
  test("a normal update carries price, time, class, receipt root, THIN status and the reduce-only flag", async () => {
    const { oracle, store } = make();
    const [r] = await oracle.tick();
    expect(r).toMatchObject({ class: CLASS.id, status: "published", sequence: 1, clamped: false });
    const u = (await store.latest(CLASS.id))!;
    expect(u).toMatchObject({
      v: 1,
      kind: "ipx-index-price",
      index: "ANYR-IPX/IPX-OPEN-70B",
      class: "IPX-OPEN-70B",
      status: "ok",
      price: "0.423",
      price_e8: "42300000",
      decimals: 8,
      unit: "USDG per 1,000,000 tokens",
      timestamp: NOW / 1000,
      valid_until: NOW / 1000 + 1800,
      stale_after_s: 1800,
      sequence: 1,
      thin: false,
      volume_usdg_24h: "60000",
      thin_threshold_usdg: "50000",
      reduce_only: false,
      reduce_only_reasons: [],
      halted: false,
      halt_reason: null,
    });
    expect(u.source).toEqual({ window_from: (T - HOUR) / 1000, window_to: T / 1000, receipt_root: ROOT, receipts_in_root: 4, raw_price_e8: "42300000" });
    expect(u.clamp).toEqual({ applied: false, max_move_bps: 1000, previous_price_e8: null });
  });

  test("the sequence increases with every signed record and the timestamp follows the clock", async () => {
    const { oracle, store, clock } = make();
    await oracle.tick();
    clock.t += 300_000;
    await oracle.tick();
    const u = (await store.latest(CLASS.id))!;
    expect(u.sequence).toBe(2);
    expect(u.timestamp).toBe((NOW + 300_000) / 1000);
  });
});

describe("IPX oracle rule: THIN means reduce-only", () => {
  test("a THIN class is marked thin with a reduce_only recommendation", async () => {
    const { oracle, store, sinks } = (() => {
      const sink = new Sink("s");
      return { ...make({ snap: () => snapshot({ thin: true, volumeUsdg24h: 10_000_000_000n }), sinks: [sink] }), sinks: sink };
    })();
    await oracle.tick();
    const u = (await store.latest(CLASS.id))!;
    expect(u).toMatchObject({ status: "thin", thin: true, reduce_only: true, reduce_only_reasons: ["thin"], volume_usdg_24h: "10000" });
    expect(u.price).toBe("0.423"); // still a price, with the restriction attached
    expect(sinks.calls).toHaveLength(1);
    expect(assess(u, NOW / 1000)).toMatchObject({ status: "thin", consumer_action: "reduce_only" });
  });

  test("a class at or above the threshold is not reduce-only", () => {
    const d = decide({ cls: "X", snapshot: snapshot({ thin: false }), halt: null, prior: { lastPriceE8: null, sequence: 0 }, rules: { staleAfterS: 1800, maxMoveBps: 1000 }, nowS: 1 });
    expect(d.kind === "update" && d.body).toMatchObject({ status: "ok", reduce_only: false, reduce_only_reasons: [] });
  });
});

describe("IPX oracle rule: stale-price guard", () => {
  test("an update is valid until valid_until and a consumer must halt after it", async () => {
    const { oracle, store, signer } = make();
    await oracle.tick();
    const u = (await store.latest(CLASS.id))!;
    const at = (s: number) => verifyUpdate(u, { publicKey: signer.publicKey, nowS: u.timestamp + s });
    expect((await at(1800)).assessment).toMatchObject({ status: "ok", consumer_action: "normal", stale: false });
    const late = await at(1801);
    expect(late.assessment).toMatchObject({ status: "stale", consumer_action: "halt", stale: true });
    expect(late.problems).toContain("past valid_until: the update is stale");
    expect(late.ok).toBe(true); // the signature is fine; the consumer's action is what changes
    const future = await verifyUpdate(u, { publicKey: signer.publicKey, nowS: u.timestamp - 3600 });
    expect(future.problems).toContain("timestamp is in the future");
    expect(future.assessment).toMatchObject({ status: "invalid_time", consumer_action: "halt" }); // dated ahead of the reader's clock
    expect((await verifyUpdate(u, { nowS: u.timestamp + 500, maxAgeS: 300 })).problems).toContain("older than the caller's maximum age");
  });

  test("with no price for the latest hour nothing is signed, so the last update runs out and the view says stale", async () => {
    const { oracle, store, clock, alerts, setSnap } = make();
    await oracle.tick();
    const first = (await store.latest(CLASS.id))!;
    setSnap(() => snapshot({ priceE8: null, receiptRoot: null, receiptsInRoot: 0, thin: true }));
    clock.t += 3_600_000; // the next hour: the cached sample no longer applies
    const [r] = await oracle.tick();
    expect(r.status).toBe("no_price");
    expect((await store.latest(CLASS.id))!.sequence).toBe(first.sequence); // untouched
    expect(alerts.map((a) => [a.check, a.state])).toEqual([["ipx_oracle_no_price_ipx-open-70b", "failing"]]);
    const cfg = loadConfig({ IPX_ENABLED: "true", IPX_ORACLE_ENABLED: "true", IPX_ORACLE_PRIVATE_KEY: KEY });
    const view = await oracleView({ cfg, db: null as never }, CLASS, clock.t / 1000, store);
    expect(view).toMatchObject({ status: "stale", consumer_action: "halt", stale: true, halted: false });
    // The price returns: the alert recovers.
    setSnap(() => snapshot());
    await oracle.tick();
    expect(alerts.at(-1)).toMatchObject({ check: "ipx_oracle_no_price_ipx-open-70b", state: "recovered" });
  });

  test("no update at all is unavailable and a consumer must halt", () => {
    expect(assess(null, 1)).toMatchObject({ status: "unavailable", consumer_action: "halt" });
  });
});

describe("IPX oracle rule: maximum move clamp", () => {
  test("clampMove limits the move in both directions and leaves small moves alone", () => {
    expect(clampMove(50_000_000n, 40_000_000n, 1000)).toEqual({ priceE8: 44_000_000n, clamped: true });
    expect(clampMove(20_000_000n, 40_000_000n, 1000)).toEqual({ priceE8: 36_000_000n, clamped: true });
    expect(clampMove(43_000_000n, 40_000_000n, 1000)).toEqual({ priceE8: 43_000_000n, clamped: false });
    expect(clampMove(44_000_000n, 40_000_000n, 1000)).toEqual({ priceE8: 44_000_000n, clamped: false }); // exactly at the limit
    expect(clampMove(1n, null, 1000)).toEqual({ priceE8: 1n, clamped: false }); // nothing to clamp against
    expect(clampMove(9n, 1n, 1000)).toEqual({ priceE8: 2n, clamped: true }); // a tiny price can still move
    expect(clampMove(1n, 5n, 10_000)).toEqual({ priceE8: 1n, clamped: false }); // 100% permits any fall
    expect(clampMove(500n, 100n, 10_000)).toEqual({ priceE8: 200n, clamped: true });
  });

  test("a large jump is published clamped, marked, alerted once, and converges over later updates", async () => {
    const sink = new Sink("s");
    const { oracle, store, alerts, clock, setSnap } = make({ sinks: [sink], snap: () => snapshot({ priceE8: 40_000_000n }) });
    await oracle.tick();
    expect((await store.latest(CLASS.id))!.price_e8).toBe("40000000");
    setSnap(() => snapshot({ priceE8: 80_000_000n }));
    clock.t += 3_600_000;
    await oracle.tick();
    let u = (await store.latest(CLASS.id))!;
    expect(u.price_e8).toBe("44000000");
    expect(u.clamp).toEqual({ applied: true, max_move_bps: 1000, previous_price_e8: "40000000" });
    expect(u.source!.raw_price_e8).toBe("80000000");
    expect(alerts.map((a) => [a.check, a.state])).toEqual([["ipx_oracle_clamped_ipx-open-70b", "failing"]]);
    // Still clamped on the next tick: no second alert. Each step moves at most 10%.
    clock.t += 300_000;
    await oracle.tick();
    u = (await store.latest(CLASS.id))!;
    expect(u.price_e8).toBe("48400000");
    expect(alerts).toHaveLength(1);
    // Converged: a sample within the limit is published as is and the alert recovers.
    setSnap(() => snapshot({ priceE8: 50_000_000n }));
    clock.t += 3_600_000; // a new hour, a new sample
    await oracle.tick();
    u = (await store.latest(CLASS.id))!;
    expect(u.price_e8).toBe("50000000");
    expect(u.clamp!.applied).toBe(false);
    expect(alerts.map((a) => a.state)).toEqual(["failing", "recovered"]);
  });

  test("the on-chain feed never receives a clamped price", async () => {
    const posted: unknown[] = [];
    const chain = { readFeed: async () => ({ updatedAt: 0 }), postIpxFeed: async (_f: Hex, u: unknown) => (posted.push(u), { hash: ("0x" + "ab".repeat(32)) as Hex }) };
    const onchain = new OnchainFeedPublisher({ feeds: { [CLASS.id]: ("0x" + "0f".repeat(20)) as Hex }, submit: true, chain });
    const { oracle, clock, setSnap, store } = make({ sinks: [onchain], snap: () => snapshot({ priceE8: 40_000_000n }) });
    await oracle.tick();
    expect(posted).toHaveLength(1);
    setSnap(() => snapshot({ priceE8: 80_000_000n }));
    clock.t += 3_600_000;
    await oracle.tick();
    expect(posted).toHaveLength(1); // clamped: skipped
    expect((await store.state(CLASS.id)).publishers.onchain).toMatchObject({ status: "skipped" });
  });
});

describe("IPX oracle rule: kill switch", () => {
  test("a halt in the configuration signs no price and calls no sink", async () => {
    const sink = new Sink("s");
    const { oracle, store, alerts, signer } = make({ halted: true, sinks: [sink] });
    const [r] = await oracle.tick();
    expect(r.status).toBe("halted");
    expect(sink.calls).toHaveLength(0);
    const u = (await store.latest(CLASS.id))!;
    expect(u).toMatchObject({ status: "halted", halted: true, halt_reason: "config", price: null, price_e8: null, reduce_only: true, thin: null, source: null, clamp: null });
    expect((await verifyUpdate(u, { publicKey: signer.publicKey, nowS: NOW / 1000 })).ok).toBe(true); // a halt is signed too
    expect(assess(u, NOW / 1000)).toMatchObject({ status: "halted", consumer_action: "halt" });
    expect(alerts.map((a) => [a.check, a.state])).toEqual([["ipx_oracle_halted_ipx-open-70b", "failing"]]);
  });

  test("the runtime switch freezes publishing at once, keeps the last price out of use, and resuming restores it", async () => {
    const sink = new Sink("s");
    const { oracle, store, clock, alerts } = make({ sinks: [sink] });
    await oracle.tick();
    expect(sink.calls).toHaveLength(1);
    const h = await setOracleHalt(store, { halted: true, reason: "  manual\nreview\t\u0007 " }, clock.t / 1000);
    expect(h).toMatchObject({ halted: true, reason: "manual review" });
    clock.t += 60_000;
    await oracle.tick();
    await oracle.tick(); // a second tick does not sign another halted record for the same reason
    expect(sink.calls).toHaveLength(1);
    const halted = (await store.latest(CLASS.id))!;
    expect(halted).toMatchObject({ status: "halted", halt_reason: "manual review", sequence: 2 });
    clock.t += 60_000;
    await setOracleHalt(store, { halted: false }, clock.t / 1000);
    await oracle.tick();
    expect(sink.calls).toHaveLength(2);
    expect((await store.latest(CLASS.id))).toMatchObject({ status: "ok", halted: false, sequence: 3 });
    expect(alerts.map((a) => a.state)).toEqual(["failing", "recovered"]);
  });

  test("the view reports halted from the flag alone, before the worker signs anything", async () => {
    const { oracle, store, clock } = make();
    await oracle.tick();
    const cfg = loadConfig({ IPX_ENABLED: "true", IPX_ORACLE_ENABLED: "true", IPX_ORACLE_PRIVATE_KEY: KEY });
    const ok = await oracleView({ cfg, db: null as never }, CLASS, clock.t / 1000, store);
    expect(ok).toMatchObject({ status: "ok", consumer_action: "normal", halted: false, halt: null });
    await setOracleHalt(store, { halted: true, reason: "x" }, clock.t / 1000);
    const halted = await oracleView({ cfg, db: null as never }, CLASS, clock.t / 1000, store);
    expect(halted).toMatchObject({ status: "halted", consumer_action: "halt", halted: true, halt: { reason: "x" } });
    await setOracleHalt(store, { halted: false }, clock.t / 1000);
    expect(await oracleView({ cfg, db: null as never }, CLASS, clock.t / 1000, store)).toMatchObject({ status: "ok" });
  });

  test("a halt needs no snapshot: it works when the database read fails", async () => {
    const { oracle } = make({ halted: true, snap: () => { throw new Error("db down"); } });
    expect((await oracle.tick())[0].status).toBe("halted");
  });

  test("cleanReason keeps short printable text", () => {
    expect(cleanReason("a\u0000b\n\nc")).toBe("a b c");
    expect(cleanReason("x".repeat(500))).toHaveLength(200);
    expect(cleanReason(undefined)).toBe("");
  });
});

describe("IPX oracle: sinks are isolated", () => {
  test("a failing or slow sink does not block another, the stored record or the tick, and it raises an alert", async () => {
    const good = new Sink("good");
    const bad = new Sink("bad", () => { throw new Error("nope"); });
    const slow = new Sink("slow", () => new Promise(() => {}));
    const soft = new Sink("soft", () => ({ status: "failed", detail: "HTTP 500" }));
    const { oracle, store, alerts } = make({ sinks: [good, bad, slow, soft], timeoutMs: 20 });
    const [r] = await quiet(() => oracle.tick());
    expect(r.publishers).toEqual({ good: "sent", bad: "failed", slow: "failed", soft: "failed" });
    expect((await store.latest(CLASS.id))!.sequence).toBe(1);
    expect((await store.state(CLASS.id)).publishers.bad.detail).toBe("publisher error"); // no error text is kept
    expect(alerts.map((a) => a.check)).toEqual(["ipx_oracle_publish_failed_ipx-open-70b"]);
  });

  test("a class whose snapshot fails is reported, and the others still publish", async () => {
    const store = new MemoryOracleStore();
    const oracle = new IpxOracle({
      classes: [{ id: "IPX-A", models: ["a/b"] }, { id: "IPX-B", models: ["c/d"] }],
      rules: { staleAfterS: 1800, maxMoveBps: 1000 },
      configHalted: false,
      store,
      signer: new OracleSigner("ed25519", KEY),
      snapshot: async (cls) => { if (cls.id === "IPX-A") throw new Error("db down"); return snapshot({ class: cls.id }); },
      publishers: [],
      alert: async () => {},
      now: () => NOW,
    });
    await quiet(() => expect(oracle.tick()).rejects.toThrow(/1 of 2 classes failed/));
    expect(await store.latest("IPX-A")).toBeNull();
    expect((await store.latest("IPX-B"))!.status).toBe("ok");
  });
});

describe("IPX oracle sink: on-chain feed", () => {
  const feed = ("0x" + "0f".repeat(20)) as Hex;
  const update = async () => {
    const { oracle, store } = make();
    await oracle.tick();
    return (await store.latest(CLASS.id))!;
  };

  test("by default it only builds calldata for IPXFeed.update", async () => {
    const chain = { readFeed: async () => { throw new Error("must not be called"); }, postIpxFeed: async () => { throw new Error("must not be called"); } };
    const r = await new OnchainFeedPublisher({ feeds: { [CLASS.id]: feed }, submit: false, chain }).publish(await update());
    expect(r.status).toBe("calldata");
    const call = decodeFunctionData({ abi: ipxFeedAbi, data: r.detail as Hex });
    expect(call.functionName).toBe("update");
    expect(call.args).toEqual([42_300_000n, ROOT, 60_000_000_000n]);
  });

  test("with submit on it posts once per hourly sample and skips a sample the feed already has", async () => {
    const posted: { feed: Hex; u: { answer: bigint; receiptRoot: Hex; volumeUsdg: bigint } }[] = [];
    let updatedAt = 0;
    const chain = { readFeed: async () => ({ updatedAt }), postIpxFeed: async (f: Hex, u: { answer: bigint; receiptRoot: Hex; volumeUsdg: bigint }) => (posted.push({ feed: f, u }), { hash: ("0x" + "cd".repeat(32)) as Hex }) };
    const p = new OnchainFeedPublisher({ feeds: { [CLASS.id]: feed }, submit: true, chain });
    const u = await update();
    expect(await p.publish(u)).toEqual({ status: "submitted", detail: "0x" + "cd".repeat(32) });
    expect(posted).toEqual([{ feed, u: { answer: 42_300_000n, receiptRoot: ROOT, volumeUsdg: 60_000_000_000n } }]);
    updatedAt = T / 1000; // the feed now has this hour
    expect(await p.publish(u)).toMatchObject({ status: "skipped" });
    expect(posted).toHaveLength(1);
  });

  test("it skips a class without a feed, a sample without a receipt root, and halted records", async () => {
    const chain = { readFeed: async () => ({ updatedAt: 0 }), postIpxFeed: async () => ({ hash: "0x" as Hex }) };
    const u = await update();
    expect((await new OnchainFeedPublisher({ feeds: {}, submit: true, chain }).publish(u)).status).toBe("skipped");
    const noRoot = { ...u, source: { ...u.source!, receipt_root: null } };
    expect((await new OnchainFeedPublisher({ feeds: { [CLASS.id]: feed }, submit: true, chain }).publish(noRoot)).detail).toMatch(/receipt root/);
    const { oracle, store } = make({ halted: true });
    await oracle.tick();
    expect((await new OnchainFeedPublisher({ feeds: { [CLASS.id]: feed }, submit: true, chain }).publish((await store.latest(CLASS.id))!)).detail).toBe("halted record");
  });

  test("volumes convert to USDG base units exactly", () => {
    expect(usdgBaseUnits("60000")).toBe(60_000_000_000n);
    expect(usdgBaseUnits("1250.5")).toBe(1_250_500_000n);
    expect(usdgBaseUnits("0.000001")).toBe(1n);
  });
});

describe("IPX oracle sink: generic HTTPS push", () => {
  const env = { IPX_ORACLE_PUSH_API_KEY: "api-key-value", IPX_ORACLE_PUSH_SECRET: "shared-secret", IPX_ORACLE_PUSH_ED_KEY: OTHER_KEY };
  const baseConfig = {
    url: "https://oracle.example.invalid/v1/prices/{{market}}",
    headers: { "x-api-key": "{{env:IPX_ORACLE_PUSH_API_KEY}}", "x-timestamp": "{{timestamp_ms}}" },
    markets: { [CLASS.id]: "PERP_TEST_INDEX" },
    body: { symbol: "{{market}}", price: "{{price}}", price_number: "{{price_number}}", ts: "{{timestamp_ms}}", thin: "{{thin}}", reduce_only: "{{reduce_only}}", note: "seq {{sequence}} of {{class}}", root: "{{receipt_root}}" },
  };
  const cfg = (o: Record<string, unknown> = {}) => parsePushConfig(JSON.stringify({ ...baseConfig, ...o }), { production: true });
  const oracleSigner = new OracleSigner("ed25519", KEY);
  const signed = async (o: Partial<IpxSnapshot> = {}) => {
    const { oracle, store } = make({ snap: () => snapshot(o) });
    await oracle.tick();
    return (await store.latest(CLASS.id))!;
  };
  const capture = (status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status }))) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  test("renders URL, headers and a typed JSON body from the configured templates", async () => {
    const { calls, fetchImpl } = capture();
    const p = new HttpsPushPublisher({ config: cfg(), oracleSigner, env, production: true, fetch: fetchImpl });
    const u = await signed({ thin: true });
    expect(await p.publish(u)).toEqual({ status: "sent", detail: "HTTP 200" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oracle.example.invalid/v1/prices/PERP_TEST_INDEX");
    const init = calls[0].init;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ "x-api-key": "api-key-value", "x-timestamp": String(NOW), "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ symbol: "PERP_TEST_INDEX", price: "0.423", price_number: 0.423, ts: NOW, thin: true, reduce_only: true, note: "seq 1 of IPX-OPEN-70B", root: ROOT });
  });

  test("signs the request with hmac and the receiver can recompute it", async () => {
    const { calls, fetchImpl } = capture();
    const config = cfg({ signing: { algorithm: "hmac-sha256", key_env: "IPX_ORACLE_PUSH_SECRET", message: "{{timestamp_ms}}{{method}}{{path}}{{body}}", encoding: "base64", header: "x-signature" } });
    await new HttpsPushPublisher({ config, oracleSigner, env, production: true, fetch: fetchImpl }).publish(await signed());
    const { init, url } = calls[0];
    const message = `${NOW}POST${new URL(url).pathname}${init.body}`;
    expect((init.headers as Record<string, string>)["x-signature"]).toBe(createHmac("sha256", "shared-secret").update(message).digest("base64"));
  });

  test("signs with the oracle key by default and with a named key when given, in either encoding", async () => {
    for (const [signing, signer] of [
      [{ algorithm: "ed25519", message: "{{timestamp_ms}}|{{body}}", encoding: "0xhex", header: "x-sig" }, oracleSigner],
      [{ algorithm: "ed25519", key_env: "IPX_ORACLE_PUSH_ED_KEY", message: "{{timestamp_ms}}|{{body}}", encoding: "hex", header: "x-sig" }, new OracleSigner("ed25519", OTHER_KEY)],
    ] as const) {
      const { calls, fetchImpl } = capture();
      await new HttpsPushPublisher({ config: cfg({ signing }), oracleSigner, env, production: true, fetch: fetchImpl }).publish(await signed());
      const sig = (calls[0].init.headers as Record<string, string>)["x-sig"];
      const hex = (sig.startsWith("0x") ? sig : "0x" + sig) as Hex;
      const messageHex = toHex(`${NOW}|${calls[0].init.body}`);
      expect(await verifySignature("ed25519", signer.publicKey, messageHex, hex)).toBe(true);
      expect(await verifySignature("ed25519", oracleSigner.publicKey === signer.publicKey ? new OracleSigner("ed25519", OTHER_KEY).publicKey : oracleSigner.publicKey, messageHex, hex)).toBe(false);
    }
  });

  test("the signature can be placed by template instead of a fixed header", async () => {
    const { calls, fetchImpl } = capture();
    const config = cfg({ headers: { authorization: "Sig {{request_signature}}" }, signing: { algorithm: "secp256k1-eip191", key_env: "IPX_ORACLE_PUSH_ED_KEY", message: "{{body}}" } });
    await new HttpsPushPublisher({ config, oracleSigner, env, production: true, fetch: fetchImpl }).publish(await signed());
    const auth = (calls[0].init.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Sig [0-9a-f]{130}$/);
    expect(await verifySignature("secp256k1-eip191", publicKeyOf("secp256k1-eip191", OTHER_KEY), toHex(calls[0].init.body as string), ("0x" + auth.slice(4)) as Hex)).toBe(true);
  });

  test("a non-success status or a network error is a failed result without response text or URLs", async () => {
    const u = await signed();
    const deny = capture(401);
    expect(await new HttpsPushPublisher({ config: cfg(), oracleSigner, env, production: true, fetch: deny.fetchImpl }).publish(u)).toEqual({ status: "failed", detail: "HTTP 401" });
    const custom = capture(202);
    expect((await new HttpsPushPublisher({ config: cfg({ success_status: [200] }), oracleSigner, env, production: true, fetch: custom.fetchImpl }).publish(u)).status).toBe("failed");
    const boom = (async () => { throw new TypeError("connect ECONNREFUSED oracle.example.invalid"); }) as unknown as typeof fetch;
    const r = await new HttpsPushPublisher({ config: cfg(), oracleSigner, env, production: true, fetch: boom }).publish(u);
    expect(r).toEqual({ status: "failed", detail: "request failed (TypeError)" });
    expect(JSON.stringify(r)).not.toMatch(/example|ECONN/);
  });

  test("a halted record is never pushed", async () => {
    const { calls, fetchImpl } = capture();
    const { oracle, store } = make({ halted: true });
    await oracle.tick();
    const r = await new HttpsPushPublisher({ config: cfg(), oracleSigner, env, production: true, fetch: fetchImpl }).publish((await store.latest(CLASS.id))!);
    expect(r.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  test("the configuration is checked: https only, known variables, IPX_ORACLE_PUSH_* environment only, keys present", async () => {
    expect(() => parsePushConfig(JSON.stringify({ ...baseConfig, url: "http://oracle.example.invalid/x" }), { production: true })).toThrow(/https/);
    expect(() => parsePushConfig(JSON.stringify({ ...baseConfig, url: "http://oracle.example.invalid/x" }), { production: false })).not.toThrow();
    expect(() => parsePushConfig("{nope", { production: true })).toThrow(/not valid JSON/);
    expect(() => parsePushConfig(JSON.stringify({ ...baseConfig, method: "DELETE" }), { production: true })).toThrow(/method/);
    expect(() => parsePushConfig(JSON.stringify({ ...baseConfig, signing: { algorithm: "hmac-sha256", key_env: "DATABASE_URL", message: "m" } }), { production: true })).toThrow(/key_env/);
    const u = await signed();
    const build = (c: ReturnType<typeof cfg>, e = env) => new HttpsPushPublisher({ config: c, oracleSigner, env: e, production: true }).build(u);
    await expect(build(cfg({ body: { x: "{{nonsense}}" } }))).rejects.toThrow(/Unknown template variable nonsense/);
    await expect(build(cfg({ body: { x: "{{env:DATABASE_URL}}" } }))).rejects.toThrow(/IPX_ORACLE_PUSH_/);
    await expect(build(cfg(), {} as never)).rejects.toThrow(/IPX_ORACLE_PUSH_API_KEY is not set/);
    await expect(new HttpsPushPublisher({ config: cfg({ headers: { "x-a": "{{env:IPX_ORACLE_PUSH_SECRET}}" } }), oracleSigner, env: { ...env, IPX_ORACLE_PUSH_SECRET: "a\r\nb" }, production: true }).build(u)).rejects.toThrow(/line break/);
    expect(() => new HttpsPushPublisher({ config: cfg({ signing: { algorithm: "hmac-sha256", message: "m" } }), oracleSigner, env, production: true })).toThrow(/key_env/);
    expect(() => new HttpsPushPublisher({ config: cfg({ signing: { algorithm: "secp256k1-eip191", message: "m" } }), oracleSigner, env, production: true })).toThrow(/differs from the oracle key/);
    expect(() => new HttpsPushPublisher({ config: cfg({ signing: { algorithm: "ed25519", key_env: "IPX_ORACLE_PUSH_API_KEY", message: "m" } }), oracleSigner, env, production: true })).toThrow(/32-byte key/);
  });

  test("the example configuration in deploy/ipx-perp parses and renders", async () => {
    const config = parsePushConfig(join(import.meta.dir, "../deploy/ipx-perp/push-config.example.json"), { production: true });
    const p = new HttpsPushPublisher({ config, oracleSigner, env, production: true });
    const { url, init } = await p.build(await signed());
    expect(url).toBe("https://oracle.example.invalid/v1/index-price");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("api-key-value");
    expect(headers["x-signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(init.body)).toMatchObject({ symbol: "REPLACE_WITH_MARKET_SYMBOL", price: "0.423", status: "ok", thin: false, reduce_only: false, sequence: 1 });
  });

  test("templates: a whole-string placeholder keeps its type, embedded ones are text, and a file path works", () => {
    const vars = { n: 5, b: false, s: "x", z: null, o: { a: 1 } };
    expect(renderTemplate({ a: "{{n}}", b: "{{b}}", c: "v{{n}}-{{s}}", d: "{{z}}", e: "[{{z}}]", f: ["{{s}}"], g: "{{o}}", h: 7 }, vars, {})).toEqual({ a: 5, b: false, c: "v5-x", d: null, e: "[]", f: ["x"], g: { a: 1 }, h: 7 });
    const dir = mkdtempSync(join(tmpdir(), "ipx-push-"));
    try {
      writeFileSync(join(dir, "push.json"), JSON.stringify(baseConfig));
      expect(parsePushConfig(join(dir, "push.json"), { production: true }).markets[CLASS.id]).toBe("PERP_TEST_INDEX");
      expect(() => parsePushConfig(join(dir, "missing.json"), { production: true })).toThrow(/cannot read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("IPX oracle: configuration", () => {
  const on = { IPX_ENABLED: "true", IPX_ORACLE_ENABLED: "true", IPX_ORACLE_PRIVATE_KEY: KEY };

  test("everything is off by default and the defaults are conservative", () => {
    const c = loadConfig({ IPX_ORACLE_PRIVATE_KEY: "" }).ipx.oracle;
    expect(c).toMatchObject({ enabled: false, algorithm: "ed25519", intervalS: 300, staleAfterS: 1800, maxMoveBps: 1000, halted: false, publishers: [], feeds: {}, onchainSubmit: false });
    expect(c.classes).toEqual(["IPX-OPEN-70B"]);
    expect(loadConfig(on).ipx.oracle.enabled).toBe(true);
  });

  test("invalid combinations are refused", () => {
    expect(() => loadConfig({ ...on, IPX_ENABLED: "false" })).toThrow(/requires IPX_ENABLED/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PRIVATE_KEY: "" })).toThrow(/IPX_ORACLE_PRIVATE_KEY/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PRIVATE_KEY: "0x1234" })).toThrow(/32-byte private key/);
    expect(loadConfig({ ...on, IPX_ORACLE_PRIVATE_KEY: "", RUNTIME_ROLE: "api", IPX_ORACLE_PUBLIC_KEY: publicKeyOf("ed25519", KEY) }).ipx.oracle.publicKey).toBe(publicKeyOf("ed25519", KEY));
    expect(() => loadConfig({ ...on, IPX_ORACLE_INTERVAL_S: "5" })).toThrow(/INTERVAL/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_INTERVAL_S: "300", IPX_ORACLE_STALE_AFTER_S: "500" })).toThrow(/twice/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_MAX_MOVE_BPS: "0" })).toThrow(/MAX_MOVE_BPS/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_MAX_MOVE_BPS: "10001" })).toThrow(/MAX_MOVE_BPS/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PUBLISHERS: "smoke" })).toThrow(/not a publisher/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PUBLISHERS: "https,https", IPX_ORACLE_PUSH_CONFIG: "{}" })).toThrow(/twice/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PUBLISHERS: "https" })).toThrow(/IPX_ORACLE_PUSH_CONFIG/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PUBLISHERS: "onchain" })).toThrow(/IPX_ORACLE_FEEDS/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_ONCHAIN_SUBMIT: "true", IPX_ORACLE_PUBLISHERS: "onchain", IPX_ORACLE_FEEDS: JSON.stringify({ "IPX-OPEN-70B": "0x" + "1".repeat(40) }) })).toThrow(/IPX_KEEPER_PRIVATE_KEY/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_CLASSES: "IPX-NOPE" })).toThrow(/not one of IPX_CLASSES/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_FEEDS: "nope" })).toThrow(/IPX_ORACLE_FEEDS/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_FEEDS: JSON.stringify({ "IPX-OTHER": "0x" + "1".repeat(40) }) })).toThrow(/not an oracle class/);
    expect(() => loadConfig({ ...on, IPX_ORACLE_PUBLIC_KEY: "0x12" })).toThrow(/PUBLIC_KEY/);
    const ok = loadConfig({ ...on, IPX_KEEPER_PRIVATE_KEY: OTHER_KEY, IPX_ORACLE_ONCHAIN_SUBMIT: "true", IPX_ORACLE_PUBLISHERS: "onchain", IPX_ORACLE_FEEDS: JSON.stringify({ "ipx-open-70b": "0x" + "1".repeat(40) }) });
    expect(ok.ipx.oracle.feeds).toEqual({ "IPX-OPEN-70B": "0x" + "1".repeat(40) });
    expect(ok.chain.ipxKeeperKey).toBe(OTHER_KEY);
  });

  test("production keeps the oracle and keeper keys off the public API and the keeper key isolated", () => {
    const address = "0x" + "1".repeat(40);
    const base = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address, PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64), IPX_ENABLED: "true", IPX_ORACLE_ENABLED: "true" };
    expect(loadConfig({ ...base, IPX_ORACLE_PUBLIC_KEY: publicKeyOf("ed25519", KEY) }).ipx.oracle.enabled).toBe(true);
    expect(() => loadConfig({ ...base, IPX_ORACLE_PRIVATE_KEY: KEY })).toThrow(/Public API must not receive the IPX oracle/);
    expect(() => loadConfig({ ...base, IPX_KEEPER_PRIVATE_KEY: OTHER_KEY })).toThrow(/Public API must not receive the IPX oracle/);
    const worker = { ...base, RUNTIME_ROLE: "worker", WORKER_JOBS: "ipx-oracle", IPX_ORACLE_PRIVATE_KEY: KEY };
    expect(loadConfig(worker).workerJobs).toEqual(["ipx-oracle"]);
    expect(() => loadConfig({ ...worker, IPX_ORACLE_PRIVATE_KEY: "" })).toThrow();
    expect(() => loadConfig({ ...worker, IPX_KEEPER_PRIVATE_KEY: OTHER_KEY, SETTLEMENT_PRIVATE_KEY: "0x" + "1".repeat(64), WORKER_JOBS: "ipx-oracle,settlement" })).toThrow(/isolated/);
    expect(loadConfig({ ...worker, IPX_KEEPER_PRIVATE_KEY: OTHER_KEY, IPX_ORACLE_PUBLISHERS: "onchain", IPX_ORACLE_FEEDS: JSON.stringify({ "IPX-OPEN-70B": address }), IPX_ORACLE_ONCHAIN_SUBMIT: "true" }).chain.ipxKeeperKey).toBe(OTHER_KEY);
  });
});

describe("IPX oracle: the endpoint and the job, on a router", () => {
  let h: Harness;
  const signer = new OracleSigner("ed25519", KEY);
  const cls = () => h.ctx.cfg.ipx.classes[0];
  let counter = 0;
  async function fill(at: number, usd: string) {
    const n = ++counter;
    await h.ctx.db.insert(generations).values({ id: `gen-oracle-${n}`, ts: new Date(at), accountId: "acct-oracle", modelId: "meta-llama/llama-3.3-70b-instruct", providerId: "alpha", tokensIn: 600_000, tokensOut: 400_000, cost: usdToPico(usd), mode: "prepaid", isByok: false, cancelled: false, attestationHash: "0xattest", receiptLeaf: keccak256(toHex(`oracle-leaf-${n}`)) });
  }
  const get = async () => (await h.request("/api/v1/ipx/ipx-open-70b/oracle")).json().then((j) => j.data);
  const put = (json: unknown, headers: Record<string, string> = {}) => h.request("/api/v1/ipx/oracle/halt", { method: "PUT", json, headers });

  beforeAll(async () => {
    setSystemTime(new Date(NOW));
    h = await startRouter({ env: { IPX_ENABLED: "true", IPX_THIN_USDG: "1", IPX_ORACLE_ENABLED: "true", IPX_ORACLE_PRIVATE_KEY: KEY } });
  });
  afterAll(async () => {
    setSystemTime();
    await h.close();
  });

  test("before any update: unavailable, halt, and the public key to pin", async () => {
    const res = await h.request("/api/v1/ipx/IPX-OPEN-70B/oracle");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const d = (await res.json()).data;
    expect(d).toMatchObject({ class: "IPX-OPEN-70B", index: "ANYR-IPX/IPX-OPEN-70B", status: "unavailable", consumer_action: "halt", update: null, halted: false, verification: { algorithm: "ed25519", public_key: signer.publicKey } });
    expect(d.verification.digest).toMatch(/SHA-256/);
    expect(d.verification.signature).toMatch(/Ed25519/);
  });

  test("the job signs the latest hour and the endpoint serves it with everything needed to verify it", async () => {
    await fill(T - 50 * 60_000, "0.5");
    await fill(T - 30 * 60_000, "0.5");
    await fill(T - 10 * 60_000, "0.5");
    const oracle = new IpxOracle({
      classes: [cls()],
      rules: { staleAfterS: 1800, maxMoveBps: 1000 },
      configHalted: false,
      store: new KvOracleStore(h.ctx.db),
      signer,
      snapshot: (c, now) => ipxSnapshot(h.ctx, c, now),
      publishers: [],
      alert: async () => {},
    });
    expect((await oracle.tick())[0]).toMatchObject({ status: "published", sequence: 1 });
    const d = await get();
    expect(d).toMatchObject({ status: "ok", consumer_action: "normal", stale: false, halted: false, valid_until: NOW / 1000 + 1800 });
    expect(d.update).toMatchObject({ status: "ok", price: "0.5", price_e8: "50000000", volume_usdg_24h: "1.5", thin: false, reduce_only: false, sequence: 1 });
    expect(d.update.source.receipt_root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.update.source.receipts_in_root).toBe(3);
    const v = await verifyUpdate(d.update, { publicKey: d.verification.public_key });
    expect(v).toMatchObject({ ok: true, pinned: true, problems: [] });
    expect(JSON.stringify(d)).not.toMatch(/acct-oracle|gen-oracle|key_hash|account_id/);
    expect(JSON.stringify(d)).not.toContain(KEY.slice(2));
  });

  test("the kill switch: operator token required, effective on the next read, lifted the same way", async () => {
    expect((await put({ halted: true })).status).toBe(401);
    expect((await put({ halted: true }, { authorization: "Bearer wrong-token-wrong-token-wrong" })).status).toBe(401);
    expect((await put({ halted: "yes" }, { "x-admin-token": ADMIN })).status).toBe(400);
    const r = await put({ halted: true, reason: "checking the sample" }, { authorization: `Bearer ${ADMIN}` });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({ halted: true, reason: "checking the sample", config_halted: false });
    const halted = await get();
    expect(halted).toMatchObject({ status: "halted", consumer_action: "halt", halted: true, halt: { reason: "checking the sample" } });

    // The worker then replaces the latest record with a signed halted status and signs no price.
    const store = new KvOracleStore(h.ctx.db);
    const oracle = new IpxOracle({ classes: [cls()], rules: { staleAfterS: 1800, maxMoveBps: 1000 }, configHalted: false, store, signer, snapshot: (c, now) => ipxSnapshot(h.ctx, c, now), publishers: [], alert: async () => {} });
    await oracle.tick();
    const after = await get();
    expect(after.update).toMatchObject({ status: "halted", price: null, halt_reason: "checking the sample" });
    expect((await verifyUpdate(after.update, { publicKey: signer.publicKey })).ok).toBe(true);

    expect((await put({ halted: false }, { "x-admin-token": ADMIN })).status).toBe(200);
    expect(await get()).toMatchObject({ status: "unavailable", halted: false, consumer_action: "halt" }); // until the next tick
    await oracle.tick();
    expect(await get()).toMatchObject({ status: "ok", consumer_action: "normal", update: { sequence: 3 } });
  });

  test("an unknown class is a 404", async () => {
    const r = await h.request("/api/v1/ipx/IPX-NOPE/oracle");
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("unknown_ipx_class");
  });

  test("the registered job is the worker's entry point: it reports no price for an hour without fills", async () => {
    expect(h.ctx.jobs.status().map((j) => j.name)).toContain("ipx-oracle");
    setSystemTime(new Date(Date.UTC(2020, 0, 1, 5, 30, 0)));
    try {
      const out = (await runIpxOracle(h.ctx)) as { classes: { status: string }[] };
      expect(out.classes[0].status).toBe("no_price");
    } finally {
      setSystemTime(new Date(NOW));
    }
  });
});

describe("IPX oracle: off by default", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { IPX_ENABLED: "true" } });
  });
  afterAll(() => h.close());

  test("the routes answer 404, the job is not registered, and the job function does nothing", async () => {
    const r = await h.request("/api/v1/ipx/IPX-OPEN-70B/oracle");
    expect(r.status).toBe(404);
    expect((await r.json()).error.type).toBe("ipx_oracle_disabled");
    const halt = await h.request("/api/v1/ipx/oracle/halt", { method: "PUT", json: { halted: true }, headers: { "x-admin-token": ADMIN } });
    expect(halt.status).toBe(404);
    expect(h.ctx.jobs.status().map((j) => j.name)).not.toContain("ipx-oracle");
    expect(await runIpxOracle(h.ctx)).toEqual({ skipped: "ipx oracle not enabled" });
  });

  test("with IPX itself off the oracle route reports the index as disabled", async () => {
    const off = await startRouter({});
    try {
      expect((await (await off.request("/api/v1/ipx/IPX-OPEN-70B/oracle")).json()).error.type).toBe("ipx_disabled");
    } finally {
      await off.close();
    }
  });
});

describe("IPX oracle: the standalone verifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "ipx-verify-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(import.meta.dir, "../scripts/ipx-oracle-verify.ts");

  async function run(args: string[]) {
    const p = Bun.spawn(["bun", script, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  }
  const write = (name: string, v: unknown) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(v));
    return f;
  };

  test("exit codes: 0 usable, 2 must halt, 1 not verified", async () => {
    const nowMs = Date.now();
    const clock = { now: () => nowMs };
    const make2 = (o: { snap?: () => IpxSnapshot; halted?: boolean }) => {
      const store = new MemoryOracleStore();
      const oracle = new IpxOracle({ classes: [CLASS], rules: { staleAfterS: 1800, maxMoveBps: 1000 }, configHalted: o.halted ?? false, store, signer: new OracleSigner("ed25519", KEY), snapshot: async () => (o.snap ?? (() => snapshot()))(), publishers: [], alert: async () => {}, now: clock.now });
      return { oracle, store };
    };
    const pub = new OracleSigner("ed25519", KEY).publicKey;

    const ok = make2({});
    await ok.oracle.tick();
    const fine = await run(["--file", write("ok.json", { data: { update: await ok.store.latest(CLASS.id) } }), "--public-key", pub]);
    expect(fine.code).toBe(0);
    expect(fine.out).toContain("may use the price");
    expect(fine.out).toContain("(against the pinned key)");

    const thin = make2({ snap: () => snapshot({ thin: true }) });
    await thin.oracle.tick();
    const t = await run(["--file", write("thin.json", await thin.store.latest(CLASS.id)), "--public-key", pub, "--json"]);
    expect(t.code).toBe(0);
    expect(JSON.parse(t.out)).toMatchObject({ verified: true, consumer_action: "reduce_only", status: "thin" });

    const old = await ok.store.latest(CLASS.id);
    const stale = await run(["--file", write("stale.json", old), "--public-key", pub, "--max-age-s", "10"]);
    expect(stale.code).toBe(0); // fresh right now; max age is the caller's own bound
    const staleSigned = await signUpdate(new OracleSigner("ed25519", KEY), { ...(old as SignedUpdate), timestamp: Math.floor(nowMs / 1000) - 4000, valid_until: Math.floor(nowMs / 1000) - 2200 });
    const s = await run(["--file", write("stale2.json", staleSigned), "--public-key", pub]);
    expect(s.code).toBe(2);
    expect(s.out).toContain("must halt");

    const halted = make2({ halted: true });
    await halted.oracle.tick();
    expect((await run(["--file", write("halt.json", await halted.store.latest(CLASS.id)), "--public-key", pub])).code).toBe(2);
    // A signed price but the operator flag is up in the wrapper: halt.
    expect((await run(["--file", write("flag.json", { data: { update: old, halted: true, halt: { reason: "x" } } }), "--public-key", pub])).code).toBe(2);

    expect((await run(["--file", write("wrongkey.json", old), "--public-key", new OracleSigner("ed25519", OTHER_KEY).publicKey])).code).toBe(1);
    expect((await run(["--file", write("tamper.json", { ...(old as object), price: "1" }), "--public-key", pub])).code).toBe(1);
    const noPin = await run(["--file", write("ok.json", old)]);
    expect(noPin.code).toBe(1);
    expect(noPin.err).toContain("--public-key is required");
    expect((await run(["--file", write("ok.json", old), "--unpinned"])).code).toBe(0);
    expect((await run(["--file", write("junk.json", { hello: 1 }), "--public-key", pub])).code).toBe(1);
    expect((await run(["--help"])).out).toContain("usage:");
  });

  test("it reads a URL (localhost over http only) and refuses others", async () => {
    const { oracle, store } = (() => {
      const store = new MemoryOracleStore();
      return { store, oracle: new IpxOracle({ classes: [CLASS], rules: { staleAfterS: 1800, maxMoveBps: 1000 }, configHalted: false, store, signer: new OracleSigner("ed25519", KEY), snapshot: async () => snapshot(), publishers: [], alert: async () => {}, now: Date.now }) };
    })();
    await oracle.tick();
    const server = Bun.serve({ port: 0, fetch: async () => Response.json({ data: { update: await store.latest(CLASS.id) } }) });
    try {
      const r = await run(["--url", `http://localhost:${server.port}/api/v1/ipx/IPX-OPEN-70B/oracle`, "--public-key", new OracleSigner("ed25519", KEY).publicKey]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("signature   ok");
    } finally {
      server.stop(true);
    }
    expect((await run(["--url", "http://example.invalid/x", "--public-key", "0x" + "00".repeat(32)])).err).toContain("must be https");
  });
});
