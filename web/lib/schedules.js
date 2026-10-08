export const scheduleDraft = row => Object.fromEntries(['name', 'prompt', 'model', 'key_hash', 'cadence', 'time_utc', 'max_cost_usd', 'paused'].map(key => [key, row[key]]));
export function approvedScheduleRequests(approvals, row) {
  return approvals.filter(item => item.key_hash === row.key_hash && item.status === 'approved' && Date.parse(item.expires_at) > Date.now());
}
export function failureWords(reason) {
  const words = { schedule_max_cost: 'The request exceeded your maximum cost.', agent_approval_required: 'Approval is needed. Open Inbox to review the request, then choose the approval below.', agent_policy_denied: 'Your rulebook refused the request.', agent_killed: 'The agent is stopped.', insufficient_credits: 'The account needs more funds.', key_disabled: 'The paying key is disabled.', key_expired: 'The paying key has expired.', worker_interrupted: 'The worker was interrupted. The call was not retried.', run_interrupted: 'The run was interrupted.', model_not_allowed: 'The key does not allow this model.', no_providers: 'No provider could serve the request.' };
  return words[reason] || 'The request could not be completed. Review the key and model settings.';
}
