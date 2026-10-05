// U106: ⌘K actions, built from the site map's ACTIONS. Each is tied to the task whose page does it, so search, menus and
// actions stay one source. Pure logic: which actions need a connected key, where each one goes, the pick lists, the
// confirm words and the only calls ⌘K makes itself. Nothing here keeps a key, and an API key never goes into a link.
import { ACTIONS, TASKS } from './site-map.js';
import { searchTasks } from './site-search.js';
import { isReceiptId, privacyHref } from './privacy.js';
import { FEATURE_OFF, confirmKill, errorState, stopQuestion } from './agents.js';
import { LIMIT_CAPS, LIMIT_WORDS } from './spending-limits.js';
import { selectableModels } from './model-availability.js';

const taskOf = id => TASKS.find(task => task.id === id);
export const SITE_ACTIONS = ACTIONS.filter(action => taskOf(action.task)).map(action => ({ ...action, kind: 'action', group: taskOf(action.task).group, page: taskOf(action.task).href }));

const AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const KEY_LIKE = /^sk-/i;
const pathOf = href => href.split('#')[0];
const hashOf = href => href.includes('#') ? '#' + href.split('#')[1] : '';
const link = (path, params, hash = '') => { const query = new URLSearchParams(params).toString(); return path + (query ? '?' + query : '') + hash; };

export const needsSignIn = (action, signedIn) => !!action?.signIn && !signedIn;

// Where an action goes before anything is chosen. Signed out, this is its own page, which asks for a key there and
// carries on once one is connected (the dashboard opens Create key after connecting, for example).
export function startHref(action) {
  if (action.open === 'new-key') return link(pathOf(action.page), { new: 'key' }, hashOf(action.page));
  return action.page;
}

// Where an action goes once its pick step chose something. Null for anything that is not a plain id, or looks like a key.
export function actionHref(action, choice = '') {
  if (!action.pick) return startHref(action);
  const value = String(choice ?? '').trim();
  if (!value || KEY_LIKE.test(value)) return null;
  if (action.pick === 'receipt') return isReceiptId(value) ? privacyHref(value) + '#v-saw' : null;
  if (action.pick === 'model') return MODEL_ID.test(value) ? link(pathOf(action.page), { model: value }) : null;
  if (action.pick === 'agent') return AGENT_ID.test(value) ? link(pathOf(action.page), action.focus ? { agent: value, focus: action.focus } : { agent: value }) : null;
  return null;
}

// A receipt id typed straight into search: a gen- id anywhere, or any id-like word next to "receipt".
const RECEIPT_WORD = /^rec(?:ei|ie|e)pts?$/i;
export function receiptIdFromQuery(query) {
  const words = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  const direct = words.find(word => /^gen-./i.test(word) && isReceiptId(word));
  if (direct) return direct;
  if (!words.some(word => RECEIPT_WORD.test(word))) return '';
  return words.find(word => !RECEIPT_WORD.test(word) && isReceiptId(word) && /\d/.test(word) && word.length >= 6) || '';
}

// Actions rank with tasks on the same scale; listed first, an action wins a tie. A receipt id in the query becomes the
// receipt action, ready to open.
export function searchAll(query, { actions = SITE_ACTIONS, tasks = TASKS } = {}) {
  const receipt = receiptIdFromQuery(query);
  const rest = receipt ? String(query).replace(receipt, ' ') : query;
  const rows = searchTasks(rest, [...actions, ...tasks]);
  if (!receipt) return rows;
  const open = actions.find(action => action.pick === 'receipt');
  if (!open) return rows;
  return [{ ...open, prefill: receipt }, ...(rest.trim() ? rows.filter(row => row !== open) : [])];
}

// The step after choosing an action: pick an agent or model, type a receipt id, or none (the action is a link).
export const firstStep = action => action.pick === 'receipt' ? 'input' : action.pick ? 'pick' : null;

