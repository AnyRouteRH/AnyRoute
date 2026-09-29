import { and, eq, gte, inArray, isNotNull, lt, notInArray, sql, asc } from "drizzle-orm";
import { encodeFunctionData, type Hex } from "viem";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { generations, providers } from "../db/schema.ts";
import { MerkleTree } from "../receipts/merkle.ts";

// IPX, the inference price index: for one model class, the volume-weighted USDG price per 1,000,000
// tokens over real generations (what callers were charged, not list prices), one value per hour.
//
// A fill counts when it is a completed, paid, non-BYOK, non-cached generation of a model in the class
// with a signed receipt (and, with IPX_ATTESTED_ONLY, one served by a provider whose receipt carries an
// attestation hash). Tokens are prompt + completion tokens; the amount is the receipt's `cost`. USDG is
// treated as one US dollar. The price and the volume can therefore be rebuilt from the public receipts;
// the receipt root is a merkle root over the leaves of the hour's fills. The only step that needs
// operator data is the optional per-account cap (IPX_MAX_ACCOUNT_SHARE_BPS), which is off by default.
//
// Nothing here sends a transaction. `feedUpdate` builds the arguments for IPXFeed.update and
// `encodeFeedUpdate` the calldata; scripts/ipx-feed.ts submits only when run with --send.

export const IPX_DECIMALS = 8;
const HOUR_S = 3600;
const HOURS = 24;
const PICO_PER_USDG_UNIT = 1_000_000n;
/** Most receipts one root covers; a busier hour is reported without a root instead of a partial one. */
export const IPX_MAX_ROOT_LEAVES = 200_000;

export type IpxConfig = Config["ipx"];
export type IpxClassDef = IpxConfig["classes"][number];

/** All qualifying fills of one payer within one window, summed. `tokens` = prompt + completion. */
export type Bucket = { account: string; tokens: bigint; costPico: bigint; fills: number };
export type Aggregate = { tokens: bigint; costPico: bigint; fills: number; accounts: number; priceE8: bigint | null; volumeUsdg: bigint };

/** Cap each account at `maxShareBps` of the window's total tokens, scaling its cost by the same factor. */
export function capBuckets(buckets: Bucket[], maxShareBps: number): Bucket[] {
  if (maxShareBps >= 10_000) return buckets;
  const total = buckets.reduce((s, b) => s + b.tokens, 0n);
  const cap = (total * BigInt(maxShareBps)) / 10_000n;
  return buckets.map((b) => (b.tokens <= cap ? b : { ...b, tokens: cap, costPico: b.tokens === 0n ? 0n : (b.costPico * cap) / b.tokens }));
}

/** Volume-weighted price per 1M tokens (8 decimals, rounded half up) and USDG volume (6 decimals, floored). */
export function aggregate(buckets: Bucket[], maxShareBps = 10_000): Aggregate {
  const b = capBuckets(buckets, maxShareBps);
  const tokens = b.reduce((s, x) => s + x.tokens, 0n);
  const costPico = b.reduce((s, x) => s + x.costPico, 0n);
  // cost_usd / tokens * 1e6 * 1e8, with cost_usd = costPico / 1e12.
  const priceE8 = tokens > 0n ? (costPico * 200n + tokens) / (2n * tokens) : null;
  return {
    tokens,
    costPico,
    fills: buckets.reduce((s, x) => s + x.fills, 0),
    accounts: new Set(buckets.filter((x) => x.tokens > 0n).map((x) => x.account)).size,
    priceE8: priceE8 !== null && priceE8 > 0n ? priceE8 : null,
    volumeUsdg: costPico / PICO_PER_USDG_UNIT,
  };
}

/** Where a fill has to be: the class, the window and the counting rules above. */
function fillFilter(cfg: { ipx: IpxConfig; attestation: { allowDev: boolean } }, cls: IpxClassDef, from: Date, to: Date) {
  return and(
    gte(generations.ts, from),
    lt(generations.ts, to),
    inArray(sql`lower(${generations.modelId})`, cls.models),
    notInArray(generations.mode, ["byok", "cache"]),
    eq(generations.isByok, false),
    eq(generations.cancelled, false),
    sql`${generations.cost} > 0`,
    sql`${generations.tokensIn} + ${generations.tokensOut} > 0`,
    isNotNull(generations.receiptLeaf),
    ...(cfg.ipx.attestedOnly ? [isNotNull(generations.attestationHash), ...(cfg.attestation.allowDev ? [] : [sql`${providers.teeKind} IS DISTINCT FROM 'dev'`])] : []),
  );
}

