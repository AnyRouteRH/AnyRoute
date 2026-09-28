import { describe, expect, test } from "bun:test";
import { makeRpcReader, entryPointAbi, verifyDeployment, type ChainReader, type DeploymentManifest } from "../scripts/deployment-verification";
import { encodeFunctionResult, toFunctionSelector, type Address, type Hex } from "viem";
import { AnyrStakingAbi, StockOracleAbi } from "../src/chain/abis";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const manifest: DeploymentManifest = {
  schema: "anyroute.deployments/v1", mode: "production", chainId: 4663, blockNumber: 100,
  deployer: a(1), owner: a(1), pendingOwner: a(20),
  contracts: { usdg: a(30), anyrToken: a(45), credits: a(31), callPay: a(32), receiptAnchor: a(33), royalty: a(34), providerBond: a(35), anyrStaking: a(36), payWithStock: a(37), stockOracle: a(38), paymaster: a(39), uniswapV4Adapter: a(40), uniswapV3Adapter: a(41), entryPoint: a(42), poolManager: a(43), swapRouter02: a(44), timelock: a(20), buybackAdapter: a(40) },
  roles: { ownerSafe: a(50), settlement: a(51), slasher: a(52), router: a(53), registrar: a(54), anchorer: a(55), keeper: a(56), opsWallet: a(57), paymasterSigner: a(58), refundPool: a(59), callPayTreasury: a(60), guardian: a(61), anyrRecipients: [a(62), a(63), a(64), a(65)] },
  params: { timelockMinDelay: 86400, paymasterDailyCap: "10000000000000000", paymasterDeposit: "20000000000000000", paymasterStake: "10000000000000000" },
  stockTokens: [{ address: a(70), feed: a(71) }],
};

function fixture(overrides: Record<string, unknown> = {}): ChainReader {
  const ownerByAddress = new Map(Object.entries(manifest.contracts).filter(([k]) => ["credits", "callPay", "receiptAnchor", "royalty", "providerBond", "anyrStaking", "payWithStock", "stockOracle", "paymaster", "uniswapV4Adapter", "uniswapV3Adapter"].includes(k)).map(([, v]) => [v.toLowerCase(), manifest.contracts.timelock]));
  return {
    async chainId() { return 4663; }, async snapshot() { return { number: 123n, hash }; },
    async code() { return `0x6001` as Hex; },
    async read(address, signature, args = []) {
      const key = `${address.toLowerCase()}:${signature}`;
      if (key in overrides) return overrides[key];
      if (signature === "owner()") return ownerByAddress.get(address.toLowerCase()) ?? a(1);
      if (signature === "pendingOwner()") return a(0);
      if (signature === "CONTROL_VERSION()") return 2n;
      if (signature === "settlement()") return manifest.roles.settlement;
      if (signature === "isCreditor(address)") return true;
      if (signature === "usdg()") return manifest.contracts.usdg;
      if (signature === "anyr()") return manifest.contracts.anyrToken;
      if (signature === "slasher()") return manifest.roles.slasher;
      if (signature === "refundPool()") return manifest.roles.refundPool;
      if (signature === "treasury()") return manifest.roles.callPayTreasury;
      if (signature === "anchorer()") return manifest.roles.anchorer;
      if (signature === "registrar()") return manifest.roles.registrar;
      if (signature === "keeper()") return manifest.roles.keeper;
      if (signature === "opsWallet()") return manifest.roles.opsWallet;
      if (signature === "adapter()") return manifest.contracts.buybackAdapter;
      if (signature === "router()") return manifest.roles.router;
      if (signature === "oracle()") return manifest.contracts.stockOracle;
      if (signature === "verifyingSigner()") return manifest.roles.paymasterSigner;
      if (signature === "entryPoint()") return manifest.contracts.entryPoint;
      if (signature === "dailyCap()") return BigInt(String(manifest.params.paymasterDailyCap));
      if (signature === "guardian()") return manifest.roles.guardian;
      if (signature === "getMinDelay()") return 86400n;
      if (signature === "hasRole(bytes32,address)") return String(args[1]).toLowerCase() !== manifest.deployer.toLowerCase() && String(args[1]).toLowerCase() !== a(0).toLowerCase();
      if (signature === "getOwners()") return address.toLowerCase() === manifest.roles.ownerSafe.toLowerCase() ? [a(66), a(67), a(68)] : [a(73), a(74), a(75)];
      if (signature === "getThreshold()") return 2n;
      if (signature === "getDepositInfo(address)") return [20_000_000_000_000_000n, true, 10_000_000_000_000_000n, 86400, 0];
      if (signature === "buybackPriceOracle()") return a(0);
      if (signature === "configOf(address)") return [manifest.stockTokens![0].feed, 8, 302400, false, false];
      throw new Error(`unexpected read ${signature} ${String(args)}`);
    },
  };
}