// Agents a connected key can manage, for the pick step. Stop and Resume grey out agents they cannot act on, with the
// reason the /agents page gives; the ones they can act on come first.
export function agentChoices(rows, action) {
  const choices = (Array.isArray(rows) ? rows : []).filter(row => row && AGENT_ID.test(String(row.key_hash ?? ''))).map(row => {
    const state = row.killed ? 'Stopped' : 'Running';
    const note = action.run === 'stop' ? (row.killed ? 'Already stopped.' : !row.has_policy ? LIMIT_WORDS.stopFirst : '')
      : action.run === 'resume' ? (row.killed ? '' : 'This agent is not stopped.') : '';
    return { id: row.key_hash, title: String(row.name || '').trim() || 'Unnamed agent', description: `${state} · rulebook ${row.has_policy ? 'on' : 'off'} · key ${row.key_hash.slice(0, 12)}`,
      keywords: [row.key_hash, state], featured: true, disabled: !!note, note, agent: row };
  });
  return [...choices.filter(choice => !choice.disabled), ...choices.filter(choice => choice.disabled)];
}

// Models Chat can switch to: the public catalogue (toCatalogModel shapes), without unavailable or embedding models.
export function modelChoices(models) {
  return selectableModels(Array.isArray(models) ? models : []).filter(model => model?.type !== 'Embeddings' && MODEL_ID.test(String(model?.id ?? '')))
    .map(model => ({ id: model.id, title: model.name || model.id, description: model.name && model.name !== model.id ? `${model.id} · ${model.author}` : model.author || model.id, keywords: [model.id, model.author || ''], featured: true }));
}

export const filterChoices = (filter, choices, limit = 50) => searchTasks(filter, choices).slice(0, limit);

// The confirm step's words. Stop asks exactly what the /agents page asks (confirmKill's question); /agents resumes
// with its Resume button alone, so ⌘K adds this question rather than acting on a single key press.
export function agentQuestion(kind, agent) {
  return kind === 'stop' ? stopQuestion(agent) : `Resume ${agent.name || 'this key'}? New requests through Anyroute will be allowed again, within its spending limits.`;
}

// Reads the agents a connected key can manage (GET /api/v1/agents, as /agents does). Signed out it calls nothing.
export async function loadAgents(request, signedIn, signal) {
  if (!signedIn) return { state: 'signin', rows: [] };
  try {
    const response = await request('/api/v1/agents', { signal });
    return Array.isArray(response?.data) ? { state: 'ok', rows: response.data } : { state: 'error', rows: [], error: 'The agent list response could not be read.' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const state = errorState(error);
    return { state: state.off ? 'off' : 'error', rows: [], error: state.off ? FEATURE_OFF : state.message };
  }
}

// Stop or Resume through the same calls as /agents, only once the person confirmed agentQuestion() and only signed in.
export async function runAgentCommand(kind, agent, request, { confirmed = false, signedIn = false } = {}) {
  if (confirmed !== true || !signedIn || !AGENT_ID.test(String(agent?.key_hash ?? ''))) return false;
  if (kind === 'stop') return confirmKill(agent, '', () => true, request); // the dialog already asked confirmKill's question
  if (kind !== 'resume') return false;
  await request(`/api/v1/agents/${encodeURIComponent(agent.key_hash)}/resume`, { method: 'POST' });
  return true;
}

// The /agents link from ⌘K: which agent to select, and which part of its spending limits to focus.
const FOCUS = { limits: id => `#${id}-${LIMIT_CAPS[0][0]}`, route: id => `input[name="${id}-route-default"]:checked` };
export const focusSelector = (focus, editorId) => focus && Object.hasOwn(FOCUS, focus) ? FOCUS[focus](editorId) : null;
export function agentLink(search) {
  const params = new URLSearchParams(String(search ?? '').replace(/^\?/, ''));
  const agent = (params.get('agent') ?? '').trim();
  if (!AGENT_ID.test(agent) || KEY_LIKE.test(agent)) return null;
  const focus = params.get('focus');
  return { agent, focus: focus && Object.hasOwn(FOCUS, focus) ? focus : null };
}
