import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { startRouter, type Harness } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { generations, providers } from "../src/db/schema.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { usdToPico } from "../src/lib/money.ts";
import { aggregate, capBuckets, decimalString, encodeFeedUpdate, feedUpdate, ipxFeedAbi, ipxSnapshot, snapshotJson, type Bucket } from "../src/services/ipx.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const HOUR = 3_600_000;
// A fixed "now" inside an hour; the last whole hour is [T - 1h, T) with T = 2026-09-29T12:00:00Z.
const T = Date.UTC(2026, 8, 29, 12, 0, 0);
const NOW = new Date(T + 25 * 60_000);

let counter = 0;
const leafOf = (n: number) => keccak256(toHex(`leaf-${n}`));

type Fill = { at: number; usd: string; tokensIn?: number; tokensOut?: number; model?: string; provider?: string; account?: string | null; mode?: string; attested?: boolean; cancelled?: boolean; byok?: boolean; leaf?: boolean };
async function fill(h: Harness, f: Fill) {
  const n = ++counter;
  await h.ctx.db.insert(generations).values({
    id: `gen-ipx-${n}`,
    ts: new Date(f.at),
    accountId: f.account === undefined ? "acct-1" : f.account,
    modelId: f.model ?? LLAMA,
    providerId: f.provider ?? "alpha",
    tokensIn: f.tokensIn ?? 600_000,
    tokensOut: f.tokensOut ?? 400_000,
    cost: usdToPico(f.usd),
    mode: f.mode ?? "prepaid",
    isByok: f.byok ?? false,
    cancelled: f.cancelled ?? false,
    attestationHash: f.attested === false ? null : "0xattest",
    receiptLeaf: f.leaf === false ? null : leafOf(n),
  });
  return leafOf(n);
}
const inHour = (mins: number) => T - HOUR + mins * 60_000;

describe("IPX: the arithmetic", () => {
  const b = (account: string, tokens: number, usd: string): Bucket => ({ account, tokens: BigInt(tokens), costPico: usdToPico(usd), fills: 1 });

  test("price is total charged over total tokens, per million, with 8 decimals", () => {
    // $1.50 over 4,000,000 tokens = $0.375 per 1M tokens.
    const a = aggregate([b("x", 1_000_000, "0.5"), b("y", 3_000_000, "1")]);
    expect(a.priceE8).toBe(37_500_000n);
    expect(decimalString(a.priceE8!, 8)).toBe("0.375");
    expect(a.volumeUsdg).toBe(1_500_000n); // 1.5 USDG in base units
    expect(a.tokens).toBe(4_000_000n);
    expect(a.accounts).toBe(2);
  });

  test("it is volume weighted, not a mean of per-fill prices", () => {
    // $0.10 per 1M on 1M tokens and $1.00 per 1M on 9M tokens -> $0.91 per 1M, not $0.55.
    const a = aggregate([b("x", 1_000_000, "0.1"), b("y", 9_000_000, "9")]);
    expect(decimalString(a.priceE8!, 8)).toBe("0.91");
  });

  test("rounds half up at the eighth decimal and refuses a price of zero", () => {
    const one = (costPico: bigint) => aggregate([{ account: "x", tokens: 1_000_000n, costPico, fills: 1 }]).priceE8;
    expect(one(1_000_000n)).toBe(100n); // 1e-6 USD over 1M tokens is 1e-6 USD per 1M = 100 in 1e8 units
    expect(one(5_000n)).toBe(1n); // 0.5 rounds up
    expect(one(4_999n)).toBeNull(); // 0.49999 rounds to zero, which is no price
    expect(aggregate([]).priceE8).toBeNull();
  });

  test("an account cap scales that account's tokens and cost together", () => {
    const buckets = [b("whale", 9_000_000, "9"), b("small", 1_000_000, "0.1")];
    expect(capBuckets(buckets, 10_000)).toBe(buckets);
    const capped = capBuckets(buckets, 2_500); // 25% of 10M = 2.5M tokens
    expect(capped[0].tokens).toBe(2_500_000n);
    expect(capped[0].costPico).toBe(usdToPico("2.5"));
    expect(capped[1]).toEqual(buckets[1]);
    // The whale's price is unchanged by the cap; only its weight shrinks.
    const price = aggregate(buckets, 2_500);
    expect(decimalString(price.priceE8!, 8)).toBe("0.74285714"); // (2.5 + 0.1) / 3.5M
    expect(price.volumeUsdg).toBe(2_600_000n);
    expect(price.fills).toBe(2);
  });

  test("the feed update carries the answer, the root and the 24h USDG volume", () => {
    const update = { answer: 37_500_000n, receiptRoot: leafOf(1), volumeUsdg: 1_500_000n };
    const call = decodeFunctionData({ abi: ipxFeedAbi, data: encodeFeedUpdate(update) });
    expect(call.functionName).toBe("update");
    expect(call.args).toEqual([37_500_000n, leafOf(1), 1_500_000n]);
    expect(feedUpdate({ priceE8: null, receiptRoot: leafOf(1), volumeUsdg24h: 1n } as never)).toBeNull();
    expect(feedUpdate({ priceE8: 5n, receiptRoot: null, volumeUsdg24h: 1n } as never)).toBeNull();
  });
});

