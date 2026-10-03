import { readFile } from "node:fs/promises";
import { createPublicClient, decodeEventLog, http, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const units = z.string().regex(/^\d+$/);
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const chainMonitorSchema = z.strictObject({
  chainId: z.number().int().positive(),
  windowBlocks: z.number().int().min(1).max(2000),
  contracts: z.array(z.strictObject({ name, address, owner: address.optional() })).min(1).max(64),
  keepers: z.array(z.strictObject({ name, address, minimumWei: units.refine(v => BigInt(v) > 0n) })).min(1).max(16),
  tokens: z.array(z.strictObject({ name, address, maximumOutflowUnits: units.refine(v => BigInt(v) > 0n) })).min(1).max(16),
  authorityEvents: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*\([a-zA-Z0-9,\[\]]*\)$/)).max(128),
  pauseEvents: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*\([a-zA-Z0-9,\[\]]*\)$/)).min(1).max(32),
});
export type ChainMonitorConfig = z.infer<typeof chainMonitorSchema>;
export type MonitorLog = { address: Address; topics: [Hex, ...Hex[]]; data: Hex };
export type MonitorReader = {
  chainId(): Promise<number>;
  finalized(): Promise<{ number: bigint; hash: Hex }>;
  hash(number: bigint): Promise<Hex | null>;
  logs(address: Address[], from: bigint, to: bigint): Promise<MonitorLog[]>;
  owner(address: Address, block: bigint): Promise<Address>;
  balance(address: Address, block: bigint): Promise<bigint>;
};
const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const topic = (signature: string) => keccak256(stringToHex(signature)).toLowerCase();

/** Public, finalized-chain observations only. Failed or inconsistent reads produce no healthy gauges. */
export async function collectChainMetrics(input: unknown, reader: MonitorReader): Promise<string> {
  const config = chainMonitorSchema.parse(input);
  if (await reader.chainId() !== config.chainId) throw new Error("Wrong chain");
  const snapshot = await reader.finalized();
  const from = snapshot.number >= BigInt(config.windowBlocks) ? snapshot.number - BigInt(config.windowBlocks) + 1n : 0n;
  const watched = new Set(config.contracts.map(c => c.address.toLowerCase()));
  const authority = new Set(["OwnershipTransferred(address,address)", "OwnershipTransferStarted(address,address)", ...config.authorityEvents].map(topic));
  const pauses = new Set(config.pauseEvents.map(topic));
  const addresses = [...new Set([...config.contracts, ...config.tokens].map(c => c.address))] as Address[];
  const logs = await reader.logs(addresses, from, snapshot.number);
  if (logs.length > 100000) throw new Error("Observation window too large");
  const values: string[] = [];
  const gauge = (metric: string, label: string, value: boolean) => values.push(`${metric}{component=${JSON.stringify(label)}} ${value ? 1 : 0}`);
  for (const contract of config.contracts) {
    const events = logs.filter(l => l.address.toLowerCase() === contract.address.toLowerCase());
    gauge("anyroute_chain_authority_changed", contract.name, events.some(l => authority.has(l.topics[0].toLowerCase())));
    gauge("anyroute_chain_pause_changed", contract.name, events.some(l => pauses.has(l.topics[0].toLowerCase())));
    if (contract.owner) gauge("anyroute_chain_owner_mismatch", contract.name, (await reader.owner(contract.address as Address, snapshot.number)).toLowerCase() !== contract.owner.toLowerCase());
  }
  for (const keeper of config.keepers) gauge("anyroute_chain_keeper_underfunded", keeper.name, await reader.balance(keeper.address as Address, snapshot.number) < BigInt(keeper.minimumWei));
  for (const token of config.tokens) {
    let outflow = 0n;
    for (const log of logs.filter(l => l.address.toLowerCase() === token.address.toLowerCase() && l.topics[0].toLowerCase() === topic("Transfer(address,address,uint256)"))) {
      const event = decodeEventLog({ abi: transferAbi, topics: log.topics, data: log.data });
      if (watched.has(event.args.from.toLowerCase()) && !watched.has(event.args.to.toLowerCase())) outflow += event.args.value;
    }
    gauge("anyroute_chain_outflow_over_limit", token.name, outflow > BigInt(token.maximumOutflowUnits));
  }
  if (await reader.hash(snapshot.number) !== snapshot.hash) throw new Error("Snapshot changed");
  return "anyroute_chain_monitor_ok 1\n" + values.join("\n") + "\n";
}
export function makeMonitorReader(url: string): MonitorReader {
  const client = createPublicClient({ transport: http(url, { timeout: 10000, retryCount: 0 }) });
  return {
    chainId: () => client.getChainId(),
    finalized: async () => { const b = await client.getBlock({ blockTag: "finalized" }); if (!b.hash) throw new Error("No finalized hash"); return { number: b.number, hash: b.hash }; },
    hash: async number => (await client.getBlock({ blockNumber: number })).hash,
    logs: async (address, fromBlock, toBlock) => await client.getLogs({ address, fromBlock, toBlock }) as MonitorLog[],
    owner: (address, blockNumber) => client.readContract({ address, blockNumber, abi: parseAbi(["function owner() view returns (address)"]), functionName: "owner" }),
    balance: (address, blockNumber) => client.getBalance({ address, blockNumber }),
  };
}
if (import.meta.main) {
  const [path, rpc, mode] = process.argv.slice(2);
  if (!path || !rpc || mode && mode !== "--serve") throw new Error("Usage: bun scripts/chain-monitor.ts <public-policy.json> <public-rpc-url> [--serve]");
  const config = chainMonitorSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const reader = makeMonitorReader(rpc);
  const collect = async () => { try { return { ok: true, text: await collectChainMetrics(config, reader) }; } catch { return { ok: false, text: "anyroute_chain_monitor_ok 0\n" }; } };
  if (mode === "--serve") {
    // Deliberate operator invocation only; no background service is installed.
    Bun.serve({ hostname: "127.0.0.1", port: 9797, fetch: async req => {
      if (new URL(req.url).pathname !== "/metrics") return new Response(null, { status: 404 });
      const result = await collect(); return new Response(result.text, { status: result.ok ? 200 : 503, headers: { "content-type": "text/plain; version=0.0.4" } });
    } });
  } else { const result = await collect(); console.log(result.text.trimEnd()); if (!result.ok) process.exitCode = 1; }
}
