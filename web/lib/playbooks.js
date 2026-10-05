// U115: playbooks. One named rulebook that many agents and API keys follow; change it once and every key that follows it
// uses the new rules on its next request. Pure helpers for the dashboard's Playbooks section and the Follow control on
// each key and agent. Nothing here calls the API; the router validates, stores and enforces.
import { STARTER_SETUPS, setupPolicy } from './starter-setups.js';
import { limitsFromRulebook, rulebookFromLimits } from './spending-limits.js';

export const PLAYBOOK_WORDS = {
  title: 'Playbooks',
  intro: 'A playbook is one set of rules that many agents and API keys follow. Change it once, and every key that follows it uses the new rules on its next request.',
  create: 'New playbook', name: 'Name', save: 'Save playbook', remove: 'Delete playbook', edit: 'Edit', cancel: 'Cancel',
  from: 'Start from', empty: 'No rules yet', setups: 'Starter setups', keys: 'A key’s current rules',
  account: 'Whole account', team: 'Team playbook',
  none: 'No playbooks yet. Make one from a starter setup or from a key’s current rules, then have keys follow it.',
  connect: 'Connect a management key, or a team owner or admin key, to make playbooks and choose which keys follow them.',
  readOnly: 'This playbook covers the whole account; only a management key can change it.',
  editorHelp: 'The same spending limits as any key. Hours, circuit breakers, alerts and other rules in this playbook are kept as they are; View JSON shows every rule.',
  follow: 'Use a playbook', choose: 'Choose a playbook', followButton: 'Follow', stop: 'Stop following',
  followHelp: 'Following a playbook replaces this key’s own rules with the playbook’s. Stop following keeps the playbook’s current rules as this key’s own, so nothing loosens.',
  locked: 'These rules come from the playbook. Change them there, or stop following it to edit them here. Stop and Resume still work for this key.',
};

/** Empty rules: no caps and no restrictions, refusing only what a later edit adds. */
export const EMPTY_RULES = Object.freeze({ version: 1, models: {}, caps: {}, on_breach: 'deny' });

export const followersText = n => `${n} ${n === 1 ? 'key follows' : 'keys follow'} it`;
export const followsText = playbook => `Follows playbook ${playbook.name}`;
export const playbookHref = id => `/dashboard/?playbook=${encodeURIComponent(id)}#playbooks`;
export const playbookPath = id => '/api/v1/playbooks' + (id ? '/' + encodeURIComponent(id) : '');
export const followPath = keyHash => `/api/v1/agents/${encodeURIComponent(keyHash)}/playbook`;
export const scopeText = playbook => playbook.team_id ? PLAYBOOK_WORDS.team : PLAYBOOK_WORDS.account;

/** A key's own rulebook from a GET /api/v1/agents row, or null. */
export function ownRules(agent) {
  const own = agent?.policies?.find(p => !p.inherited && p.key_hash === agent.key_hash);
  return own?.policy ? structuredClone(own.policy) : null;
}

/**
 * Where a new playbook can start: no rules, each starter setup (with Agent Guard's action rules where it is on), or the
 * current rules of a key that has its own. Values are "empty", "setup:<id>" and "key:<key hash>".
 */
export function startChoices(agents = []) {
  return [
    { value: 'empty', label: PLAYBOOK_WORDS.empty, group: null },
    ...STARTER_SETUPS.map(s => ({ value: 'setup:' + s.id, label: s.name, group: PLAYBOOK_WORDS.setups })),
    ...agents.filter(a => ownRules(a)).map(a => ({ value: 'key:' + a.key_hash, label: `${a.name || 'Unnamed key'} (${a.key_hash.slice(0, 8)})`, group: PLAYBOOK_WORDS.keys })),
  ];
}

/** The rulebook a start choice stands for: a fresh copy, so editing it never changes the setup or the key. */
export function startRules(value, agents = [], { guard = false } = {}) {
  if (typeof value === 'string' && value.startsWith('setup:')) {
    const setup = STARTER_SETUPS.find(s => s.id === value.slice(6));
    if (setup) return setupPolicy(setup, { guard });
  }
  if (typeof value === 'string' && value.startsWith('key:')) {
    const rules = ownRules(agents.find(a => a.key_hash === value.slice(4)));
    if (rules) return rules;
  }
  return structuredClone(EMPTY_RULES);
}

/** Editor values for a playbook's rules (or a start choice's), in the shared spending limits editor. */
export const playbookForm = policy => limitsFromRulebook(policy ?? EMPTY_RULES);

/** Name and editor values -> the POST/PUT body, with readable errors. */
export function playbookBody(name, form) {
  const errors = [];
  const trimmed = String(name ?? '').trim();
  if (!trimmed) errors.push('Name: enter a name for this playbook.');
  else if (trimmed.length > 100) errors.push('Name: use at most 100 characters.');
  const built = rulebookFromLimits(form);
  return { body: { name: trimmed, policy: built.policy }, errors: [...errors, ...built.errors] };
}

/** DELETE for a playbook: with followers, ?unlink=copy and a confirmation that says each key keeps the rules. */
export function deleteRequest(playbook) {
  const n = playbook.followers ?? 0;
  return {
    path: playbookPath(playbook.id) + (n ? '?unlink=copy' : ''),
    confirm: n ? `Delete playbook ${playbook.name}? ${followersText(n)}; each keeps these rules as its own.` : `Delete playbook ${playbook.name}?`,
  };
}

/** POST /api/v1/agents/:key_hash/playbook to follow (an id) or stop following (null), with its confirmation. */
export function followRequest(keyHash, playbook) {
  return {
    path: followPath(keyHash),
    body: { playbook_id: playbook ? playbook.id : null },
    confirm: playbook ? `Follow playbook ${playbook.name}? Its rules replace this key’s own rules.` : 'Stop following this playbook? This key keeps the playbook’s current rules as its own.',
  };
}

/** The playbook a dashboard link names (?playbook=<id>), if it is one of those listed. */
export function linkedPlaybook(search, playbooks = []) {
  const id = new URLSearchParams(search || '').get('playbook');
  return id && playbooks.some(p => p.id === id) ? id : null;
}
