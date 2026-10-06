// B124: summaries use the policies already returned by the authenticated agent list.
import { rulebookApprovalLine } from '../../lib/rulebook-words';
export default function ApprovalRulebook({ agent, intent }) {
  const policies = agent?.policies ?? [];
  return policies.length ? <div>{policies.map((row, index) => <p key={row.key_hash ?? index} style={{ overflowWrap: 'anywhere' }}>{row.inherited ? 'Inherited · ' : ''}{rulebookApprovalLine(row.policy, intent?.kind === 'action' || intent?.intents?.some(i => i.kind === 'action'))}</p>)}</div> : <p>Rulebook: unavailable</p>;
}
