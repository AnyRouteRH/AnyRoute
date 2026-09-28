import { describe, expect, test } from "bun:test";
import { verifyDeployment, type ChainReader, type DeploymentManifest } from "../scripts/deployment-verification";
import type { Address, Hex } from "viem";

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
      if (signature === "hasRole(bytes32,address)") return true;
      if (signature === "getOwners()") return address.toLowerCase() === manifest.roles.ownerSafe.toLowerCase() ? [a(66), a(67), a(68)] : [a(73), a(74), a(75)];
      if (signature === "getThreshold()") return 2n;
      if (signature === "getDepositInfo(address)") return [20_000_000_000_000_000n, true, 10_000_000_000_000_000n, 86400];
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
      [`${manifest.contracts.entryPoint.toLowerCase()}:getDepositInfo(address)`]: [0n, false, 0n, 0],
      [`${manifest.roles.ownerSafe.toLowerCase()}:getThreshold()`]: 1n,
    }), "fixture-revision");
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.id === "ownership.credits.accepted_by_timelock" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "roles.callPay.treasury" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "governance.ownerSafe.threshold_valid" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.id === "paymaster.stake" && c.status === "fail")).toBe(true);
  });
});
