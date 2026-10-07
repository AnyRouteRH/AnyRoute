export default function NetworkPayoutDocs() {
  return <section id="network-payouts"><h2>Network host payments</h2>
    <p>Payouts are not switched on at anyroute.tech yet. No payouts are being made. $ANYR burns are coming soon.</p>
    <h3>How payouts work</h3>
    <p>When enabled, hosts are paid per token served only from receipts included in their confirmed per-host roots. Runtime availability is reported by <code>network.payouts_open</code> in <code>GET /api/v1/status</code>.</p>
    <h3>Settings</h3>
    <p>For self-hosted routers: <code>NETWORK_PAYOUTS_ENABLED=false</code> by default, and switching it on requires sanctions screening, host anchoring and a settlement worker signer. The <code>NETWORK_FEE_BURN_*</code> settings are off by default and are not switched on at anyroute.tech. Unresolved or reverted payouts require operator reconciliation.</p>
  </section>;
}
