// J177: compose existing reads, retaining their access boundaries. No server persistence.
import { readTelegramLink } from './telegram-linking.js';
import { readSecurityAlerts } from './security-alerts.js';
import { readNotifications } from './notifications.js';

export const CHECKUP_PREFIX = 'anyroute-account-checkup-v1:';
const keyLink = (hash, control) => `/dashboard/?checkup=${control}&checkup_key=${encodeURIComponent(hash)}#api-keys`;
export const checkupLink = control => `/dashboard/?checkup=${control}#${control === 'balance' ? 'payments' : control === 'notifications' ? 'notifications' : 'settings'}`;
const capped = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0;
const live = (key, now) => !key.disabled && (!key.expires_at || Date.parse(key.expires_at) > now);
const muted = (prefs, type) => prefs?.channels?.[type]?.inbox === false && prefs?.channels?.[type]?.telegram === false;

export function accountCheckupItems({ workspace = {}, agents, telegram, balance, security, notifications } = {}, now = Date.now()) {
  if (!workspace.me || workspace.me.scope === 'read') return [];
  const items = [];
  const add = (id, sentence, why, href, suggestion = false) => items.push({ id, sentence, why, href, suggestion });
  if (telegram?.linked === false) add('telegram', 'Telegram is not linked for this key.', 'Receive approvals and alerts away from this browser.', checkupLink('telegram'));
  if (balance?.enabled === true && (balance.low_balance_usd === null || muted(notifications, 'low_balance'))) add('balance', balance.low_balance_usd === null ? 'Your balance alert is off.' : 'Balance alerts are muted in both channels.', 'Hear before your account runs out of funds.', checkupLink(balance.low_balance_usd === null ? 'balance' : 'notifications'));
  if (security?.enabled === false || security?.enabled === true && muted(notifications, 'security_alerts')) add('security', security.enabled ? 'Security alerts are muted in both channels.' : 'Security alerts are off.', 'Keep track of changes to keys and account rules.', checkupLink(security.enabled ? 'notifications' : 'security'));
  const keys = new Map([workspace.me, ...(!workspace.keysError ? workspace.keys || [] : [])].map(key => [key.hash, key]));
  for (const key of keys.values()) {
    if (!key.hash || !live(key, now)) continue;
    const name = key.name || 'Unnamed key';
    if (key.expires_at === null) add(`expiry:${key.hash}`, `${name} has no expiry.`, 'An expiry ends access when a key is no longer needed.', keyLink(key.hash, 'expiry'));
    if (key.limit === null && key.scope !== 'read') add(`limit:${key.hash}`, `${name} has no spending limit.`, 'A limit bounds how much this key can spend.', keyLink(key.hash, 'limit'));
    if (key.management === true && key.last_used && !key.allowed_ips?.length) add(`ip:${key.hash}`, `${name} is a used management key without an IP list.`, 'Consider limiting access to addresses you trust; changing networks may lock you out.', keyLink(key.hash, 'ip'), true);
  }
  for (const agent of agents || []) {
    if (agent.approval_only || !agent.key_hash || !keys.has(agent.key_hash) || !live(keys.get(agent.key_hash), now)) continue;
    const policies = agent.policies;
    if (!Array.isArray(policies)) continue;
    const name = agent.name || 'Unnamed agent';
    const href = focus => `/agents/?agent=${encodeURIComponent(agent.key_hash)}&focus=${focus}`;
    // Inherited and followed playbook rules count too. Zero is a real cap.
    if (!capped(agent.caps?.per_day_usd) && !policies.some(row => capped(row.policy?.caps?.per_day_usd))) add(`daily:${agent.key_hash}`, `${name} has no daily cap.`, 'Consider a daily cap to bound spending through Anyroute.', href('day'), true);
    if (!policies.some(row => row.policy?.work_hours || row.policy?.windows?.length)) add(`hours:${agent.key_hash}`, `${name} has no work hours.`, 'Consider choosing when this agent may run through Anyroute.', href('hours'), true);
  }
  return items;
}

export function readCheckupDismissed(storage, scope) {
  try { const value = JSON.parse(storage.getItem(CHECKUP_PREFIX + scope)); return Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(0, 2000) : []; } catch { return []; }
}
export function writeCheckupDismissed(storage, scope, ids) {
  try { storage.setItem(CHECKUP_PREFIX + scope, JSON.stringify([...new Set(ids)].slice(-2000))); return true; } catch { return false; }
}
export const visibleCheckupItems = (items, dismissed) => items.filter(item => !dismissed.includes(item.id));

export async function readAccountCheckup(request, { workspace, signal } = {}) {
  if (!workspace?.me) throw Object.assign(new Error('Connect a key to read Account checkup.'), { status: 401 });
  if (workspace.me.scope === 'read') throw Object.assign(new Error('Account checkup is unavailable with a read-only key.'), { status: 403 });
  const result = { errors: [] };
  await Promise.all([
    ['telegram', 'Telegram link', () => readTelegramLink(request, { signal })],
    ['balance', 'Balance alert', async () => {
      const value = await request('/api/v1/account/low-balance', { signal });
      if (typeof value?.enabled !== 'boolean' || !(value.low_balance_usd === null || capped(value.low_balance_usd))) throw Error('Unreadable');
      return value;
    }],
    ['security', 'Security alerts', () => readSecurityAlerts(request, { signal })],
    ['notifications', 'Notification settings', async () => {
      const value = await readNotifications(request, { signal });
      if (!value?.channels) throw Error('Unreadable');
      return value;
    }],
  ].map(async ([name, label, read]) => {
    try { result[name] = await read(); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      result.errors.push(`${label}: ${error.status === 404 ? 'not switched on here' : error.status === 403 ? 'not available to this key' : 'could not be read'}.`);
    }
  }));
  return result;
}
