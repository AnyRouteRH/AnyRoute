// C135: read existing account state; keep checklist preferences in this browser only.
import { activityPage, activityPath } from './activity.js';
import { isReceiptId, privacyHref } from './privacy.js';
import { readTelegramLink } from './telegram-linking.js';

export const GETTING_STARTED_PREFIX = 'anyroute-getting-started-v1:';
const empty = () => ({ hidden: false, complete: false, checked: false, receipts: [] });
const positive = value => value != null && Number.isFinite(Number(value)) && Number(value) > 0;
export const creditedDeposit = row => row?.status === 'credited' || row?.kind === 'deposit' && row.status === 'posted' && positive(row.amount);
export function gettingStartedSteps({ workspace = {}, agents = [], activity = [], deposits = [], telegram, checked = false } = {}) {
  const credits = workspace.credits || {};
  const receipt = activity.find(row => isReceiptId(row.receipt_id))?.receipt_id || workspace.receipts?.find(row => isReceiptId(row.id))?.id;
  return [
    { id: 'funds', title: 'Add funds', href: '/dashboard/#payments', done: positive(credits.balance ?? credits.available) || [...(workspace.stock?.deposits || []), ...deposits].some(creditedDeposit) },
    { id: 'call', title: 'Make your first call', href: '/harness/', done: positive(credits.total_usage) || activity.some(row => row.kind === 'call' && Number(row.amount) < 0) || workspace.receipts?.some(row => positive(row.cost)) || false },
    { id: 'limit', title: 'Set a spending limit', href: '/dashboard/#api-keys', done: [workspace.me, ...(workspace.keys || [])].some(key => key?.limit != null && Number.isFinite(Number(key.limit)) && Number(key.limit) >= 0) || agents.some(agent => agent.has_policy === true) },
    { id: 'telegram', title: 'Link Telegram', href: '/agents/', done: telegram?.linked === true },
    { id: 'receipt', title: 'Check a receipt', href: receipt ? privacyHref(receipt) : '/dashboard/#activity', done: checked === true },
  ];
}
export function readGettingStartedState(storage, scope) {
  try {
    const value = JSON.parse(storage.getItem(GETTING_STARTED_PREFIX + scope));
    return { hidden: value?.hidden === true, complete: value?.complete === true, checked: value?.checked === true, receipts: Array.isArray(value?.receipts) ? value.receipts.filter(isReceiptId).slice(0, 100) : [] };
  } catch { return empty(); }
}
export function writeGettingStarted(storage, scope, patch) {
  const value = { ...readGettingStartedState(storage, scope), ...patch };
  try { storage.setItem(GETTING_STARTED_PREFIX + scope, JSON.stringify(value)); return true; } catch { return false; }
}
export function rememberGettingStartedReceipts(storage, scope, ids) {
  const old = readGettingStartedState(storage, scope);
  return writeGettingStarted(storage, scope, { receipts: [...new Set([...ids.filter(isReceiptId), ...old.receipts])].slice(0, 100) });
}
// An arbitrary public receipt URL cannot tick this step: Home must have read that id from the authenticated account first.
export function recordGettingStartedReceiptVisit(storage, id) {
  if (!isReceiptId(id)) return false;
  let changed = false;
  try {
    const scopes = [];
    for (let i = 0; i < storage.length; i++) { const name = storage.key(i); if (name?.startsWith(GETTING_STARTED_PREFIX)) scopes.push(name.slice(GETTING_STARTED_PREFIX.length)); }
    for (const scope of scopes) if (readGettingStartedState(storage, scope).receipts.includes(id)) changed = writeGettingStarted(storage, scope, { checked: true }) || changed;
  } catch { /* Browser storage may be unavailable. */ }
  return changed;
}
export const gettingStartedHidden = (state, steps) => state.hidden || state.complete || steps.every(step => step.done);

/** Existing guards decide visibility. Errors (including disabled features) remain unknown, never completed. */
export async function readGettingStarted(request, { signal, readDeposits = true } = {}) {
  const result = { activity: [], deposits: [], telegram: null, errors: [] };
  await Promise.all([
    (async () => {
      try { result.activity = activityPage(await request(activityPath({ kind: 'call' }, '', 'json', 100), { signal })).rows; }
      catch (error) { if (error.name === 'AbortError') throw error; result.errors.push('Calls could not be read.'); }
    })(),
    (async () => {
      try { result.telegram = await readTelegramLink(request, { signal }); }
      catch (error) { if (error.name === 'AbortError') throw error; result.errors.push(error.status === 404 ? 'Telegram linking is not switched on here.' : 'Telegram link status could not be read.'); }
    })(),
    (async () => {
      if (!readDeposits) return;
      try {
        let cursor = ''; const seen = new Set();
        do {
          const page = activityPage(await request(activityPath({ kind: 'deposit' }, cursor, 'json', 100), { signal }));
          const credited = page.rows.find(creditedDeposit);
          if (credited) { result.deposits = [credited]; break; }
          cursor = page.next || '';
          if (cursor && seen.has(cursor)) throw new Error('Deposit cursor did not advance.');
          seen.add(cursor);
        } while (cursor && !signal?.aborted);
      } catch (error) { if (error.name === 'AbortError') throw error; result.errors.push('Deposits could not be read.'); }
    })(),
  ]);
  return result;
}
