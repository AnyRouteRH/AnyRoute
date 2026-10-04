export default function NetworkBondsNote() {
  return <section id="bonds">
    <h2>No deposits</h2>
    <p>Hosts post no bond or deposit at anyroute.tech. Admission comes from fresh hardware attestation checked against the signed host policy. Traffic then follows each host’s record: probation first, then uptime, error rate and latency. A host that fails its checks gets no traffic, and requests go to other hosts.</p>
    <p>Host bonds are switched off at anyroute.tech; the HostBond contract on Robinhood Chain (<a href="https://robinhoodchain.blockscout.com/address/0x2921d34fd86d3323a5369a270a82814a74250518"><code>0x2921d34fd86d3323a5369a270a82814a74250518</code></a>) is not used by this router. Payouts, fee buy-and-burn and slashing are not switched on at anyroute.tech yet. No payouts are being made. <a href="/docs/#network-host-policy">Read the host policy and limits</a>.</p>
  </section>;
}
