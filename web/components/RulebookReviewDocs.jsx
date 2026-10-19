// K189
export default function RulebookReviewDocs() {
  return <section id="rulebook-review"><h2>Review rulebook changes</h2>
    <p>On Agents, edit Spending limits or Who can approve, then choose Review changes. You see the difference from the saved settings in the same words as rulebook history. Save applies the edit; Back keeps your draft so you can change it. With no changes, Save is disabled and says Nothing to save.</p>
    <p>Rulebook review also replays the draft against recorded calls and Agent Guard actions from the last 7 days when replay is available. It shows how many would have been refused or sent to ask first, along with the existing replay’s reasons and limits. A replay failure does not save anything or prevent an explicit Save. Approver changes are reviewed separately and cannot be replayed.</p>
    <p>This browser step reuses POST /api/v1/agents/:key_hash/replay with {`{policy, days: 7}`}; only the final Save calls PUT /api/v1/agents/:key_hash/policy or PUT /api/v1/agents/:key_hash/approvers. Each retains its existing Bearer authentication and owner/admin management permissions. Read-only keys cannot use these routes. There is no new endpoint, field, storage, migration, flag or background job. The editor does not change direct API saves, restores or playbook updates.</p>
    <p>Replay checks the draft alone, using the records available to the existing replay API; inherited rules still apply to live calls. It cannot know which requests you would have approved. Rules cover requests through Anyroute only. The router reads ordinary request text in memory.</p>
  </section>;
}
