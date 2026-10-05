import { PLAYBOOK_WORDS as W } from '../lib/playbooks';
// U115: playbooks, one rulebook many keys follow. Rendered once on /docs, after Spending limits, Default route and Starter setups.
export default function PlaybooksDocs() {
  return <section id="playbooks"><h2>Playbooks</h2>
    <p>{W.intro} Make and change playbooks in the dashboard under Keys &amp; limits, then Playbooks; choose which keys follow one from a key’s spending limits there or on /agents. A playbook starts from a starter setup, from a key’s current rules or from no rules, and is edited in the same spending limits editor.</p>
    <ul>
      <li>GET /api/v1/playbooks lists them, with how many keys follow each and which of those keys you manage. POST /api/v1/playbooks takes a name and a policy, the same rulebook body as PUT /api/v1/agents/:key_hash/policy; a management key can add team_id.</li>
      <li>GET /api/v1/playbooks/:id adds its recorded changes. PUT /api/v1/playbooks/:id takes a new name, new rules or both; new rules raise version by one and change sha256, the SHA-256 of the canonical rules.</li>
      <li>POST /api/v1/agents/:key_hash/playbook with playbook_id makes that key follow the playbook; playbook_id null stops following.</li>
      <li>DELETE /api/v1/playbooks/:id is refused with playbook_followed and the number of following keys while any follow it. With ?unlink=copy each of those keys keeps the rules as its own.</li>
    </ul>
    <p>A following key’s rules are the playbook’s current version. A change is copied to every following key in the same transaction and under the same account lock as each request’s rule check, so every key uses it from its next request, exactly as when one key’s own rulebook is saved. Each following key’s event log records the change with the new sha256.</p>
    <p>A key follows one playbook or keeps its own rules, never both: changing or removing a following key’s own rulebook is refused with playbook_linked. Stopping following keeps the playbook’s current rules as the key’s own, so nothing loosens. Following replaces the key’s own rules with the playbook’s. Stop and Resume, spend and progressive autonomy stay per key.</p>
    <p>A team owner or admin makes and changes its team’s playbooks, which only that team’s keys can follow. Account-wide playbooks change only with a management key; team owners and admins can read them and have their keys follow them. Viewers, devs and agent keys cannot read or change playbooks. Every change is recorded with its version and sha256. For a team, it is also in the team’s audit log, and a change of rules appears in the inbox of the team’s owners and admins: “Playbook X changed; N keys follow it”.</p>
    <p>Playbooks use the rulebook switch, AGENT_POLICY_ENABLED, which defaults to false; with it off, these routes return 404. Like every rulebook, a playbook covers requests through Anyroute only.</p>
  </section>;
}
