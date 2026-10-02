// V85: fixed starting limits. Templates don't pin model ids (catalogues change); spending caps, lanes and tools carry the safety.
const rulebook = (caps, extra = {}) => ({
  version: 1, models: {}, lanes: ['public'],
  caps: { per_request_usd: 0.02, per_hour_usd: 0.1, per_day_usd: 0.5, per_week_usd: 2, max_output_tokens: 512, ...caps },
  tools: { allow: [] }, approval: { above_usd: 0.01 },
  breakers: { max_requests_per_minute: 5, max_denials_per_10min: 3 },
  on_breach: 'deny', ...extra,
});
export const STARTER_RULEBOOKS = [
  { id: 'research', name: 'Research assistant', description: 'Low spending caps and no declared tools: room to read and summarise, not to run up a bill.', policy: rulebook({}) },
  { id: 'coding', name: 'Coding agent', description: 'More room for long code answers. Ask first above two cents.', policy: rulebook({ per_request_usd: 0.1, per_hour_usd: 0.5, per_day_usd: 2, per_week_usd: 8, max_output_tokens: 4096 }, { approval: { above_usd: 0.02 } }) },
  { id: 'shopping', name: 'Shopping and payments agent', description: 'Ask first above a tenth of a cent. Allow weekday requests only during the chosen UTC hours. Payment tools stay denied until you edit the rulebook.', policy: rulebook({ per_request_usd: 0.01, per_hour_usd: 0.05, per_day_usd: 0.1, per_week_usd: 0.5 }, { approval: { above_usd: 0.001 }, windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] }) },
  { id: 'support', name: 'Customer support bot', description: 'Keep replies short and capped. Show budget and denial alerts in the agent feed.', policy: rulebook({ per_request_usd: 0.01, per_hour_usd: 0.2, per_day_usd: 1, per_week_usd: 5, max_output_tokens: 256 }, { approval: { above_usd: 0.005 }, alerts: { at_percent: [50, 80, 100], denials_in_10min: 3, channels: [] } }) },
  { id: 'private', name: 'Proven hardware only', description: 'Require the attested lane and its existing hardware checks. Ordinary requests remain readable by the router and answering provider; this rulebook does not enable encrypted chat.', policy: rulebook({}, { lanes: ['attested'] }) },
  { id: 'experiment', name: 'Experiment safely', description: 'Keep the daily cap at five cents. Stop future requests on a breach or the first circuit breaker trip; the owner must resume.', policy: rulebook({ per_request_usd: 0.01, per_hour_usd: 0.02, per_day_usd: 0.05, per_week_usd: 0.2, max_output_tokens: 256 }, { approval: { above_usd: 0.005 }, breakers: { max_spend_usd_per_minute: 0.02, max_requests_per_minute: 2, max_denials_per_10min: 1 }, on_breach: 'kill' }) },
];

// Describe every restriction, including what remains unrestricted, from the applied data.
export function starterSettings(policy) {
  return [
    ['Models', policy.models.allow?.length ? policy.models.allow.join(', ') : 'Any model (spending caps still apply)'],
    ['Lanes', policy.lanes.join(', ')],
    ['Spending caps (USD)', `Request $${policy.caps.per_request_usd}; rolling hour $${policy.caps.per_hour_usd}; day $${policy.caps.per_day_usd}; week $${policy.caps.per_week_usd}`],
    ['Maximum output', `${policy.caps.max_output_tokens} tokens`],
    ['Tools', policy.tools.allow.length ? policy.tools.allow.join(', ') : 'All declared tools denied'],
    ['Working hours', policy.windows ? 'Monday–Friday, 09:00–17:00 UTC (end excluded)' : 'Any time'],
    ['Ask first', `Above $${policy.approval.above_usd}; caps still apply`],
    ['Circuit breakers', Object.entries(policy.breakers).map(([key, value]) => `${({ max_requests_per_minute: 'Requests per rolling minute', max_denials_per_10min: 'Denials per rolling ten minutes', max_spend_usd_per_minute: 'USD per rolling minute' })[key]}: ${value}`).join('; ')],
    ['On breach', policy.on_breach === 'kill' ? 'Stop future requests until resumed' : 'Deny this request; breaker trips stop future requests until resumed'],
    ['Alerts', policy.alerts ? 'Agent feed at 50%, 80%, 100% of caps and 3 denials in ten minutes; no external channels' : 'Existing router alert defaults; no channel configuration set'],
    ['Autonomy', 'No automatic spending cap increases'],
    ['Agreements', 'No agreement rules set'],
  ];
}

export async function applyStarter(request, keyHash, template) {
  if (!keyHash || !STARTER_RULEBOOKS.includes(template)) throw new Error('Select an agent and a starter rulebook.');
  return request(`/api/v1/agents/${encodeURIComponent(keyHash)}/policy`, { method: 'PUT', body: structuredClone(template.policy) });
}
