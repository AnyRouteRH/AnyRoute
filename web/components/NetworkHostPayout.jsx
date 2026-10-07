export default function NetworkHostPayout({ payout }) {
  if (!payout) return null;
  return <section><h3>Accrued net host payments</h3>
    <p>{payout.accrued_net_band}</p>
    {payout.accrued_net_usdg_units !== undefined && <p>Accrued net USDG units: <code>{payout.accrued_net_usdg_units}</code> · {payout.decimals} decimals.</p>}
    <p>{payout.basis}</p><p>{payout.enabled ? 'Paid per token served.' : 'Network payouts are switched off.'} $ANYR burns are coming soon.</p>
  </section>;
}
