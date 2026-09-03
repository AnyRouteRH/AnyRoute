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
