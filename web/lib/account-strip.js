// U105: the signed-in strip in the site header (balance and a bell). Pure view logic and one read cycle.
// Account data stays in memory; nothing here touches storage except the inbox seen time the inbox already keeps.
import { inboxBadge, readInbox } from './inbox.js';

export const POLL_MS = 30_000;
export const MAX_POLL_MS = 300_000;
export const ADD_FUNDS_HREF = '/dashboard/#payments';
export const INBOX_HREF = '/dashboard/#inbox';
export const APPROVALS_HREF = '/agents/#approvals';

const FINAL = ['final', 'credited'];
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** 30 s while reads succeed; doubles per consecutive failure, up to 5 min. */
export function nextPollDelay(failures, base = POLL_MS, max = MAX_POLL_MS) {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  return Math.min(max, base * 2 ** Math.min(n, 16));
}

/** Pending approvals that have not expired. */
export function stripApprovals(page, now = Date.now()) {
  return (page?.data || []).filter(item => item.kind === 'approval' && Date.parse(item.expires_at) > now);
}
/** New inbox events other than approvals and deposits: spending and agent alerts, agreement disputes, host updates. */
export function stripAlerts(page) {
  return (page?.data || []).filter(item => item.kind !== 'approval' && item.kind !== 'deposit' && item.unread !== false);
}
/** Same split as the dashboard's deposit status: everything not yet final first, then the three latest final ones. */
export function stripDeposits(data) {
  const all = Array.isArray(data?.deposits) ? data.deposits : [];
  return { pending: all.filter(d => !FINAL.includes(d?.stage)), final: all.filter(d => FINAL.includes(d?.stage)).slice(0, 3) };
}
/** Same-site paths only; anything else opens the inbox. */
export const safeHref = href => typeof href === 'string' && /^\/(?![/\\])/.test(href) ? href : INBOX_HREF;

export function stripCounts(snapshot, now = Date.now()) {
  const inbox = snapshot?.inbox ? { approvals: stripApprovals(snapshot.inbox, now).length, alerts: stripAlerts(snapshot.inbox).length } : null;
  const deposits = snapshot?.deposits ? stripDeposits(snapshot.deposits).pending.length : null;
  return {
    approvals: inbox?.approvals ?? null,
    alerts: inbox?.alerts ?? null,
    deposits,
    total: (inbox ? inbox.approvals + inbox.alerts : 0) + (deposits ?? 0),
  };
}

/** The bell's accessible name: every count, or why it is missing. */
export function bellLabel(snapshot, now = Date.now()) {
  if (!snapshot || (!snapshot.at && !snapshot.inbox && !snapshot.deposits)) return 'Open account updates. Reading counts.';
  const counts = stripCounts(snapshot, now);
  const parts = [];
  if (counts.approvals == null) parts.push('approvals and alerts unavailable');
  else parts.push(plural(counts.approvals, 'approval waiting', 'approvals waiting'), plural(counts.alerts, 'alert', 'alerts'));
  if (counts.deposits != null) parts.push(plural(counts.deposits, 'deposit in progress', 'deposits in progress'));
  else if (!snapshot.depositsOff) parts.push('deposits unavailable');
  return `Open account updates: ${parts.join(', ')}.`;
}
/** The visible badge: hidden at zero, capped at 99+. */
export const bellBadge = snapshot => { const { total } = stripCounts(snapshot); return total > 0 ? inboxBadge(total) : ''; };

/** The spendable balance the dashboard shows: available, else balance. */
export function creditsBalance(data) {
  const value = data?.available ?? data?.balance;
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: 'trunc' });
/** Compact header balance. Never rounds up; a fraction of a cent reads "<$0.01". */
export function formatBalance(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'Balance';
  const n = Number(value);
  return n > 0 && n < 0.01 ? '<$0.01' : usd.format(n);
}
export function balanceLabel(snapshot) {
  if (snapshot?.balance != null) return `Balance ${formatBalance(snapshot.balance)}. Add funds.`;
  // The visible text ("Balance") starts the accessible name.
  return snapshot?.balanceError ? 'Balance unavailable. Add funds.' : 'Balance, reading. Add funds.';
}

/**
 * One read cycle: balance, inbox, then deposits, one request at a time. `request(path, { signal })` adds the key in a
 * header (never the URL). A 401 on the balance ends the cycle (the key no longer signs in). Deposits answer 403 for
 * keys that cannot read them; those are skipped from then on. `ok` is false when any read failed and should back off.
 */
export async function readAccountStrip(request, { storage, readDeposits, previous, signal } = {}) {
  const next = { ...previous, at: 0, balanceError: '', inboxError: '', depositsError: '', fatal: false };
  let ok = true;
  const aborted = error => error?.name === 'AbortError' || signal?.aborted;
  try { next.balance = creditsBalance((await request('/api/v1/credits', { signal }))?.data); }
  catch (error) {
    if (aborted(error)) throw error;
    if (error?.status === 401) return { value: { ...next, fatal: true, at: Date.now() }, ok: false };
    next.balanceError = error?.message || 'The balance could not be read.'; ok = false;
  }
  try { next.inbox = await readInbox((path, options) => request(path, { ...options, signal }), storage || { getItem: () => null }); }
  catch (error) { if (aborted(error)) throw error; next.inboxError = error?.message || 'The inbox could not be read.'; ok = false; }
  if (!next.depositsOff) {
    try { next.deposits = await (readDeposits ? readDeposits() : request('/api/v1/credits/deposits', { signal }).then(r => r?.data)); }
    catch (error) {
      if (aborted(error)) throw error;
      if (error?.status === 403) { next.depositsOff = true; next.deposits = null; }
      else { next.depositsError = error?.message || 'Deposit status could not be read.'; ok = false; }
    }
  }
  next.at = Date.now();
  return { value: next, ok };
}
