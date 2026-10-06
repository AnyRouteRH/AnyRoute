// B124: existing approval metadata and current policy only, never prompts or tool arguments.
import type { ApprovalRow } from './approvals.ts';
import type { AgentPolicy } from './policy.ts';
import { rulebookApprovalLine } from './rulebook-words.ts';
import { picoToUsdString } from '../lib/money.ts';
const plain = (value: unknown) => String(value ?? '').replace(/[\r\n\t]/g, ' ');
export function plainApprovalText(row: ApprovalRow, policies: { policy: AgentPolicy; inherited: boolean }[], name?: string): string {
  const intent = row.intent as { intents?: Record<string, unknown>[] } & Record<string, unknown>;
  const intents = intent.intents ?? [intent];
  const details = intents.map(i => i.kind === 'action' ? `Action: ${plain(i.action)}${i.target === undefined ? '' : `; target: ${plain(i.target)}`}${i.amount_pico === undefined ? '' : `; amount: $${picoToUsdString(BigInt(String(i.amount_pico)))}`}${i.details_sha256 === undefined ? '' : `; details fingerprint: ${plain(i.details_sha256)}`}`
    : i.kind === 'inference' ? `Model: ${plain(i.model)}; lane: ${plain(i.lane)}${Array.isArray(i.tools) && i.tools.length ? `; declared tools: ${i.tools.map(plain).join(', ')}` : ''}`
    : i.kind === 'mcp_tool' ? `Declared tool: ${plain(i.name)}`
    : i.kind === 'paid_tool' ? `Paid tool: ${plain(i.resource)}; seller: ${plain(i.seller)}` : 'Request details unavailable');
  const summaries = policies.map(p => `${p.inherited ? 'Inherited: ' : ''}${rulebookApprovalLine(p.policy, intents.some(i => i.kind === 'action')).replace(/^Rulebook: /, '')}`);
  const detailText = details.join('\n');
  return [`Anyroute: your agent asks first`, `Approval: ${row.id}`, `Agent: ${plain(name || 'Unnamed agent').slice(0, 100)}`, detailText.length > 2600 ? detailText.slice(0, 2600) + '… (more details on Agents)' : detailText,
    `Maximum cost: $${picoToUsdString(row.maxCostPico)}`,
    `Rulebook: ${summaries.length ? summaries.join(' · ') : 'unavailable'}`,
    `Expires: ${row.expiresAt.toISOString()}`, `Status: ${['pending', 'approved'].includes(row.status) && row.expiresAt <= new Date() ? 'expired' : row.status}`].join('\n');
}
