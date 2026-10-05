// U113: auto top-up of a key's total budget from the account's credits. Linked from the docs feature index.
export default function AutoTopupDocs() {
  return <section id="auto-topup"><h2>Auto top-up</h2>
    <p>A key’s total budget (its <code>limit</code>) stops an agent when it runs out, until someone raises it. Auto top-up keeps the agent going without handing it your whole account: “When this key has less than $X of budget left, add $Y from your account credits, at most $Z per week.” Set it in Spending limits on any key under API keys, in the Auto top-up row under the total budget, or with PATCH /api/v1/keys/:hash:</p>
    <pre><code>{`PATCH /api/v1/keys/:hash
{ "topup": { "below_usd": 2, "add_usd": 10, "max_per_week_usd": 50 } }`}</code></pre>
    <ul>
      <li><strong>No money moves.</strong> The total budget is an allowance on your account’s own credits. A top-up only raises that allowance, and only while the account’s available credits (its balance less requests still running) cover the key’s whole remaining allowance after it.</li>
      <li><strong>When it runs.</strong> After a charge leaves the key with less than <code>below_usd</code>, and when the key’s budget would refuse a request while it has less than <code>below_usd</code> left, so a key stopped at its budget carries on once your account or the week allows. The router handles one account’s charges one at a time, so requests that cross the line together make one top-up.</li>
      <li><strong>The week.</strong> <code>max_per_week_usd</code> counts top-ups from Monday 00:00 to Sunday 24:00 UTC. Once it is reached, the key waits for the next week or for you to raise its budget.</li>
      <li><strong>Limits.</strong> <code>below_usd</code> and <code>add_usd</code> from $0.01 to $1,000, <code>max_per_week_usd</code> up to $5,000, and <code>add_usd</code> no more than <code>max_per_week_usd</code>. The key needs a total budget that does not reset (no <code>limit_reset</code>). In a team with an org budget, a top-up must still fit in it. <code>topup: null</code> turns auto top-up off.</li>
      <li><strong>Every top-up is recorded.</strong> Each one shows in Activity under Top-ups and in your inbox, for example “Topped up Research agent by $10; $40 left this week”. When the router skips one, the inbox says why, once: not enough account credits, the weekly maximum, or the team budget. GET /api/v1/keys/:hash shows the rule and <code>topups_this_week_usd</code>, the top-ups added since Monday.</li>
    </ul>
    <p>Auto top-up is not a cap. The caps per request, hour, day and week in the key’s rulebook still apply to every request, before and after a top-up; a top-up raises the total budget only. Choose a <code>below_usd</code> at least as large as one request’s estimated cost, so a request rarely waits for a top-up.</p>
  </section>;
}
