export default function SealNetworkDocs() {
  return <section id="open-network">
    <h2>The open host network.</h2>
    <p>Anyroute Network is open for early hosts running <code>deploy/network/approved/tdx-qwen2.5-0.5b</code>: Intel TDX in a supported confidential VM serving Qwen2.5 0.5B. <a href="/network/#join">Join with one command</a>. Admission is automatic after fresh hardware evidence, the signed host policy v1 and sanctions screening of operator and payout addresses pass. The policy is published at <code>GET /api/v1/network/policy</code> and committed as a <code>host_policy</code> entry in the key log.</p>
    <p>New hosts start on probation, with a public record on <a href="/hosts/">Hosts</a>. Sidecar bindings v2 commit the source archive hash, engine image and served model ID into report data. Legacy v1 evidence still verifies but does not supply every field this admission policy requires. These bindings do not prove that a declared engine image is running or that a source archive produced it; appraising the measured deployment remains necessary.</p>
    <p>Hosts post no bond or deposit at anyroute.tech: admission is by hardware attestation, and traffic follows each host’s record. Payouts, fee buy-and-burn and slashing are not switched on at anyroute.tech yet. No payouts are being made. <a href="/docs/#network-host-policy">Read the host policy and limits</a>.</p>
  </section>;
}
