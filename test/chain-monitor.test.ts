import { expect, test } from "bun:test";
import { encodeEventTopics, encodeAbiParameters, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { collectChainMetrics, type MonitorReader, type MonitorLog } from "../scripts/chain-monitor.ts";
const a = (n: number) => `0x${String(n).repeat(40)}` as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const policy = { chainId: 4663, windowBlocks: 100, contracts: [{ name: "credits", address: a(1), owner: a(2) }], keepers: [{ name: "keeper", address: a(3), minimumWei: "100" }], tokens: [{ name: "usdg", address: a(4), maximumOutflowUnits: "50" }], authorityEvents: ["SettlementSet(address)"], pauseEvents: ["MintingPausedSet(bool)"] };
const reader = (logs: MonitorLog[] = []): MonitorReader => ({ chainId: async () => 4663, finalized: async () => ({ number: 120n, hash }), hash: async () => hash, logs: async (_addresses, from, to) => { expect(from).toBe(21n); expect(to).toBe(120n); return logs; }, owner: async () => a(2), balance: async () => 100n });
const event = (signature: string): MonitorLog => ({ address: a(1), topics: [keccak256(stringToHex(signature))], data: "0x" });
const transfer = (from: Address, to: Address, amount: bigint): MonitorLog => ({ address: a(4), topics: encodeEventTopics({ abi: parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]), eventName: "Transfer", args: { from, to } }) as [Hex, ...Hex[]], data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
test("chain incident drill observes authority, pause, keeper and bounded outflow without writes", async () => {
  const rpc = reader([event("OwnershipTransferred(address,address)"), event("MintingPausedSet(bool)"), transfer(a(1), a(5), 51n), transfer(a(5), a(1), 900n)]);
  rpc.owner = async () => a(5); rpc.balance = async () => 99n;
  const metrics = await collectChainMetrics(policy, rpc);
  for (const key of ["authority_changed", "pause_changed", "owner_mismatch", "keeper_underfunded", "outflow_over_limit"]) expect(metrics).toContain(`anyroute_chain_${key}{component="${key === "keeper_underfunded" ? "keeper" : key === "outflow_over_limit" ? "usdg" : "credits"}"} 1`);
});
test("healthy thresholds use exact integers and internal movements are not external outflows", async () => {
  const metrics = await collectChainMetrics(policy, reader([transfer(a(1), a(5), 50n), transfer(a(1), a(1), 999n)]));
  expect(metrics).toContain('anyroute_chain_outflow_over_limit{component="usdg"} 0');
  expect(metrics).toContain('anyroute_chain_keeper_underfunded{component="keeper"} 0');
});
test("missing reads, wrong chains, changed block hashes and unsafe policy never report healthy", async () => {
  for (const rpc of [{ ...reader(), chainId: async () => 1 }, { ...reader(), hash: async () => null }, { ...reader(), owner: async () => { throw Error("private transport failure"); } }]) await expect(collectChainMetrics(policy, rpc)).rejects.toThrow();
  await expect(collectChainMetrics({ ...policy, windowBlocks: 0 }, reader())).rejects.toThrow();
  await expect(collectChainMetrics({ ...policy, contracts: [{ name: 'invalid"label', address: a(1) }] }, reader())).rejects.toThrow();
});
