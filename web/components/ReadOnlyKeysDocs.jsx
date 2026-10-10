// E149
export default function ReadOnlyKeysDocs() {
  return <section id="read-only-keys"><h2>Read-only keys</h2>
    <p>Give an accountant or dashboard access to your account’s activity, statements and rulebooks with a read-only key. It can see these records, but cannot spend or change anything. Create one in Keys with your owner or management key. You can also limit it to allowed IP addresses.</p>
    <p>Send <code>POST /api/v1/keys</code> with your management Bearer key and <code>{'{ scope: "read", name: "Accounting" }'}</code>. The secret is shown once. Scope is fixed at creation; omit management and team. Read-only keys keep the existing expiry, disable and IP checks. Set IP restrictions with <code>PATCH /api/v1/keys/:hash</code> using a management key.</p>
    <p>A read key has owner read visibility on explicitly allowed GET routes: activity (including CSV), balances, spending and runway, insights, statements, lane report, proof pack and limits, agent lists, approval lists, rulebooks, history, events and ledgers, playbooks, key lists and details, inbox, generations, models and status. Existing feature switches and account ownership checks still apply. Other routes return <code>403 read_only_key</code>, including paid GET tools, every POST, PUT, PATCH and DELETE, approvals, Stop and Resume, schedules, budgets, wallet and deposit actions, secret access and unknown routes. New routes are refused until explicitly listed.</p>
    <p>No extra switch is needed. Ordinary and inference-only keys keep their existing access. Account records can include readable rules and activity details; share this key only with someone who should see them. Ordinary inference still passes request text through the router in memory.</p>
  </section>;
}