type Loaded = { hourStart: number; bucket: Bucket };

async function loadBuckets(db: Db, cfg: Pick<Config, "ipx" | "attestation">, cls: IpxClassDef, from: Date, to: Date): Promise<Loaded[]> {
  const hourIdx = sql<string>`floor(extract(epoch from ${generations.ts}) / 3600)::bigint`;
  const account = sql<string>`coalesce(${generations.accountId}, ${generations.keyHash}, 'anonymous')`;
  const rows = await db
    .select({
      hour: sql<string>`${hourIdx}::text`,
      account,
      tokens: sql<string>`sum(${generations.tokensIn} + ${generations.tokensOut})::text`,
      cost: sql<string>`sum(${generations.cost})::text`,
      fills: sql<number>`count(*)::int`,
    })
    .from(generations)
    .innerJoin(providers, eq(providers.id, generations.providerId))
    .where(fillFilter(cfg, cls, from, to))
    .groupBy(hourIdx, account);
  return rows.map((r) => ({ hourStart: Number(r.hour) * HOUR_S, bucket: { account: r.account, tokens: BigInt(r.tokens), costPico: BigInt(r.cost), fills: Number(r.fills) } }));
}

export type HourPoint = { hourStart: Date; priceE8: bigint | null; tokens: bigint; volumeUsdg: bigint; fills: number };

export type IpxSnapshot = {
  class: string;
  /** The hour the price is for: [from, to). It is the last whole hour before `asOf`. */
  window: { from: Date; to: Date };
  asOf: Date;
  /** USDG per 1,000,000 tokens x 1e8 for the window, or null when the window had no qualifying fills. */
  priceE8: bigint | null;
  /** The same over the trailing 24 hours ending at `window.to`. */
  price24hE8: bigint | null;
  tokens24h: bigint;
  /** Trailing-24h volume in USDG base units; what THIN is judged on. */
  volumeUsdg24h: bigint;
  fills24h: number;
  accounts24h: number;
  thin: boolean;
  thinThresholdUsdg: bigint;
  /** Merkle root over the receipt leaves of the window's fills; null when there were none or too many. */
  receiptRoot: Hex | null;
  receiptsInRoot: number;
  history: HourPoint[];
};

/** The latest whole-hour snapshot of one class as of `now`. */
export async function ipxSnapshot(ctx: { db: Db; cfg: Pick<Config, "ipx" | "attestation"> }, cls: IpxClassDef, now = new Date()): Promise<IpxSnapshot> {
  const { db, cfg } = ctx;
  const endS = Math.floor(now.getTime() / 1000 / HOUR_S) * HOUR_S;
  const to = new Date(endS * 1000);
  const from = new Date((endS - HOURS * HOUR_S) * 1000);
  const loaded = await loadBuckets(db, cfg, cls, from, to);
  const share = cfg.ipx.maxAccountShareBps;

  const history: HourPoint[] = [];
  for (let i = HOURS; i >= 1; i--) {
    const hourStart = endS - i * HOUR_S;
    const a = aggregate(loaded.filter((l) => l.hourStart === hourStart).map((l) => l.bucket), share);
    history.push({ hourStart: new Date(hourStart * 1000), priceE8: a.priceE8, tokens: a.tokens, volumeUsdg: a.volumeUsdg, fills: a.fills });
  }

  const perAccount = new Map<string, Bucket>();
  for (const { bucket: b } of loaded) {
    const cur = perAccount.get(b.account);
    perAccount.set(b.account, cur ? { account: b.account, tokens: cur.tokens + b.tokens, costPico: cur.costPico + b.costPico, fills: cur.fills + b.fills } : b);
  }
  const day = aggregate([...perAccount.values()], share);
  const hour = aggregate(loaded.filter((l) => l.hourStart === endS - HOUR_S).map((l) => l.bucket), share);

  const windowFrom = new Date((endS - HOUR_S) * 1000);
  let receiptRoot: Hex | null = null;
  let receiptsInRoot = 0;
  if (hour.fills > 0 && hour.fills <= IPX_MAX_ROOT_LEAVES) {
    const leaves = await db
      .select({ leaf: generations.receiptLeaf })
      .from(generations)
      .innerJoin(providers, eq(providers.id, generations.providerId))
      .where(fillFilter(cfg, cls, windowFrom, to))
      .orderBy(asc(generations.ts), asc(generations.id))
      .limit(IPX_MAX_ROOT_LEAVES + 1);
    if (leaves.length > 0 && leaves.length <= IPX_MAX_ROOT_LEAVES) {
      receiptRoot = new MerkleTree(leaves.map((l) => l.leaf as Hex)).root;
      receiptsInRoot = leaves.length;
    }
  }

  return {
    class: cls.id,
    window: { from: windowFrom, to },
    asOf: to,
    priceE8: hour.priceE8,
    price24hE8: day.priceE8,
    tokens24h: day.tokens,
    volumeUsdg24h: day.volumeUsdg,
    fills24h: day.fills,
    accounts24h: day.accounts,
    thin: day.volumeUsdg < cfg.ipx.thinUsdg,
    thinThresholdUsdg: cfg.ipx.thinUsdg,
    receiptRoot,
    receiptsInRoot,
    history,
  };
}

