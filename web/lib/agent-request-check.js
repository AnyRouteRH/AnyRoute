import { api, validKey } from './api.js';
import { sampleIntent } from './agents.js';

// V85: checking the selected key never falls back to the management credential.
export async function checkSelectedRequest(keyHash, agentKey, form, request = api, signal) {
  if (!keyHash) throw new Error('Select an agent to check.');
  if (!validKey(agentKey)) throw new Error('Enter the selected agent’s API key.');
  const { intent, errors } = sampleIntent(form);
  if (errors.length) throw new Error(errors.join(' '));
  const options = { key: agentKey.trim(), signal };
  const me = await request('/api/v1/agents/me', options);
  if (me?.data?.key_hash !== keyHash) throw new Error('This key belongs to a different agent. Enter the selected agent’s key.');
  const result = await request('/api/v1/agents/check', { ...options, method: 'POST', body: intent });
  if (!['allow', 'approval_required', 'deny'].includes(result?.data?.decision) || !Array.isArray(result?.data?.reasons)) throw new Error('The router’s decision could not be read.');
  return result.data;
}
