export default function SealNetworkDocs() {
  return <section id="open-network">
    <h2>The open host network.</h2>
    <p>AnyRoute Network is open for early hosts running <code>deploy/network/approved/tdx-qwen2.5-0.5b</code>: Intel TDX in a supported confidential VM serving Qwen2.5 0.5B. <a href="/network/#join">Join with one command</a>. Admission is automatic after fresh hardware evidence, the signed host policy v1 and sanctions screening of operator and payout addresses pass. The policy is published at <code>GET /api/v1/network/policy</code> and committed as a <code>host_policy</code> entry in the key log.</p>
    <p>New hosts start on probation, with a public record on <a href="/hosts/">Hosts</a>. Sidecar bindings v2 commit the source archive hash, engine image and served model ID into report data. Legacy v1 evidence still verifies but does not supply every field this admission policy requires. These bindings do not prove that a declared engine image is running or that a source archive produced it; appraising the measured deployment remains necessary.</p>
    <p>Bonds are read from <a href="https://robinhoodchain.blockscout.com/address/0x2921d34fd86d3323a5369a270a82814a74250518">HostBond on Robinhood Chain</a>, with a minimum of 5,000 USDG, and indexed at <code>GET /api/v1/network/bonds</code>. Payouts, fee buy-and-burn and slashing are not switched on at anyroute.tech yet. No payouts are being made. <a href="/docs/#network-host-policy">Read the host policy and limits</a>.</p>
  </section>;
}