describe("IPX: configuration", () => {
  test("it is off by default, with one default class", () => {
    const c = loadConfig({}).ipx;
    expect(c.enabled).toBe(false);
    expect(c.classes).toEqual([{ id: "IPX-OPEN-70B", models: [LLAMA] }]);
    expect(c.thinUsdg).toBe(50_000_000_000n);
    expect(c.maxAccountShareBps).toBe(10_000);
    expect(c.attestedOnly).toBe(true);
  });

  test("classes, threshold and cap are parsed and validated", () => {
    const c = loadConfig({ IPX_ENABLED: "true", IPX_CLASSES: JSON.stringify({ "ipx-moe-flash": ["A/B", "a/b", "C/D"], "IPX-OPEN-70B": [LLAMA] }), IPX_THIN_USDG: "1250.5", IPX_MAX_ACCOUNT_SHARE_BPS: "2500", IPX_ATTESTED_ONLY: "false" }).ipx;
    expect(c.enabled).toBe(true);
    expect(c.classes[0]).toEqual({ id: "IPX-MOE-FLASH", models: ["a/b", "c/d"] });
    expect(c.thinUsdg).toBe(1_250_500_000n);
    expect(c.maxAccountShareBps).toBe(2500);
    expect(c.attestedOnly).toBe(false);
    expect(() => loadConfig({ IPX_CLASSES: "nope" })).toThrow(/IPX_CLASSES/);
    expect(() => loadConfig({ IPX_CLASSES: "{}" })).toThrow(/IPX_CLASSES/);
    expect(() => loadConfig({ IPX_CLASSES: JSON.stringify({ "BAD CLASS": ["a/b"] }) })).toThrow(/valid class id/);
    expect(() => loadConfig({ IPX_CLASSES: JSON.stringify({ "IPX-A": [] }) })).toThrow(/IPX_CLASSES/);
    expect(() => loadConfig({ IPX_CLASSES: JSON.stringify({ "IPX-A": ["a/b"], "IPX-B": ["A/B"] }) })).toThrow(/both IPX-A and IPX-B/);
    expect(() => loadConfig({ IPX_MAX_ACCOUNT_SHARE_BPS: "0" })).toThrow(/IPX_MAX_ACCOUNT_SHARE_BPS/);
    expect(() => loadConfig({ IPX_MAX_ACCOUNT_SHARE_BPS: "10001" })).toThrow(/IPX_MAX_ACCOUNT_SHARE_BPS/);
    expect(() => loadConfig({ IPX_THIN_USDG: "12.3456789" })).toThrow();
  });
});

