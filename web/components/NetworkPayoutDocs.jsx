const SETTINGS = [
  ["NETWORK_PAYOUTS_ENABLED", "false", "Needs sanctions screening, host anchoring and a settlement worker signer when switched on."],
  ["NETWORK_FEE_BURN_ENABLED", "false", <>Needs a keeper signer, its own reviewed oracle, adapter, daily USDG cap and <code>NETWORK_FEE_BURN_ADDRESS</code>.</>],
  ["NETWORK_FEE_BURN_ADAPTER_ADDRESS", "none", "Must be set before the fee keeper runs."],
  ["NETWORK_FEE_BURN_ORACLE_ADDRESS", "none", "Must be set before the fee keeper runs."],
  ["NETWORK_FEE_BURN_DAILY_CAP_USDG", "0", "In USDG base units. A zero cap disables swaps."],
  ["NETWORK_FEE_BURN_TOKEN_ADDRESS", "official $ANYR", "The token the fee buys."],
  ["NETWORK_FEE_BPS", "500", "Bounded to 0–2000. The configured percentage is shown at runtime."],
];

export default function NetworkPayoutDocs() {
  return <section id="network-payouts"><h2>Network host payments</h2>
    <p>Payouts and fee buy-and-burn are not switched on at anyroute.tech yet. No payouts are being made.</p>
    <h3>How payouts work</h3>
    <p>When enabled, hosts are paid per token served only from receipts included in their confirmed per-host roots. The planned weekly USDG payments deduct the network fee: the planned 5% network fee buys and burns $ANYR. Both accrual and the fee keeper are switched off by default; runtime availability is reported by <code>network.payouts_open</code> in <code>GET /api/v1/status</code>.</p>
    <h3>Settings</h3>
    <table className="docs-table">
      <thead><tr><th>Setting</th><th>Default</th><th>Notes</th></tr></thead>
      <tbody>{SETTINGS.map(([name, value, note]) => <tr key={name}><td><code>{name}</code></td><td>{value}</td><td>{note}</td></tr>)}</tbody>
    </table>
    <h3>Fee buy-and-burn</h3>
    <p>The dedicated executor must be deployed, authorized by the existing adapter and funded with fee USDG; nothing funds it automatically. The keeper checks the executor’s own oracle minimum and an optional independent TWAP, plus its daily limit. Owner-only adapter, oracle, keeper and cap changes emit events.</p>
    <p>Acquired $ANYR goes to the dead address because AnyrToken has no holder burn function; total supply is unchanged. Aggregate fees and recent swap and burn transactions are public through <code>GET /api/v1/network/burns</code>.</p>
    <p>Sub-unit conversion dust remains unswapped. Periods above the per-run or remaining daily limit wait; unresolved or reverted payouts require operator reconciliation.</p>
  </section>;
}
