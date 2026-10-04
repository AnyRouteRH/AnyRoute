import { describe, expect, test } from "bun:test";
import { makeRpcReader, entryPointAbi, governanceAbi, verifyDeployment as verifyWithBuild, type ChainReader, type DeploymentManifest } from "../scripts/deployment-verification";
import { encodeFunctionResult, toFunctionSelector, type Address, type Hex } from "viem";
import { PayWithStockAbi, StockOracleAbi } from "../src/chain/abis";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const singleton = a(80);
const manifest: DeploymentManifest = {
  schema: "anyroute.deployments/v1", mode: "production", chainId: 4663, blockNumber: 100,
  deployer: a(1), owner: a(1), pendingOwner: a(20),
  contracts: { usdg: a(30), anyrToken: a(45), credits: a(31), callPay: a(32), receiptAnchor: a(33), royalty: a(34), providerBond: a(35), payWithStock: a(37), stockOracle: a(38), paymaster: a(39), uniswapV4Adapter: a(40), uniswapV3Adapter: a(41), entryPoint: a(42), poolManager: a(43), swapRouter02: a(44), timelock: a(20), buybackAdapter: a(40) },
  roles: { ownerSafe: a(50), settlement: a(51), slasher: a(52), router: a(53), registrar: a(54), anchorer: a(55), keeper: a(56), paymasterSigner: a(58), refundPool: a(59), callPayTreasury: a(60), guardian: a(61), anyrRecipients: [a(62), a(63), a(64), a(65)] },
  params: { timelockMinDelay: 86400, paymasterDailyCap: "10000000000000000", paymasterDeposit: "20000000000000000", paymasterStake: "10000000000000000" },
  stockTokens: [{ address: a(70), feed: a(71), primaryAdapter: a(41), fallbackAdapter: a(0) }],
};

function fixture(overrides: Record<string, unknown> = {}): ChainReader {
  const ownerByAddress = new Map(Object.entries(manifest.contracts).filter(([k]) => ["credits", "callPay", "receiptAnchor", "royalty", "providerBond", "payWithStock", "stockOracle", "paymaster", "uniswapV4Adapter", "uniswapV3Adapter"].includes(k)).map(([, v]) => [v.toLowerCase(), manifest.contracts.timelock]));
  return {
    async chainId() { return 4663; }, async snapshot() { return { number: 123n, hash }; },
    async code() { return `0x6001` as Hex; },
    async read(address, signature, args = []) {
      const key = `${address.toLowerCase()}:${signature}`;
      const argsKey = `${key}:${args.map((value) => String(value).toLowerCase()).join(":")}`;
      if (argsKey in overrides) return overrides[argsKey];
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
      if (signature === "adapter()") return manifest.contracts.buybackAdapter;
      if (signature === "router()") return address.toLowerCase() === manifest.contracts.uniswapV3Adapter.toLowerCase() ? manifest.contracts.swapRouter02 : manifest.roles.router;
      if (signature === "poolManager()") return manifest.contracts.poolManager;
      if (signature === "isCaller(address)") return true;
      if (signature === "tokens(address)") return [true, manifest.stockTokens![0].primaryAdapter, manifest.stockTokens![0].fallbackAdapter];
      if (signature === "masterCopy()") return singleton;
      if (signature === "oracle()") return manifest.contracts.stockOracle;
      if (signature === "verifyingSigner()") return manifest.roles.paymasterSigner;
      if (signature === "entryPoint()") return manifest.contracts.entryPoint;
      if (signature === "dailyCap()") return BigInt(String(manifest.params.paymasterDailyCap));
      if (signature === "guardian()") return manifest.roles.guardian;
      if (signature === "getMinDelay()") return 86400n;
      if (signature === "hasRole(bytes32,address)") {
        const [roleHash, account] = args.map((value) => String(value).toLowerCase());
        if (roleHash === `0x${"00".repeat(32)}`) return account === manifest.contracts.timelock.toLowerCase();
        return account !== manifest.deployer.toLowerCase() && account !== a(0).toLowerCase();
      }
      if (signature === "getOwners()") return address.toLowerCase() === manifest.roles.ownerSafe.toLowerCase() ? [a(66), a(67), a(68)] : [a(73), a(74), a(75)];
      if (signature === "getThreshold()") return 2n;
      if (signature === "getDepositInfo(address)") return [20_000_000_000_000_000n, true, 10_000_000_000_000_000n, 86400, 0];
      if (signature === "configOf(address)") return [manifest.stockTokens![0].feed, 8, 302400, false, false];
      throw new Error(`unexpected read ${signature} ${String(args)}`);
    },
  };
}

