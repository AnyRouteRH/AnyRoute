// K190: public explanations contain no account data and never reflect query text.
export const WHY_TYPES = {
  agent_policy_denied: { title: 'An agent rule refused this request', text: 'The request was outside the agent’s spending limits, allowed models, work hours or other rules.', action: 'Review the agent’s spending limits and rules', href: '/agents/' },
  agent_killed: { title: 'This agent is stopped', text: 'Stop prevents the next request from running. A rule or a circuit breaker can also stop an agent. Review the reason before you resume it.', action: 'Review Stop in Agents', href: '/agents/' },
  agent_approval_required: { title: 'This request needs approval', text: 'The agent’s rules ask for approval before this request can run. Review the waiting request in Agents. An approval is single use and the rules are checked again when the agent retries.', action: 'Review waiting approvals', href: '/agents/#approvals' },
  agent_approval_invalid: { title: 'This approval cannot be used', text: 'The approval may have expired, been used, or belong to a different request. Ask for a fresh approval for the same request.', action: 'Review waiting approvals', href: '/agents/#approvals' },
  model_not_allowed: { title: 'This model is outside the key’s allowed models', text: 'The key can use only its allowed models. Choose an allowed model or ask the account owner to change the key’s model list.', action: 'Review API keys and allowed models', href: '/dashboard/#api-keys' },
  key_budget_exceeded: { title: 'This request would exceed the key’s budget', text: 'Charged spending, money held for calls in progress and the new request must fit within the key’s budget. Wait for its reset, choose a smaller request or change its total budget in Spending limits.', action: 'Open API keys, then Spending limits', href: '/dashboard/#api-keys' },
  project_budget_exceeded: { title: 'This request would exceed the project’s budget', text: 'All keys share the project’s monthly spending limit. Charged spending, money held for calls in progress and this request must fit. Open Insights, choose the project and review Project budget.', action: 'Open Insights and Project budget', href: '/dashboard/#insights' },
  ip_not_allowed: { title: 'This connection is outside the key’s allowed IP addresses', text: 'The key only works from its allowed IP addresses. Onion, unlinkable and background requests cannot verify an allowed client address. In API keys, choose Rename for the key and review Allowed IP addresses.', action: 'Open API keys and Allowed IP addresses', href: '/dashboard/#api-keys' },
  read_only_key: { title: 'This request needs a key with more access', text: 'A read-only key can read only the supported account pages. It cannot spend or change anything. Use a key with the access this request needs. A key’s access is fixed when it is created.', action: 'Review API keys and access', href: '/dashboard/#api-keys' },
};
const unknown = { title: 'Why a request was refused', text: 'A rule can stop a request before it runs. Open the help link in the refusal to read the explanation for that rule.', action: 'Read about refusal explanations', href: '/docs/#why-refused' };
export function whyQuery(search) {
  const params = new URLSearchParams(search);
  const candidate = params.get('type');
  return { type: Object.hasOwn(WHY_TYPES, candidate) ? candidate : '', id: /^[A-Za-z0-9-]{1,80}$/.test(params.get('id') || '') ? params.get('id') : '' };
}
export const whyExplanation = type => Object.hasOwn(WHY_TYPES, type) ? WHY_TYPES[type] : unknown;
