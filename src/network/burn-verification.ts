type Settings = { NETWORK_FEE_BURN_ENABLED: boolean; NETWORK_FEE_BURN_ADDRESS?: string; NETWORK_FEE_BURN_ADAPTER_ADDRESS?: string; NETWORK_FEE_BURN_ORACLE_ADDRESS?: string; NETWORK_FEE_BURN_DAILY_CAP_USDG: string; NETWORK_FEE_BURN_TOKEN_ADDRESS: string };
export function requireNetworkBurnEvidence(e: Settings, checks: { id?: unknown; status?: unknown; evidence?: any }[]) {
  if (!e.NETWORK_FEE_BURN_ENABLED) return;
  const expected = { adapter: e.NETWORK_FEE_BURN_ADAPTER_ADDRESS, buybackPriceOracle: e.NETWORK_FEE_BURN_ORACLE_ADDRESS, maxDailyBuyback: e.NETWORK_FEE_BURN_DAILY_CAP_USDG, anyr: e.NETWORK_FEE_BURN_TOKEN_ADDRESS };
  for (const [name, value] of Object.entries(expected)) {
    const check = checks.find(c => c.id === `networkBurn.${name}`);
    if (check?.status !== "pass" || String(check.evidence).toLowerCase() !== String(value).toLowerCase()) throw new Error("DEPLOYMENT_VERIFICATION must certify the network fee executor's configured adapter, oracle, token and daily cap.");
  }
  for (const name of ["oracle_code_present", "adapter_authorized", "keeper", "usdg"]) {
    if (checks.find(c => c.id === `networkBurn.${name}`)?.status !== "pass") throw new Error("DEPLOYMENT_VERIFICATION must certify the network fee executor's infrastructure and roles.");
  }
}
