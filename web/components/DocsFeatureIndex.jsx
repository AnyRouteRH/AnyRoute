const sections = [
  ["signed-in-browsers", "Signed-in browsers"], // E147
  ["model-performance", "Sort models by speed and reliability"], // E150
  ["model-pages", "A page for every model"], // E151
  ["reliability-report", "Your reliability report"], // E155
  ["read-only-keys", "Read-only keys for accountants and dashboards"], // E149
  ["key-ip-allowlist", "Allowed IP addresses for keys"], // E148
  ["linked-wallets", "Link another wallet"], // E154
  ["saved-answers", "Save answers in Chat"], // D140
  ["chat-folders", "Organize Chat into folders"], // D143
  ["share-to-anyroute", "Share to Anyroute from your phone"], // D137
  ["telegram-photos", "Send photos in Telegram"], // D142
  ["telegram-balance-spend", "Check balance and spend in Telegram"], // E152
  ["quiet-agent-alerts", "Quiet-agent alerts"], // D141
  ["security-alerts", "Security alerts"], // D138
  ["notifications", "Notifications"], // E146
  ["idempotency", "Retry without paying twice"], // D145
  ["scheduled-prompts", "Scheduled prompts"], // D136
  ["chat-cost", "This chat’s cost"], // C128
  ["copy-as-code", "Copy a Chat conversation as code"], // C130
  ["key-expiry", "Keys that expire"], // C127
  ["getting-started", "Getting started"], // C135
  ["context-meter", "Keep room in Chat"], // C129
  ["agent-spend-glance", "Agent spend at a glance"], // C132
  ["appearance", "Choose light or dark"], // C126
  ["new-models", "New models this week"], // C131
  ["projects", "Project tags"], // C134
  ["project-budgets", "Project budgets"], // D139
  ["price-notices", "Model price change notices"], // C133
  ["unused-keys", "Review unused keys"], // B125
  ["proof-pack", "Proof pack"], // B122
  ["deposit-countdown", "Deposit countdown and credit notices"], // B123
  ["errors", "Similar models when a model is unavailable"], // B121
  ["stop-until", "Stop for a while"], // B117
  ["balance-runway", "Balance runway and alerts"], // B119
  ["spending-limits", "Spending limits"],
  ["default-route", "Default route"],
  ["lane-report", "Lane report"],
  ["starter-setups", "Starter setups"],
  ["auto-topup", "Auto top-up"],
  ["replay-rules", "Replay your rules"],
  ["playbooks", "Playbooks"],
  ["rulebook-words", "Rulebooks in plain English"], // B124
  ["rulebook-history", "Rulebook history"], // D144
  ["agent-rulebook", "Agent rulebook"],
  ["agent-approvals", "Ask-first approvals"],
  ["approvers", "Let teammates approve"], // E153
  ["approve-and-allow", "Allow this next time"], // B118
  ["agent-pay", "Pay another agent"],
  ["trading-agents", "Trading agents"],
  ["decision-tags", "Decision tags"],
  ["agent-breakers", "Circuit breakers"],
  ["agent-autonomy", "Progressive autonomy"],
  ["agent-ledger", "Activity & receipts"],
  ["agent-alerts", "Agent alerts"],
  ["weekly-summary", "Weekly Telegram summary"], // B120
  ["agent-certificates", "Track-record certificates"],
  ["agent-profiles", "Public profiles & directory"],
  ["agent-identity", "Identity, paid reputation & liveness"],
  ["agreements", "Agent agreements · live, with jury rulings"],
  ["sealed-agents", "Sealed agent hosting"],
  ["e2ee-phala", "Encrypted chat"],
  ["network-host-signup", "Host signup"],
  ["network-host-policy", "Host policy"],
  ["network-payouts", "Host payouts"],
  ["host-bonds", "Host bonds (switched off)"],
  ["network-stats", "Live network statistics"],
  ["commerce-stats", "Commerce ledger"],
];

export function DocsFeatureLinks() {
  return sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>);
}

export default function DocsFeatureIndex() {
  return <section id="whats-new">
    <h2>What’s new</h2>
    <p>Agent rules, Telegram linking and approvals, opt-in public profiles and encrypted chat are switched on at anyroute.tech. Sealed agent hosting is available, but no sealed agent is registered at anyroute.tech yet. Agreements are switched on, with the escrow and dispute contracts deployed on Robinhood Chain; automatic jury rulings are switched on: three models on attested hardware rule by two of three, and the signed ruling is posted on-chain; a hung jury goes to the panel, and anything unruled after 30 days settles 50/50. The network is open for early hosts running the approved build, with automatic admission and probation. Live network statistics and host bond indexing are switched on; payouts and slashing are not switched on at anyroute.tech yet, and $ANYR burns are coming soon. The commerce ledger, which shows filtered settlement figures next to gross ones, is built but not switched on at anyroute.tech yet.</p>
    <ul>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul>
  </section>;
}
