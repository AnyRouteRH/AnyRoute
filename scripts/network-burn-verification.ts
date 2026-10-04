import type { Address } from "viem";
import type { ChainReader, Check, DeploymentManifest } from "./deployment-verification.ts";

/** Optional planned executor: certify its independent route and authorities at the verifier snapshot. */
export async function verifyNetworkBurn(m: DeploymentManifest, reader: ChainReader, block: bigint): Promise<Check[]> {
  const address = m.contracts.networkFeeBurn;
  if (!address) return [];
  const checks: Check[] = [];
  const expected: Record<string, unknown> = {
    usdg: m.contracts.usdg, anyr: m.contracts.anyrToken, keeper: m.roles.keeper,
    adapter: m.contracts.networkFeeBurnAdapter, buybackPriceOracle: m.contracts.networkFeeBurnOracle,
    maxDailyBuyback: m.params.networkFeeBurnDailyCap,
  };
  for (const [name, value] of Object.entries(expected)) {
    try {
      const actual = await reader.read(address, `${name}()`, [], block);
      const cap = name === "maxDailyBuyback";
      const valid = cap ? /^\d+$/.test(String(value)) && BigInt(String(value)) > 0n && String(actual) === String(value)
        : typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value) && String(actual).toLowerCase() === value.toLowerCase();
      checks.push({ id: `networkBurn.${name}`, status: valid ? "pass" : "fail", evidence: actual === undefined ? null : String(actual) });
    } catch { checks.push({ id: `networkBurn.${name}`, status: "fail", evidence: { category: "rpc_error" } }); }
  }
  try {
    const oracle = expected.buybackPriceOracle as Address;
    const code = oracle && await reader.code(oracle, block);
    checks.push({ id: "networkBurn.oracle_code_present", status: code && code !== "0x" ? "pass" : "fail", evidence: { address: oracle ?? null } });
    const adapter = expected.adapter as Address;
    const authorized = adapter && await reader.read(adapter, "isCaller(address)", [address], block);
    checks.push({ id: "networkBurn.adapter_authorized", status: authorized === true ? "pass" : "fail", evidence: { adapter: adapter ?? null, caller: address } });
  } catch { checks.push({ id: "networkBurn.infrastructure", status: "fail", evidence: { category: "rpc_error" } }); }
  return checks;
}
