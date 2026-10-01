export default function NetworkBondsNote() {
  return <section id="bonds">
    <h2>Bonds</h2>
    <p>Host bonds are indexed live from HostBond on Robinhood Chain at <a href="https://robinhoodchain.blockscout.com/address/0x2921d34fd86d3323a5369a270a82814a74250518"><code>0x2921d34fd86d3323a5369a270a82814a74250518</code></a>. The minimum is 5,000 USDG. Read the indexed state at <code>GET /api/v1/network/bonds</code> or on <a href="/hosts/">Hosts</a>.</p>
    <p>Payouts, fee buy-and-burn and slashing are not switched on at anyroute.tech yet. No payouts are being made. A bond is a work deposit; it promises no payment. <a href="/docs/#host-bonds">Read the bond rules and limits</a>.</p>
  </section>;
}