describe("IPX: snapshots from generations", () => {
  let h: Harness;
  const cls = () => h.ctx.cfg.ipx.classes[0];
  const snap = (now = NOW) => ipxSnapshot(h.ctx, cls(), now);

  beforeAll(async () => {
    h = await startRouter({ env: { IPX_ENABLED: "true", IPX_THIN_USDG: "1", ALLOW_DEV_ATTESTATION: "false" } });
    await h.ctx.db.insert(providers).values({ id: "devtee", name: "Dev TEE", baseUrl: "http://127.0.0.1:1", status: "live", teeKind: "dev" });
  });
  afterAll(() => h.close());

  test("an empty class has no price and is THIN", async () => {
    const s = await snap(new Date(Date.UTC(2020, 0, 1, 5, 0, 0)));
    expect(s.priceE8).toBeNull();
    expect(s.thin).toBe(true);
    expect(s.receiptRoot).toBeNull();
    expect(s.history).toHaveLength(24);
    expect(feedUpdate(s)).toBeNull();
    expect(snapshotJson(s, cls(), h.ctx.cfg).thin_reasons).toEqual(["volume_below_threshold", "no_fills_in_window"]);
  });

  test("price, volume, THIN and the receipt root come from the last whole hour's receipts", async () => {
    const l1 = await fill(h, { at: inHour(5), usd: "0.5", tokensIn: 600_000, tokensOut: 400_000, account: "a" });
    const l2 = await fill(h, { at: inHour(20), usd: "1", tokensIn: 2_000_000, tokensOut: 1_000_000, account: "b" });
    // Older fill inside the trailing day: counts toward 24h volume, not toward the hour's price.
    await fill(h, { at: T - 5 * HOUR, usd: "2", tokensIn: 1_000_000, tokensOut: 1_000_000, account: "c" });
    const s = await snap();
    expect(s.window.from.getTime()).toBe(T - HOUR);
    expect(s.window.to.getTime()).toBe(T);
    expect(decimalString(s.priceE8!, 8)).toBe("0.375");
    expect(s.volumeUsdg24h).toBe(3_500_000n);
    expect(s.tokens24h).toBe(6_000_000n);
    expect(s.fills24h).toBe(3);
    expect(s.accounts24h).toBe(3);
    expect(decimalString(s.price24hE8!, 8)).toBe("0.58333333");
    expect(s.thin).toBe(false); // 3.5 USDG >= the 1 USDG threshold in this test
    expect(s.receiptsInRoot).toBe(2);
    expect(s.receiptRoot).toBe(new MerkleTree([l1, l2]).root);
    const update = feedUpdate(s)!;
    expect(update).toEqual({ answer: 37_500_000n, receiptRoot: s.receiptRoot!, volumeUsdg: 3_500_000n });
    const point = s.history[s.history.length - 1];
    expect(point.hourStart.getTime()).toBe(T - HOUR);
    expect(point.fills).toBe(2);
    expect(s.history[s.history.length - 5].fills).toBe(1);
  });

  test("below the threshold the class is THIN", async () => {
    const s = await ipxSnapshot({ db: h.ctx.db, cfg: { ...h.ctx.cfg, ipx: { ...h.ctx.cfg.ipx, thinUsdg: 4_000_000n } } }, cls(), NOW);
    expect(s.thin).toBe(true);
    const j = snapshotJson(s, cls(), h.ctx.cfg);
    expect(j.thin).toBe(true);
    expect(j.thin_reasons).toEqual(["volume_below_threshold"]);
    expect(j.price).toBe("0.375");
    expect(j.volume_usdg_24h).toBe("3.5");
    expect(j.thin_threshold_usdg).toBe("4");
  });

  test("only real, paid, completed fills of the class with a receipt and an attestation count", async () => {
    const before = await snap();
    const at = inHour(30);
    await fill(h, { at, usd: "5", mode: "byok" });
    await fill(h, { at, usd: "5", byok: true });
    await fill(h, { at, usd: "5", mode: "cache", provider: "alpha" });
    await fill(h, { at, usd: "5", cancelled: true });
    await fill(h, { at, usd: "0" }); // free
    await fill(h, { at, usd: "5", tokensIn: 0, tokensOut: 0 });
    await fill(h, { at, usd: "5", model: "acme/other-model" });
    await fill(h, { at, usd: "5", attested: false });
    await fill(h, { at, usd: "5", leaf: false });
    await fill(h, { at, usd: "5", provider: "devtee" }); // dev attestation is not counted when dev attestation is refused
    await fill(h, { at: T, usd: "5" }); // the hour that has not finished
    await fill(h, { at: T - 24 * HOUR - 1, usd: "5" }); // before the trailing day
    const after = await snap();
    expect(after.priceE8).toBe(before.priceE8);
    expect(after.volumeUsdg24h).toBe(before.volumeUsdg24h);
    expect(after.fills24h).toBe(before.fills24h);
    expect(after.receiptRoot).toBe(before.receiptRoot);
  });

  test("model ids match case-insensitively", async () => {
    const before = await snap();
    await fill(h, { at: inHour(40), usd: "1", model: LLAMA.toUpperCase(), tokensIn: 500_000, tokensOut: 500_000 });
    const after = await snap();
    expect(after.fills24h).toBe(before.fills24h + 1);
    expect(after.volumeUsdg24h).toBe(before.volumeUsdg24h + 1_000_000n);
    expect(after.receiptRoot).not.toBe(before.receiptRoot);
  });

  test("the per-account cap limits one payer's weight in the hour and the day", async () => {
    const capped = { db: h.ctx.db, cfg: { ...h.ctx.cfg, ipx: { ...h.ctx.cfg.ipx, maxAccountShareBps: 2_500 } } };
    const uncapped = await snap();
    const s = await ipxSnapshot(capped, cls(), NOW);
    expect(s.volumeUsdg24h).toBeLessThan(uncapped.volumeUsdg24h);
    expect(s.fills24h).toBe(uncapped.fills24h); // fills are still all counted
    expect(snapshotJson(s, cls(), capped.cfg).method.account_cap_bps).toBe(2_500);
    expect(snapshotJson(uncapped, cls(), h.ctx.cfg).method.account_cap_bps).toBeNull();
  });

  test("with IPX_ATTESTED_ONLY off, fills without an attestation count", async () => {
    const open = { db: h.ctx.db, cfg: { ...h.ctx.cfg, ipx: { ...h.ctx.cfg.ipx, attestedOnly: false } } };
    const strict = await snap();
    const s = await ipxSnapshot(open, cls(), NOW);
    expect(s.fills24h).toBe(strict.fills24h + 2); // the unattested fill and the dev-TEE fill
    expect(snapshotJson(s, cls(), open.cfg).method.excludes).not.toContain("providers without an attestation hash in the receipt");
  });
});

