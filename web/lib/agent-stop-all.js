// H172: one confirmed request, using the existing browser-local Stop presets.
import { stopUntil } from './stop-until.js';
export const bulkAgents = agents => agents.filter(agent => agent.has_policy && !agent.approval_only);
export function bulkQuestion(action, count, until) {
  return action === 'stop-all'
    ? `Stop all ${count} agents? New requests through Anyroute will be refused ${until ? 'until ' + new Date(until).toLocaleString() : 'until you resume'}. Already-stopped agents keep their current duration. Requests already running may finish.`
    : `Resume all stopped agents you can manage? Their rulebook limits still apply.`;
}
export async function confirmAllStops(action, preset, count, confirm, request, now = new Date()) {
  if (!['stop-all', 'resume-all'].includes(action)) throw new Error('Choose Stop all agents or Resume all.');
  const until = action === 'stop-all' ? stopUntil(preset, now) : undefined;
  if (!confirm(bulkQuestion(action, count, until))) return null;
  const { data } = await request('/api/v1/agents/' + action, { method: 'POST', ...(action === 'stop-all' ? { body: until ? { until } : {} } : {}) });
  return data;
}