describe("deployment verification", () => {
  test("accepts complete production evidence while labeling unavailable source proof", async () => {
    const result = await verifyDeployment(manifest, fixture(), "fixture-revision");
    expect(result.ok).toBe(true);
    expect(result.observed).toEqual({ chainId: 4663, blockNumber: "123", blockHash: hash });
    expect(result.checks.find((c) => c.id === "contracts.source_equivalence")?.status).toBe("info");
    expect(result.checks.find((c) => c.id === "buybacks.oracle")?.status).toBe("info");
  });

  test("fails when ownership, multisig policy, roles, or funding are unsafe", async () => {
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.contracts.credits.toLowerCase()}:owner()`]: a(1),
      [`${manifest.contracts.callPay.toLowerCase()}:treasury()`]: a(99),
      [`${manifest.contracts.timelock.toLowerCase()}:getMinDelay()`]: 3600n,
      [`${manifest.contracts.entryPoint.toLowerCase()}:getDepositInfo(address)`]: [0n, false, 0n, 0, 0],
      [`${manifest.roles.ownerSafe.toLowerCase()}:getThreshold()`]: 1n,
    }), "fixture-revision");
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.id === "ownership.credits.accepted_by_timelock" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "roles.callPay.treasury" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "governance.ownerSafe.threshold_valid" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "paymaster.stake" && c.status === "fail")).toBe(true);
  });

  test("uses real JSON-RPC ABI encoding/decoding and emits serializable report evidence", async () => {
    const anyrAbi = AnyrStakingAbi as never;
    const stockOracleAbi = StockOracleAbi as never;
    const responses = new Map<string, Hex>([
      [toFunctionSelector("anyr()"), encodeFunctionResult({ abi: anyrAbi, functionName: "anyr", result: manifest.contracts.anyrToken } as never)],
      [toFunctionSelector("getDepositInfo(address)"), encodeFunctionResult({ abi: entryPointAbi, functionName: "getDepositInfo", result: { deposit: 20_000_000_000_000_000n, staked: true, stake: 10_000_000_000_000_000n, unstakeDelaySec: 86400, withdrawTime: 0 } } as never)],
      [toFunctionSelector("configOf(address)"), encodeFunctionResult({ abi: stockOracleAbi, functionName: "configOf", result: { feed: manifest.stockTokens![0].feed, feedDecimals: 8, maxStaleness: 302400, paused: false, applyMultiplier: false } } as never)],
    ]);
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { id: number; method: string; params: Array<{ data?: Hex }> };
        let result: unknown = "0x";
        if (body.method === "eth_chainId") result = "0x1237";
        else if (body.method === "eth_getCode") result = "0x6001";
        else if (body.method === "eth_call") result = responses.get(body.params[0].data!.slice(0, 10)) ?? "0x";
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      const rpcReader = makeRpcReader(`http://127.0.0.1:${server.port}`);
      const deposit = await rpcReader.read(manifest.contracts.entryPoint, "getDepositInfo(address)", [manifest.contracts.paymaster]);
      const config = await rpcReader.read(manifest.contracts.stockOracle, "configOf(address)", [manifest.stockTokens![0].address]);
      const token = await rpcReader.read(manifest.contracts.anyrStaking, "anyr()");
      expect(deposit).toEqual({ deposit: 20_000_000_000_000_000n, staked: true, stake: 10_000_000_000_000_000n, unstakeDelaySec: 86400, withdrawTime: 0 });
      expect(tupleFieldValue(config, "feed")).toBe(manifest.stockTokens![0].feed);
      expect(String(token).toLowerCase()).toBe(manifest.contracts.anyrToken.toLowerCase());

      const reader: ChainReader = { ...rpcReader, chainId: async () => 4663, snapshot: async () => ({ number: 123n, hash }), code: async () => "0x6001" };
      const report = await verifyDeployment(manifest, reader, "a".repeat(40));
      const json = JSON.stringify(report);
      expect(JSON.parse(json).observed.blockHash).toBe(hash);
      expect(report.checks.find((c) => c.id === "paymaster.deposit")?.status).toBe("pass");
      expect(report.checks.find((c) => c.id === `feeds.${manifest.stockTokens![0].address}.active`)?.status).toBe("pass");
    } finally {
      server.stop(true);
    }
  });

  test("does not copy credential-bearing RPC exceptions into evidence", async () => {
    const base = fixture();
    const reader: ChainReader = { ...base, async read(address, signature, args, block) {
      if (signature === "owner()") throw new Error("request failed for https://rpc.example/?token=private-value");
      return base.read(address, signature, args, block);
    } };
    const result = await verifyDeployment(manifest, reader, "a".repeat(40));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-value");
    expect(result.checks.find((c) => c.id === "ownership.credits.owner")?.evidence).toEqual({ category: "rpc_error" });
  });

  test("fails explicitly on malformed EntryPoint and stock oracle tuples", async () => {
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.contracts.entryPoint.toLowerCase()}:getDepositInfo(address)`]: [1n, true],
      [`${manifest.contracts.stockOracle.toLowerCase()}:configOf(address)`]: "not-a-tuple",
    }), "a".repeat(40));
    expect(result.checks.find((c) => c.id === "paymaster.funding.shape")?.status).toBe("fail");
    expect(result.checks.find((c) => c.id === `feeds.${manifest.stockTokens![0].address}.config_shape`)?.status).toBe("fail");
  });
});

function tupleFieldValue(value: unknown, name: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}
