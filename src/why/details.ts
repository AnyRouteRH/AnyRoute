// K190: read existing decision events and the matching saved rulebook only.
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { keys } from '../db/schema.ts';
import { agentPolicies, agentPolicyEvents } from '../agents/schema.ts';
import { policyVersions } from '../agents/policy-versions-schema.ts';
import { rulebookParts } from '../agents/rulebook-words.ts';
import { picoToUsdString } from '../lib/money.ts';
import { breakerKillReason } from '../agents/breakers.ts';

export function refusalTarget(code: string, hash: string) {
  const base = '/agents/?agent=' + encodeURIComponent(hash);
  if (code === 'killed' || code.startsWith('breaker:')) return { href: base + '#agent-status-stop', action: 'Review Stop and resume' };
  if (code.includes('work_hours')) return { href: base + '#agent-status-hours', action: 'Change work hours' };
  if (code.startsWith('approval')) return { href: base + '#approvals', action: 'Review waiting approvals' };
  return { href: base + '&focus=limits#rulebook', action: 'Change spending limits and rules' };
}
const partFor = (code: string) => code === 'model_not_allowed' ? 'models' : code === 'lane_not_allowed' ? 'lanes'
  : code === 'max_tokens' ? 'tokens' : code.includes('work_hours') ? 'hours' : code === 'outside_window' ? 'hours'
  : code === 'approval_calls_per_hour' ? 'calls' : code === 'approval_action_amount' ? 'actions' : code.startsWith('approval') ? 'ask' : code.startsWith('breaker:') ? 'breakers' : code.includes('tool') ? 'tools'
  : code.includes('action') || code === 'target_not_allowed' ? 'actions' : 'caps';

export async function readRefusal(ctx: Ctx, accountId: string, id: string, type: string) {
  if (!ctx.cfg.agentPolicyEnabled || !/^[1-9]\d{0,14}$/.test(id)) return null;
  const [event] = await ctx.db.select({ event: agentPolicyEvents }).from(agentPolicyEvents)
    .innerJoin(keys, eq(keys.keyHash, agentPolicyEvents.keyHash))
    .where(and(eq(agentPolicyEvents.id, Number(id)), eq(keys.accountId, accountId))).limit(1);
  const row = event?.event;
  if (!row || row.kind !== 'decision' || !['deny', 'approval_required'].includes(row.decision ?? '')) return null;
  const reasons = row.reasons as { code: string; message: string }[];
  const actualType = reasons.some(r => r.code === 'killed') || breakerKillReason({ reasons }) ? 'agent_killed'
    : row.decision === 'approval_required' ? 'agent_approval_required' : 'agent_policy_denied';
  if (actualType !== type) return null;
  const [version] = await ctx.db.select({ spec: policyVersions.spec }).from(policyVersions)
    .where(and(eq(policyVersions.keyHash, row.keyHash), eq(policyVersions.sha256, row.policySha256))).orderBy(desc(policyVersions.id)).limit(1);
  const [current] = version ? [] : await ctx.db.select({ spec: agentPolicies.spec }).from(agentPolicies)
    .where(and(eq(agentPolicies.keyHash, row.keyHash), eq(agentPolicies.sha256, row.policySha256))).limit(1);
  const policy = version?.spec ?? current?.spec;
  const parts = policy ? rulebookParts(policy) : [];
  const rules = [...new Set(reasons.flatMap(reason => parts.filter(part => part.part === partFor(reason.code)).map(part => part.text)))];
  const intent = row.intent as Record<string, unknown> | null;
  const facts: string[] = [];
  // These are recorded estimates, not charges or reconstructed rolling balances.
  for (const [field, label] of [['est_cost_pico', 'Estimated request cost'], ['price_pico', 'Tool price'], ['amount_pico', 'Requested action amount']] as const) {
    const amount = intent?.[field];
    if (typeof amount === 'string' && /^\d+$/.test(amount)) facts.push(`${label}: $${picoToUsdString(BigInt(amount))}`);
  }
  if (typeof intent?.max_output_tokens === 'number') facts.push(`Requested output limit: ${intent.max_output_tokens} tokens`);
  if (typeof intent?.model === 'string') facts.push(`Requested model: ${intent.model}`);
  return { recorded_at: row.ts.toISOString(), reasons: reasons.map(reason => ({ text: reason.code === 'killed' ? 'This agent was stopped.' : reason.message, ...refusalTarget(reason.code, row.keyHash) })), facts, rules,
    note: 'These are the recorded request details and saved rules. Rolling spend and held amounts at refusal are not retained in this event. Rules and Stop settings may have changed since then.' };
}
