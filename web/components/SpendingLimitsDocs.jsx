import { GUARD_LIMIT } from '../lib/agent-guard';
import { LIMIT_WORDS as W } from '../lib/spending-limits';
// U102: one set of spending limits. Linked from the docs page by its owner; this component adds no route of its own.
export default function SpendingLimitsDocs() {
  return <section id="spending-limits"><h2>Spending limits</h2>
    <p>One editor sets spending limits wherever a key’s spending is controlled: Spending limits in the chat Tools panel, each agent on /agents, and Spending limits on any key in the dashboard’s API keys. The fields, words and order are the same in each place, and saving writes that key’s rulebook with PUT /api/v1/agents/:key_hash/policy. {W.scopeOnly}</p>
    <ul>
      <li>Cap per request, hour, day and week ($): caps.per_request_usd, per_hour_usd, per_day_usd and per_week_usd. Per request uses the router’s estimated cost. Hour, day and week are rolling windows that include requests still running. A blank cap adds no cap.</li>
      <li>Ask me first above ($): approval.above_usd. Above it, the router refuses with agent_approval_required until you approve on /agents or inline in chat; the approved request is then retried. Each approval is single use and expires.</li>
      <li>Stop and Resume: POST /api/v1/agents/:key_hash/kill and /resume. {W.stopHelp} They act on saved limits, so save limits first.</li>
      <li>Models, lanes and tools, on /agents and in the dashboard: the rulebook’s models, lanes and tools allow and deny lists. Deny wins.</li>
    </ul>
    <p>Chat uses a dedicated chat key. POST /api/v1/sessions creates it with a total (budget_usd, up to $1,000) and an expiry (ttl_minutes, 1 to 1,440), then its rulebook carries the caps and the ask-first amount. The total and expiry stay fixed for that chat key; caps and the ask-first amount can change. Remove spending limits revokes the chat key. It stays in that tab’s session storage, and anyone with access to the tab can use it.</p>
    <p>On /agents the editor also holds the rulebook’s other rules: maximum output tokens, asking first after a number of calls per rolling hour, what happens when a limit is reached, UTC windows, circuit breakers and alerts. The dashboard and chat editors keep those rules as they are when they save. A key’s own budget, set with Edit budget in the dashboard, still applies.</p>
    <p>Where Agent Guard is switched on, the editor adds an Actions section for the rulebook’s actions: cap per action, cap per day, actions per hour, ask me first above, and allowed or denied actions and targets. {GUARD_LIMIT}</p>
    <p>Only account management keys and team owners or admins can change spending limits. A session key cannot change its own.</p>
  </section>;
}