describe("IPX: the HTTP route", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({ env: { IPX_ENABLED: "true", IPX_THIN_USDG: "1" } });
  });
  afterAll(() => h.close());

  test("GET /api/v1/ipx/:class serves the latest hour, publicly", async () => {
    const end = Math.floor(Date.now() / HOUR) * HOUR;
    const leaf = await fill(h, { at: end - 30 * 60_000, usd: "0.5", tokensIn: 600_000, tokensOut: 400_000 });
    const res = await h.request("/api/v1/ipx/ipx-open-70b");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const { data } = await res.json();
    expect(data.class).toBe("IPX-OPEN-70B");
    expect(data.description).toBe("ANYR-IPX/IPX-OPEN-70B");
    expect(data.decimals).toBe(8);
    expect(data.unit).toBe("USDG per 1,000,000 tokens");
    expect(data.price).toBe("0.5");
    expect(data.price_e8).toBe("50000000");
    expect(data.volume_usdg_24h).toBe("0.5");
    expect(data.thin).toBe(true); // 0.5 USDG < the 1 USDG threshold
    expect(data.thin_reasons).toEqual(["volume_below_threshold"]);
    expect(data.receipt_root).toBe(new MerkleTree([leaf]).root);
    expect(data.receipts_in_root).toBe(1);
    expect(data.feed_update).toEqual({ answer: "50000000", receipt_root: data.receipt_root, volume_usdg: "500000" });
    expect(data.history).toHaveLength(24);
    expect(data.method.models).toEqual([LLAMA]);
    // Aggregates only: no account, key or request data.
    expect(JSON.stringify(data)).not.toMatch(/acct-1|key_hash|account_id|gen-ipx/);
  });

  test("the class list, unknown classes and the disabled state", async () => {
    const list = await (await h.request("/api/v1/ipx")).json();
    expect(list.data).toEqual([{ class: "IPX-OPEN-70B", description: "ANYR-IPX/IPX-OPEN-70B", unit: "USDG per 1,000,000 tokens", decimals: 8, models: [LLAMA] }]);
    const unknown = await h.request("/api/v1/ipx/IPX-NOPE");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.type).toBe("unknown_ipx_class");

    const off = await startRouter();
    try {
      for (const path of ["/api/v1/ipx", "/api/v1/ipx/IPX-OPEN-70B"]) {
        const r = await off.request(path);
        expect(r.status).toBe(404);
        expect((await r.json()).error.type).toBe("ipx_disabled");
      }
    } finally {
      await off.close();
    }
  });
});
