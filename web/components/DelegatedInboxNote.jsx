// E153
export default function DelegatedInboxNote({ page }) {
  return page?.scope === 'team_approvals' && <p className="help-text">Your key’s events and agent requests you may approve. Owners and admins manage rule changes.</p>;
}
