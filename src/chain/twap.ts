import { encodeAbiParameters, keccak256, toHex, type Hex, type PublicClient } from "viem";

// Time-weighted average price for Uniswap v4 pools, which have no built-in oracle: the average is
// rebuilt from the pool's own Swap events (every price change with its block), weighted by block
// time over a window, and taken in ticks (log price) like a v3 TWAP. The conservative value is the
// lower of spot and average, so a short spike never raises it, and a spot too far from the average
// (or too little liquidity) means "no trustworthy price".

export type PoolKey = { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };
/** sign +1: price of currency0 in currency1; -1: the inverse. Legs are multiplied (e.g. ANYR->ETH->USDG). */
export type Leg = { key: PoolKey; sign: 1 | -1 };

export const SWAP_TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const POOLS_SLOT = 6n; // StateLibrary: pools live at keccak256(poolId, 6); slot0 first, liquidity three slots on
const EXTSLOAD = "0x1e2eaeaf";

export const poolId = (k: PoolKey) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );

const int24 = (v: bigint) => {
  const n = Number(v & 0xffffffn);
  return n >= 0x800000 ? n - 0x1000000 : n;
};
const word = (n: bigint) => n.toString(16).padStart(64, "0");

export async function readPool(client: PublicClient, poolManager: Hex, key: PoolKey, blockNumber?: bigint) {
  const slot = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(key), POOLS_SLOT])));
  const load = async (s: bigint) => {
    const r = await client.call({ to: poolManager, data: (EXTSLOAD + word(s)) as Hex, blockNumber });
    return BigInt(r.data ?? "0x0");
  };
  const slot0 = await load(slot);
  const liquidity = (await load(slot + 3n)) & ((1n << 128n) - 1n);
  const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
  if (!sqrtPriceX96) throw new Error("pool not initialized");
  return { tick: int24(slot0 >> 160n), sqrtPriceX96, liquidity };
}

type SwapLog = { pool: string; block: number; index: number; tick: number };

async function swaps(client: PublicClient, poolManager: Hex, ids: Hex[], from: number, to: number): Promise<SwapLog[]> {
  if (to < from) return [];
  const logs = await client.request({
    method: "eth_getLogs",
    params: [{ address: poolManager, topics: [SWAP_TOPIC, ids], fromBlock: toHex(from), toBlock: toHex(to) }],
  } as never) as { removed?: boolean; address: string; data: string; topics: string[]; blockNumber: string; logIndex: string }[];
  return logs
    .filter((l) => !l.removed && l.address.toLowerCase() === poolManager.toLowerCase())
    .map((l) => {
      if (!/^0x[0-9a-fA-F]{384}$/.test(l.data)) throw new Error("malformed swap");
      return { pool: l.topics[1].toLowerCase(), block: Number(l.blockNumber), index: Number(l.logIndex), tick: int24(BigInt("0x" + l.data.slice(2 + 64 * 4, 2 + 64 * 5))) };
    })
    .sort((a, b) => a.block - b.block || a.index - b.index);
}

async function header(client: PublicClient, n: number) {
  const b = await client.getBlock({ blockNumber: BigInt(n) });
  return { number: n, time: Number(b.timestamp) };
}

/** First and last blocks at least `seconds` apart, and a block -> time map interpolated between seven headers. */
async function timeWindow(client: PublicClient, head: number, seconds: number, state: { blockRate?: number }) {
  const top = await header(client, head);
  let rate = state.blockRate || 4;
  let start = Math.max(1, head - Math.ceil(seconds * rate * 1.02) - 1);
  let first = await header(client, start);
  for (let i = 0; first.time > top.time - seconds; i++) {
    if (i >= 6 || start <= 1) throw new Error("chain history too short");
    const observed = (head - start) / Math.max(1, top.time - first.time);
    if (observed > 0) rate = observed;
    start = Math.max(1, start - Math.ceil((first.time - (top.time - seconds)) * rate * 1.1) - 1);
    first = await header(client, start);
  }
  state.blockRate = (head - start) / Math.max(1, top.time - first.time);
  const points = [first];
  for (let k = 1; k < 6; k++) {
    const n = start + Math.round((k * (head - start)) / 6);
    if (n > points[points.length - 1].number && n < head) points.push(await header(client, n));
  }
  points.push(top);
  for (let i = 1; i < points.length; i++) points[i].time = Math.max(points[i].time, points[i - 1].time);
  const at = (block: number) => {
    let i = 1;
    while (i < points.length - 1 && points[i].number < block) i++;
    const a = points[i - 1];
    const b = points[i];
    if (b.number === a.number) return b.time;
    const f = Math.min(1, Math.max(0, (block - a.number) / (b.number - a.number)));
    return a.time + f * (b.time - a.time);
  };
  return { start, t0: first.time, t1: top.time, at };
}

