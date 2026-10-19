// K190: identifiers live on the error object only; no new request record or cache.
import { randomUUID } from 'node:crypto';
const types = new Set(['agent_policy_denied', 'agent_killed', 'agent_approval_required', 'agent_approval_invalid', 'model_not_allowed', 'key_budget_exceeded', 'project_budget_exceeded', 'ip_not_allowed', 'read_only_key']);
const ids = new WeakMap<object, string>();
export function identifyRefusal(error: object, id: string) { ids.set(error, id); }
export function inheritRefusal(error: object, source: object & { help_url?: unknown }) {
  const link = typeof source.help_url === 'string' && /^\/why\/\?type=[a-z_]+&id=[A-Za-z0-9-]+$/.test(source.help_url) ? source.help_url : undefined;
  const id = ids.get(source) ?? (link ? new URL(link, 'https://anyroute.invalid').searchParams.get('id') : null);
  if (id) identifyRefusal(error, id);
}
export function refusalHelp(error: { type?: unknown; help_url?: unknown }) {
  if (typeof error.type !== 'string' || !types.has(error.type)) return {};
  // Adapter errors may already carry the router's link. Accept only our own path.
  if (typeof error.help_url === 'string' && /^\/why\/\?type=[a-z_]+&id=[A-Za-z0-9-]+$/.test(error.help_url)) return { help_url: error.help_url };
  let id = ids.get(error);
  if (!id) { id = randomUUID(); ids.set(error, id); }
  return { help_url: `/why/?type=${error.type}&id=${id}` };
}
