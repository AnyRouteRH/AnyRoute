// Records the read-only RPC responses behind one $ANYR price reading into a fixture that test/anyr-twap-fixture.ts
// replays (test/escrow-anyr-price.test.ts). It only sends eth_blockNumber, eth_getBlockByNumber, eth_call and
// eth_getLogs to the public RPC, never a transaction, and needs no keys.
//
// Usage: bun scripts/capture-anyr-twap-fixture.ts <out.json.gz> [rpcUrl]
//
// The reading runs with the deviation guard off, so the recording is complete whether or not a router would
// have priced at that moment; the tests apply the guard to it. Stored responses are exactly what the node
// returned, minus fields the price code never reads (log block hash and transaction fields, block bodies), and
// the look-back log queries (which the code reads only for their final entry) keep just that entry.
import { createPublicClient, custom } from "viem";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import mainnet from "../config/rhc-mainnet.json";
import { v4Twap } from "../src/chain/twap.ts";

const out = process.argv[2];
const rpc = process.argv[3] ?? mainnet.rpc;
if (!out) throw new Error("usage: bun scripts/capture-anyr-twap-fixture.ts <out.json.gz> [rpcUrl]");

const ALLOWED = new Set(["eth_blockNumber", "eth_getBlockByNumber", "eth_call", "eth_getLogs"]);
type Call = { method: string; params: unknown[]; result: any };
const calls: Call[] = [];
const client = createPublicClient({
  transport: custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (!ALLOWED.has(method)) throw new Error(`refusing to send ${method}`);
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      calls.push({ method, params: params ?? [], result: j.result });
      return j.result;
    },
  }),
}) as never;

const reading = await v4Twap(client, mainnet.uniswap.v4PoolManager as `0x${string}`, mainnet.anyr.escrowPoolLegs as never, { windowSeconds: 1800, maxDeviation: 1, decimalsAdjust: 1e12, state: {} });

// Trim: keep what the code reads.
const windowStart = Math.max(...calls.filter((c) => c.method === "eth_getLogs").map((c) => parseInt((c.params[0] as { toBlock: string }).toBlock, 16)));
const trimmed = calls.map((c) => {
  if (c.method === "eth_getBlockByNumber") return { ...c, result: { number: c.result.number, hash: c.result.hash, parentHash: c.result.parentHash, timestamp: c.result.timestamp, transactions: [] } };
  if (c.method !== "eth_getLogs") return c;
  let logs = (c.result as { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string }[]).map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, logIndex: l.logIndex, removed: false }));
  const lookBack = parseInt((c.params[0] as { toBlock: string }).toBlock, 16) < windowStart;
  if (lookBack) logs = logs.slice(-1);
  return { ...c, result: logs };
});

const fixture = {
  meta: {
    capturedAt: new Date().toISOString(),
    chainId: mainnet.chainId,
    poolManager: mainnet.uniswap.v4PoolManager,
    legs: mainnet.anyr.escrowPoolLegs,
    windowSeconds: 1800,
    note: "Read-only eth_blockNumber, eth_getBlockByNumber, eth_call and eth_getLogs responses from the public RPC; see scripts/capture-anyr-twap-fixture.ts.",
  },
  reading,
  calls: trimmed,
};
writeFileSync(out, gzipSync(JSON.stringify(fixture)));
console.log(JSON.stringify({ out, calls: calls.length, swaps: reading.swaps, spot: reading.spot, average: reading.average, conservative: reading.conservative, bytes: gzipSync(JSON.stringify(fixture)).length }));
