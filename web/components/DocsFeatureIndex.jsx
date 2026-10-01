const sections = [
  ["agent-rulebook", "Agent rulebook"],
  ["agent-approvals", "Ask-first approvals"],
  ["agent-breakers", "Circuit breakers"],
  ["agent-autonomy", "Progressive autonomy"],
  ["agent-ledger", "Activity & receipts"],
  ["agent-alerts", "Agent alerts"],
  ["agent-certificates", "Track-record certificates"],
  ["sealed-agents", "Sealed agent hosting"],
  ["e2ee-phala", "Encrypted chat"],
  ["network-host-signup", "Host signup"],
  ["network-host-policy", "Host policy"],
  ["network-payouts", "Host payouts"],
  ["host-bonds", "Host bonds"],
];

export function DocsFeatureLinks() {
  return sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>);
}

export default function DocsFeatureIndex() {
  return <section id="whats-new">
    <h2>What’s new</h2>
    <p>Agent rules and encrypted chat are switched on at anyroute.tech. The network is open for early hosts running the approved build, with automatic admission and probation. Host bonds are indexed; payouts, fee buy-and-burn and slashing are not switched on at anyroute.tech yet.</p>
    <ul>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul>
  </section>;
}
