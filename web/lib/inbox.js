export const INBOX_EVENT = 'anyroute-inbox-changed';
const prefix = 'anyroute-inbox-seen-v1:';
export const inboxBadge = count => count > 99 ? '99+' : String(Math.max(0, count));
export function inboxPage(value) {
  if (!Array.isArray(value?.data) || !Number.isInteger(value.count) || value.count < 0 || !/^[a-f0-9]{64}$/.test(value.seen_scope || '') || !Number.isFinite(Date.parse(value.as_of))) throw new Error('The inbox response could not be read.');
  return value;
}
export function readSeen(storage, scope) {
  try { const value = storage.getItem(prefix + scope); return Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() ? value : ''; } catch { return ''; }
}
export async function readInbox(request, storage, options = {}) {
  const first = inboxPage(await request('/api/v1/inbox', options));
  const since = readSeen(storage, first.seen_scope);
  return since ? inboxPage(await request('/api/v1/inbox?since=' + encodeURIComponent(since), options)) : first;
}
export async function markInboxSeen(request, storage, page) {
  const result = await request('/api/v1/inbox/seen?through=' + encodeURIComponent(page.as_of), { method: 'POST' });
  if (result.seen_scope !== page.seen_scope || result.seen_at !== page.as_of) throw new Error('The inbox seen time could not be read.');
  const old = readSeen(storage, result.seen_scope);
  // Keep only a timestamp per visibility scope. Never store items or an API key here.
  storage.setItem(prefix + result.seen_scope, old > result.seen_at ? old : result.seen_at);
  return result;
}
export { decideAgentApproval as decideInboxApproval } from './agents.js';