// ---- Feed update payload ----------------------------------------------------------------------------

/** The arguments of IPXFeed.update(answer, receiptRoot, volumeUsdg). */
export type FeedUpdate = { answer: bigint; receiptRoot: Hex; volumeUsdg: bigint };

/** The update to post for a snapshot, or null when there is no price or no root to post (the feed then goes stale). */
export function feedUpdate(s: IpxSnapshot): FeedUpdate | null {
  if (s.priceE8 === null || s.receiptRoot === null) return null;
  return { answer: s.priceE8, receiptRoot: s.receiptRoot, volumeUsdg: s.volumeUsdg24h };
}

export const ipxFeedAbi = [
  { type: "function", name: "update", stateMutability: "nonpayable", inputs: [{ name: "answer", type: "int256" }, { name: "receiptRoot", type: "bytes32" }, { name: "volumeUsdg", type: "uint256" }], outputs: [{ name: "roundId", type: "uint80" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" }] },
] as const;

export function encodeFeedUpdate(u: FeedUpdate): Hex {
  return encodeFunctionData({ abi: ipxFeedAbi, functionName: "update", args: [u.answer, u.receiptRoot, u.volumeUsdg] });
}

// ---- Rendering --------------------------------------------------------------------------------------

/** A scaled integer as a plain decimal string ("42300000" with 8 decimals -> "0.423"). */
export function decimalString(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

export function snapshotJson(s: IpxSnapshot, cls: IpxClassDef, cfg: Pick<Config, "ipx">) {
  const update = feedUpdate(s);
  const reasons: string[] = [];
  if (s.volumeUsdg24h < s.thinThresholdUsdg) reasons.push("volume_below_threshold");
  if (s.priceE8 === null) reasons.push("no_fills_in_window");
  return {
    class: s.class,
    description: `ANYR-IPX/${s.class}`,
    unit: "USDG per 1,000,000 tokens",
    decimals: IPX_DECIMALS,
    price: s.priceE8 === null ? null : decimalString(s.priceE8, IPX_DECIMALS),
    price_e8: s.priceE8 === null ? null : s.priceE8.toString(),
    price_24h: s.price24hE8 === null ? null : decimalString(s.price24hE8, IPX_DECIMALS),
    as_of: s.asOf.toISOString(),
    window: { from: s.window.from.toISOString(), to: s.window.to.toISOString() },
    thin: s.thin,
    thin_reasons: s.thin ? reasons : [],
    thin_threshold_usdg: decimalString(s.thinThresholdUsdg, 6),
    volume_usdg_24h: decimalString(s.volumeUsdg24h, 6),
    tokens_24h: s.tokens24h.toString(),
    fills_24h: s.fills24h,
    accounts_24h: s.accounts24h,
    receipt_root: s.receiptRoot,
    receipts_in_root: s.receiptsInRoot,
    feed_update: update ? { answer: update.answer.toString(), receipt_root: update.receiptRoot, volume_usdg: update.volumeUsdg.toString() } : null,
    history: s.history.map((h) => ({
      hour_start: h.hourStart.toISOString(),
      price: h.priceE8 === null ? null : decimalString(h.priceE8, IPX_DECIMALS),
      tokens: h.tokens.toString(),
      volume_usdg: decimalString(h.volumeUsdg, 6),
      fills: h.fills,
    })),
    method: {
      weighting: "volume (prompt + completion tokens)",
      amount: "charged cost per receipt; USDG counted as one US dollar",
      excludes: ["byok", "cached responses", "cancelled", "zero-cost", "receipts missing a leaf", ...(cfg.ipx.attestedOnly ? ["providers without an attestation hash in the receipt"] : [])],
      account_cap_bps: cfg.ipx.maxAccountShareBps >= 10_000 ? null : cfg.ipx.maxAccountShareBps,
      receipt_root: "OpenZeppelin-compatible merkle root over the receipt leaves of the window's fills, ordered by time then id",
      models: cls.models,
    },
  };
}