/** Time-weighted average tick over [t0, t1] from the tick before the window and each swap's resulting tick. */
export function averageTick(logs: { block: number; tick: number }[], before: number, at: (b: number) => number, t0: number, t1: number) {
  let tick = before;
  let cursor = t0;
  let area = 0;
  for (const l of logs) {
    const t = Math.min(t1, Math.max(cursor, at(l.block)));
    area += tick * (t - cursor);
    cursor = t;
    tick = l.tick;
  }
  area += tick * (t1 - cursor);
  return { average: t1 > t0 ? area / (t1 - t0) : tick, last: tick };
}

async function tickBefore(client: PublicClient, poolManager: Hex, pool: Hex, start: number, span: number) {
  let to = start - 1;
  for (const m of [1, 3, 12]) {
    const from = Math.max(0, to - span * m + 1);
    const logs = await swaps(client, poolManager, [pool], from, to);
    if (logs.length) return logs[logs.length - 1].tick;
    if (from === 0) break;
    to = from - 1;
  }
  return null; // no swaps: the pool has sat at its current tick
}

export type TwapResult = { spot: number; average: number; conservative: number; windowSeconds: number; block: number; swaps: number };

/**
 * Price through one or more legs (raw units of the last leg's quote per raw unit of the first leg's base),
 * scaled by `decimalsAdjust` (10^(baseDecimals - quoteDecimals)) into whole-token terms.
 * Throws when spot deviates from the average by more than `maxDeviation`.
 */
export async function v4Twap(
  client: PublicClient,
  poolManager: Hex,
  legs: Leg[],
  opts: { windowSeconds: number; maxDeviation: number; decimalsAdjust: number; state?: { blockRate?: number } },
): Promise<TwapResult> {
  const head = Number(await client.getBlockNumber({ cacheTime: 0 })) - 2;
  if (!(head > 0)) throw new Error("no head block");
  const ids = legs.map((l) => poolId(l.key).toLowerCase() as Hex);
  const span = await timeWindow(client, head, opts.windowSeconds, opts.state ?? {});
  const logs = await swaps(client, poolManager, ids, span.start, head);
  const maxTicks = Math.log(1 + opts.maxDeviation) / Math.log(1.0001);
  const measured: { spot: number; average: number; sign: number }[] = [];
  for (let i = 0; i < legs.length; i++) {
    const state = await readPool(client, poolManager, legs[i].key, BigInt(head));
    const own = logs.filter((l) => l.pool === ids[i]);
    const before = own.length ? ((await tickBefore(client, poolManager, ids[i], span.start, head - span.start + 1)) ?? own[0].tick) : state.tick;
    const { average, last } = averageTick(own, before, span.at, span.t0, span.t1);
    if (own.length && last !== state.tick) throw new Error("swap history doesn't match the pool");
    if (Math.abs(state.tick - average) > maxTicks) throw new Error("spot is too far from the average");
    measured.push({ spot: state.tick, average, sign: legs[i].sign });
  }
  const price = (pick: (m: (typeof measured)[number]) => number) => Math.pow(1.0001, measured.reduce((s, m) => s + m.sign * pick(m), 0)) * opts.decimalsAdjust;
  const spot = price((m) => m.spot);
  const average = price((m) => m.average);
  const conservative = Math.min(spot, average);
  if (!(conservative > 0) || !Number.isFinite(conservative)) throw new Error("no usable price");
  return { spot, average, conservative, windowSeconds: span.t1 - span.t0, block: head, swaps: logs.length };
}