describe("deployment verification", () => {
  test("accepts complete production evidence with compiler-bound runtime proof", async () => {
    const result = await verifyDeployment(manifest, fixture(), "fixture-revision", singleton);
    expect(result.ok).toBe(true);
    expect(result.observed).toEqual({ chainId: 4663, blockNumber: "123", blockHash: hash });
    expect(result.checks.find((c) => c.id === "contracts.source_equivalence")?.status).toBe("pass");
    expect(result.checks.find((c) => c.id === "timelock.self_admin")?.status).toBe("pass");
    expect(result.checks.find((c) => c.id === "timelock.ownerSafe_not_admin")?.status).toBe("pass");
    expect(result.checks.find((c) => c.id === "stockPay.feature")?.status).toBe("info");
  });

  test("fails when ownership, multisig policy, roles, or funding are unsafe", async () => {
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.contracts.credits.toLowerCase()}:owner()`]: a(1),
      [`${manifest.contracts.callPay.toLowerCase()}:treasury()`]: a(99),
      [`${manifest.contracts.timelock.toLowerCase()}:getMinDelay()`]: 3600n,
      [`${manifest.contracts.entryPoint.toLowerCase()}:getDepositInfo(address)`]: [0n, false, 0n, 0, 0],
      [`${manifest.roles.ownerSafe.toLowerCase()}:getThreshold()`]: 1n,
    }), "fixture-revision", singleton);
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.id === "ownership.credits.accepted_by_timelock" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "roles.callPay.treasury" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "governance.ownerSafe.threshold_valid" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "paymaster.stake" && c.status === "fail")).toBe(true);
  });

  test("rejects mismatched settlement, slasher, refund, treasury, and router wiring", async () => {
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.contracts.credits.toLowerCase()}:settlement()`]: a(90),
      [`${manifest.contracts.providerBond.toLowerCase()}:slasher()`]: a(91),
      [`${manifest.contracts.providerBond.toLowerCase()}:refundPool()`]: a(92),
      [`${manifest.contracts.royalty.toLowerCase()}:settlement()`]: a(93),
      [`${manifest.contracts.payWithStock.toLowerCase()}:router()`]: a(94),
      [`${manifest.contracts.callPay.toLowerCase()}:treasury()`]: a(95),
      [`${manifest.contracts.uniswapV3Adapter.toLowerCase()}:router()`]: a(96),
      [`${manifest.contracts.uniswapV4Adapter.toLowerCase()}:poolManager()`]: a(97),
    }), "fixture-revision", singleton);
    for (const id of ["roles.credits.settlement", "roles.providerBond.slasher", "roles.providerBond.refundPool", "roles.royalty.settlement", "roles.payWithStock.router", "roles.callPay.treasury", "adapters.uniswapV3.router", "adapters.uniswapV4.poolManager"]) {
      expect(result.checks.find((check) => check.id === id)?.status).toBe("fail");
    }
  });

  test("rejects disabled stock routes, missing token manifests, inactive adapter callers, and wrong Safe singleton", async () => {
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.roles.ownerSafe.toLowerCase()}:masterCopy()`]: a(99),
      [`${manifest.contracts.payWithStock.toLowerCase()}:tokens(address)`]: [false, manifest.stockTokens![0].primaryAdapter, manifest.stockTokens![0].fallbackAdapter],
      [`${manifest.contracts.uniswapV3Adapter.toLowerCase()}:isCaller(address)`]: false,
    }), "fixture-revision", singleton);
    expect(result.checks.find((check) => check.id === "governance.ownerSafe.singleton")?.status).toBe("fail");
    expect(result.checks.find((check) => check.id === `stocks.${manifest.stockTokens![0].address}.enabled`)?.status).toBe("fail");
    expect(result.checks.find((check) => check.id === `adapters.${manifest.contracts.uniswapV3Adapter}.${manifest.contracts.payWithStock}.enabled`)?.status).toBe("fail");

    const withoutStocks = await verifyDeployment({ ...manifest, stockTokens: [] }, fixture(), "fixture-revision", singleton);
    expect(withoutStocks.checks.find((check) => check.id === "stockPay.feature")?.status).toBe("info");
    expect(withoutStocks.ok).toBe(true);
  });

  test("fails when TimelockController no longer holds its self-admin role", async () => {
    const zeroRole = `0x${"00".repeat(32)}`;
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.contracts.timelock.toLowerCase()}:hasRole(bytes32,address):${zeroRole}:${manifest.contracts.timelock.toLowerCase()}`]: false,
    }), "fixture-revision", singleton);
    expect(result.checks.find((check) => check.id === "timelock.self_admin")?.status).toBe("fail");
  });

  test("uses real JSON-RPC ABI encoding/decoding and emits serializable report evidence", async () => {
    const stockOracleAbi = StockOracleAbi as never;
    const responses = new Map<string, Hex>([
      [toFunctionSelector("getDepositInfo(address)"), encodeFunctionResult({ abi: entryPointAbi, functionName: "getDepositInfo", result: { deposit: 20_000_000_000_000_000n, staked: true, stake: 10_000_000_000_000_000n, unstakeDelaySec: 86400, withdrawTime: 0 } } as never)],
      [toFunctionSelector("configOf(address)"), encodeFunctionResult({ abi: stockOracleAbi, functionName: "configOf", result: { feed: manifest.stockTokens![0].feed, feedDecimals: 8, maxStaleness: 302400, paused: false, applyMultiplier: false } } as never)],
      [toFunctionSelector("tokens(address)"), encodeFunctionResult({ abi: PayWithStockAbi as never, functionName: "tokens", result: [true, manifest.stockTokens![0].primaryAdapter, manifest.stockTokens![0].fallbackAdapter] } as never)],
      [toFunctionSelector("masterCopy()"), encodeFunctionResult({ abi: governanceAbi, functionName: "masterCopy", result: singleton })],
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
      expect(deposit).toEqual({ deposit: 20_000_000_000_000_000n, staked: true, stake: 10_000_000_000_000_000n, unstakeDelaySec: 86400, withdrawTime: 0 });
      expect(tupleFieldValue(config, "feed")).toBe(manifest.stockTokens![0].feed);

      const reader: ChainReader = { ...rpcReader, chainId: async () => 4663, snapshot: async () => ({ number: 123n, hash }), code: async () => "0x6001" };
      const report = await verifyDeployment(manifest, reader, "a".repeat(40), singleton);
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
    const result = await verifyDeployment(manifest, reader, "a".repeat(40), singleton);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-value");
    expect(result.checks.find((c) => c.id === "ownership.credits.owner")?.evidence).toEqual({ category: "rpc_error" });
  });

  test("fails explicitly on malformed EntryPoint and stock oracle tuples", async () => {
    const result = await verifyDeployment(manifest, fixture({
      [`${manifest.contracts.entryPoint.toLowerCase()}:getDepositInfo(address)`]: [1n, true],
      [`${manifest.contracts.stockOracle.toLowerCase()}:configOf(address)`]: "not-a-tuple",
    }), "a".repeat(40), singleton);
    expect(result.checks.find((c) => c.id === "paymaster.funding.shape")?.status).toBe("fail");
    expect(result.checks.find((c) => c.id === `feeds.${manifest.stockTokens![0].address}.config_shape`)?.status).toBe("fail");
  });
});

function tupleFieldValue(value: unknown, name: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}

function verifyDeployment(...[m, reader, revision, safe]: Parameters<typeof verifyWithBuild>) {
  return verifyWithBuild(m, reader, revision, safe, { sourceRevision: revision, contracts: Object.fromEntries(Object.keys(m.contracts).map(name => [name, { object: "0x6001" as Hex, immutableReferences: {}, immutableValues: {} }])) });
}

test("runtime proof is mandatory and rejects mismatching compiled code", async () => {
  expect((await verifyWithBuild(manifest, fixture(), "fixture-revision", singleton)).ok).toBe(false);
  const build = { sourceRevision: "fixture-revision", contracts: Object.fromEntries(Object.keys(manifest.contracts).map(name => [name, { object: "0x6002" as Hex, immutableReferences: {}, immutableValues: {} }])) };
  const result = await verifyWithBuild(manifest, fixture(), "fixture-revision", singleton, build);
  expect(result.ok).toBe(false);
  expect(result.checks.find(c => c.id === "contracts.source_equivalence")?.status).toBe("fail");
});
