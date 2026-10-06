// B118: the server supplies the exact change and the policy hash confirmed by the owner.
export const allowPath = id => '/api/v1/agents/approvals/' + encodeURIComponent(id) + '/approve-and-allow';
export const readAllowChange = (request, id, signal) => request(allowPath(id), { signal });
export const confirmAllowChange = (request, id, change) => request(allowPath(id), { method: 'POST', body: { policy_sha256: change.policy_sha256 } });
export function allowChangeText(change) {
  const label = change.field === 'actions.approval_above_usd' ? 'this action was' : 'this model call was estimated at';
  return `Ask-first amount: $${change.before_usd} → $${change.after_usd} (${label} $${change.amount_usd})`;
}
export const playbookAllowLink = id => '/dashboard/?playbook=' + encodeURIComponent(id) + '#playbooks';
