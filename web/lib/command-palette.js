// J181: destinations and transient page controls. No credentials or conversation text is retained here.
import { INBOX_GROUPS, filterUrl } from './inbox-filters.js';
import { compareHref, readComparePicks } from './model-compare.js';
import { canRotateKey } from './key-rotation.js';

export const COMMAND_EVENT = 'anyroute:command-context';
const controls = new Map();
const validId = value => typeof value === 'string' && !/^sk-/i.test(value) && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(value);
const targetId = value => typeof value === 'string' && !/^sk-/i.test(value) && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export const commandHref = (path, command, target) => {
  if (target !== undefined && !targetId(target)) return null;
  const url = new URL(path, 'https://anyroute.tech');
  url.searchParams.set('command', command);
  if (target) url.searchParams.set('target', target);
  if (command === 'duplicate-agent' && target) url.searchParams.set('agent', target);
  return url.pathname + url.search + url.hash;
};
export function registerCommand(id, run, detail = {}) {
  const entry = { run, ...detail };
  controls.set(id, entry);
  const announce = () => globalThis.window?.dispatchEvent(new Event(COMMAND_EVENT));
  announce();
  return () => { if (controls.get(id) === entry) controls.delete(id); announce(); };
}
export const runPageCommand = id => { const entry = controls.get(id); if (!entry) return false; entry.run(); return true; };
export function paletteContext(location, storage) {
  const chat = controls.get('chat-context');
  let picks = [];
  try { picks = readComparePicks(storage); } catch { /* Storage can be unavailable. */ }
  const current = /^\/models\/model\/?$/.test(location.pathname) ? new URLSearchParams(location.search).get('id') : null;
  const models = [...new Set([...(chat?.models || []), ...(current ? [current] : []), ...picks.slice(-2)].filter(validId))].slice(0, 2);
  return { pathname: location.pathname, currentModel: validId(current) ? current : null, models, ready: [...controls.keys()] };
}
export function consumeCommand(location, history, id, target) {
  const params = new URLSearchParams(location.search);
  if (params.get('command') !== id || (target !== undefined && params.get('target') !== target)) return false;
  params.delete('command'); params.delete('target');
  history.replaceState(history.state, '', location.pathname + (params.size ? '?' + params : '') + location.hash);
  return true;
}

const action = (id, title, description, page, keywords, more = {}) => ({ id: 'command-' + id, command: id, kind: 'action', group: 'build', title, description, page, keywords: keywords.split(', '), featured: true, ...more });
export function commandActions(context = {}, { signedIn = false, caller = null, accessError = false } = {}) {
  const ready = context.ready || [];
  const denied = ['read', 'inference'].includes(caller?.scope);
  const management = 'Use an account management key.';
  const rows = [
    action('stop-all', 'Stop all agents', 'Open Agents and confirm Stop for every agent you can manage.', '/agents/', 'stop all, pause, pause all, kill switch, halt all', { signIn: true, permission: 'manage', onlyReady: /^\/agents\/?$/.test(context.pathname) }),
    action('resume-all', 'Resume all', 'Open Agents and confirm resuming stopped agents within their rules.', '/agents/', 'resume all, start all, restart all, unpause all', { signIn: true, permission: 'manage', onlyReady: /^\/agents\/?$/.test(context.pathname) }),
    action('rotate-key', 'Rotate a key', 'Choose a key, then open its rotation dialog in API keys.', '/dashboard/#api-keys', 'rotate key, replace key, grace period', { signIn: true, permission: 'manage', pick: 'key' }),
    action('duplicate-agent', 'Duplicate an agent', 'Choose an agent, then open its existing duplicate dialog.', '/agents/', 'duplicate agent, copy agent, clone agent', { signIn: true, permission: 'manage', pick: 'agent' }),
    action('compare-models', 'Compare models', 'Compare the current models or your last two comparison picks.', compareHref(context.models || []), 'compare models, comparison, versus, side by side', { direct: true }),
    action('your-images', 'Your images', 'Open images saved in this browser’s encrypted Chat history.', '/harness/', 'your images, gallery, pictures, generated images'),
    action('account-checkup', 'Account checkup', 'Open Account checkup on Home.', '/dashboard/#checkup', 'account checkup, account health, review account', { signIn: true, direct: true }),
    action('notifications', 'Notifications settings', 'Choose inbox and Telegram notices and quiet hours in Settings.', '/dashboard/#notifications', 'notification settings, alerts, quiet hours', { signIn: true, permission: 'management', direct: true }),
    action('telegram', 'Link Telegram', 'Open the existing Telegram link panel in Agents.', '/agents/#telegram', 'link telegram, connect telegram, bot', { signIn: true, permission: 'manage', direct: true }),
    ...INBOX_GROUPS.map(([kind, label]) => action('inbox-' + kind, 'Inbox: ' + label, 'Open your inbox filtered to ' + label.toLowerCase() + '.', filterUrl('https://anyroute.tech/dashboard/#inbox', [kind]), 'inbox, filter, ' + label.toLowerCase(), { signIn: true, direct: true })),
  ];
  if (/^\/harness\/?$/.test(context.pathname)) {
    rows.push(action('print-chat', 'Print this chat', 'Print the shown conversation or save it as PDF.', '/harness/', 'print chat, pdf, save pdf', { onlyReady: true, aliases: ['pdf'] }));
    if (ready.includes('continue-answer')) rows.push(action('continue-answer', 'Continue cut-off answer', 'Ask the same model to finish the selected cut-off answer.', '/harness/', 'continue answer, cut off, finish answer', { onlyReady: true }));
  }
  if (context.currentModel) rows.push(action('watch-model', 'Watch this model', 'Use the model page’s Watch control for notices about this model.', '/models/model/?id=' + encodeURIComponent(context.currentModel), 'watch model, follow model, model notices', { signIn: true, permission: 'management', onlyReady: true }));
  return rows.map(row => {
    let note = '';
    if (signedIn && row.permission) {
      if (!caller) note = accessError ? 'Access could not be checked. Reopen search to try again.' : 'Checking key access…';
      else if (denied) note = 'Use an owner or admin key with edit access.';
      else if (row.permission === 'management' && !caller.management) note = management;
      else if (row.permission === 'manage' && !caller.management && !caller.team) note = 'Use an owner or admin key.';
    }
    if (!note && row.onlyReady && !ready.includes(row.command) && (!row.signIn || signedIn)) note = 'This action is unavailable right now.';
    return { ...row, disabled: !!note, note, description: note ? row.description + ' ' + note : row.description };
  });
}
export const commandDestination = (action, target) => action.direct ? action.page : commandHref(action.page, action.command, target);

export async function rotationKeyChoices(request, caller, signal) {
  if (!caller || ['read', 'inference'].includes(caller.scope)) return [];
  let keys;
  try { keys = (await request('/api/v1/keys', { signal })).data; }
  catch (error) { if (error?.name === 'AbortError') throw error; keys = [caller]; }
  return Promise.all((Array.isArray(keys) ? keys : []).filter(key => targetId(key.hash)).map(async key => {
    let note = '';
    try {
      const { data } = await request('/api/v1/keys/' + encodeURIComponent(key.hash) + '/rotation', { signal });
      if (!canRotateKey(key, caller, data)) note = 'This key cannot be rotated.';
    } catch (error) { if (error?.name === 'AbortError') throw error; note = 'Rotation access could not be checked.'; }
    return { id: key.hash, title: key.name || 'Unnamed key', description: key.label || 'Account key', keywords: ['key'], featured: true, disabled: !!note, note };
  }));
}
