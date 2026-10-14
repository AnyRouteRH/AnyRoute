// H173: keep these groups aligned with src/inbox/filters.ts.
import { applyInboxReadTime } from './inbox-read-state.js';
import { markInboxSeen, readSeen } from './inbox.js';
export const INBOX_GROUPS = [['approvals', 'Approvals'], ['agents', 'Agents'], ['money', 'Money'], ['security', 'Security'], ['models', 'Models'], ['other', 'Other']];
const groups = {
  approval: 'approvals', approval_reminder: 'approvals',
  alert: 'agents', 'quiet-agent': 'agents', playbook: 'agents', schedule: 'agents',
  deposit: 'money', topup: 'money', payment: 'money', low_balance: 'money', project_budget: 'money',
  security: 'security', price_notice: 'models', model_watch: 'models',
  agreement: 'other', host: 'other', weekly_summary: 'other',
};
export const inboxGroup = kind => Object.hasOwn(groups, kind) ? groups[kind] : 'other';
export const selectedKinds = search => [...new Set((new URLSearchParams(search).get('kinds') || '').split(',').filter(kind => /^[a-z][a-z_-]*$/.test(kind)))];
export function filterUrl(href, kinds) {
  const url = new URL(href);
  if (kinds.length) url.searchParams.set('kinds', kinds.join(',')); else url.searchParams.delete('kinds');
  return url.pathname + url.search + url.hash;
}
export function projectInbox(page, since, kinds = []) {
  const { data } = applyInboxReadTime(page, since);
  const counts = Object.fromEntries(INBOX_GROUPS.map(([group]) => [group, 0]));
  for (const item of data) counts[inboxGroup(item.kind)]++;
  return { ...page, data: data.filter(item => !kinds.length || kinds.includes(item.kind) || kinds.includes(inboxGroup(item.kind))), count: data.filter(item => item.unread).length, filters: { kinds, counts, snapshot: page } };
}
const prefix = 'anyroute-inbox-seen-v1:';
export async function markAllRead(request, storage, page, now = Date.now) {
  const previous = readSeen(storage, page.seen_scope);
  await markInboxSeen(request, storage, page);
  return { scope: page.seen_scope, previous, written: readSeen(storage, page.seen_scope), expires: now() + 10000 };
}
export function undoMarkAllRead(storage, token, scope, now = Date.now) {
  if (!token || token.scope !== scope || now() >= token.expires || readSeen(storage, scope) !== token.written) return false;
  if (token.previous) storage.setItem(prefix + scope, token.previous); else storage.removeItem(prefix + scope);
  return true;
}
