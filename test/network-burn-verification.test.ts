import { expect, test } from "bun:test";
import type { Address } from "viem";
import { verifyNetworkBurn } from "../scripts/network-burn-verification.ts";
import type { ChainReader, DeploymentManifest } from "../scripts/deployment-verification.ts";
import { requireNetworkBurnEvidence } from "../src/network/burn-verification.ts";
import { loadConfig } from "../src/config.ts";
const a = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Address;
const manifest = { contracts: { networkFeeBurn: a(1), usdg: a(2), anyrToken: a(3), networkFeeBurnAdapter: a(4), networkFeeBurnOracle: a(5) }, roles: { keeper: a(6) }, params: { networkFeeBurnDailyCap: "10000000000" } } as unknown as DeploymentManifest;
const settings = { NETWORK_FEE_BURN_ENABLED: true, NETWORK_FEE_BURN_ADDRESS: a(1), NETWORK_FEE_BURN_ADAPTER_ADDRESS: a(4), NETWORK_FEE_BURN_ORACLE_ADDRESS: a(5), NETWORK_FEE_BURN_DAILY_CAP_USDG: "10000000000", NETWORK_FEE_BURN_TOKEN_ADDRESS: a(3) };
function reader(overrides: Record<string, unknown> = {}) {
  const expected: Record<string, unknown> = { "usdg()": a(2), "anyr()": a(3), "adapter()": a(4), "buybackPriceOracle()": a(5), "keeper()": a(6), "maxDailyBuyback()": 10_000_000_000n, "isCaller(address)": true };
  return { code: async (_: Address, block: bigint) => { expect(block).toBe(123n); return overrides.code ?? "0x6001"; }, read: async (_: Address, name: string, _args: unknown[], block: bigint) => { expect(block).toBe(123n); return name in overrides ? overrides[name] : expected[name]; } } as unknown as ChainReader;
}
test("optional network burn evidence certifies its own oracle, adapter, token, cap and keeper", async () => {
  expect(await verifyNetworkBurn({ ...manifest, contracts: {} }, reader(), 123n)).toEqual([]);
  const checks = await verifyNetworkBurn(manifest, reader(), 123n);
  expect(checks).toHaveLength(8); expect(checks.every(c => c.status === "pass")).toBe(true);
  expect(() => requireNetworkBurnEvidence(settings, checks)).not.toThrow();
  for (const change of [{ NETWORK_FEE_BURN_ORACLE_ADDRESS: a(7) }, { NETWORK_FEE_BURN_ADAPTER_ADDRESS: a(7) }, { NETWORK_FEE_BURN_DAILY_CAP_USDG: "1" }, { NETWORK_FEE_BURN_TOKEN_ADDRESS: a(7) }]) expect(() => requireNetworkBurnEvidence({ ...settings, ...change }, checks)).toThrow(/certify/);
  expect(() => requireNetworkBurnEvidence(settings, [])).toThrow(/certify/);
  expect(() => requireNetworkBurnEvidence({ ...settings, NETWORK_FEE_BURN_ENABLED: false }, [])).not.toThrow();
});
test("missing bytecode, mismatched route/cap/roles and unauthorized adapter fail evidence", async () => {
  for (const change of [{ code: "0x" }, { "buybackPriceOracle()": a(7) }, { "adapter()": a(7) }, { "keeper()": a(7) }, { "anyr()": a(7) }, { "usdg()": a(7) }, { "maxDailyBuyback()": 0n }, { "isCaller(address)": false }]) {
    const checks = await verifyNetworkBurn(manifest, reader(change), 123n);
    expect(checks.some(c => c.status === "fail")).toBe(true);
    expect(() => requireNetworkBurnEvidence(settings, checks)).toThrow(/certify/);
  }
});
test("disabled defaults need no new infrastructure and retired worker job is invalid in production", () => {
  expect(loadConfig({ ANYROUTE_ENV: "test", NETWORK_FEE_BURN_ADDRESS: "", NETWORK_FEE_BURN_ADAPTER_ADDRESS: "", NETWORK_FEE_BURN_ORACLE_ADDRESS: "" }).networkPayouts).toMatchObject({ burnEnabled: false, burnDailyCap: 0n });
  const worker = { ANYROUTE_ENV: "production", RUNTIME_ROLE: "worker", WORKER_JOBS: "buyback", AUTO_MIGRATE: "false", HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3), PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://sample:fixture-only-credential@localhost/test", REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: a(1), CALLPAY_ADDRESS: a(1), PROVIDER_BOND_ADDRESS: a(1), RECEIPT_ANCHOR_ADDRESS: a(1) };
  expect(() => loadConfig(worker)).toThrow(/valid WORKER_JOBS/);
  expect(loadConfig({ ...worker, WORKER_JOBS: "chain-indexer,health-flush,holds-expire,catalog-refresh,health-probes,provider-registry" }).workerJobs).toHaveLength(6);
});
