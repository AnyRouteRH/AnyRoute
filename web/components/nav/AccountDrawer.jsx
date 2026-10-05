'use client';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { intentSummary } from '../../lib/agents.js';
import { decideInboxApproval, INBOX_EVENT, markInboxSeen } from '../../lib/inbox.js';
import { depositProgressView } from '../../lib/deposit-progress.js';
import { accountPoller } from '../../lib/account-poller.js';
import { ADD_FUNDS_HREF, APPROVALS_HREF, CONFIRM_MS, INBOX_HREF, approveConfirmText, approveStep, formatBalance, safeHref, stripAlerts, stripApprovals, stripDeposits } from '../../lib/account-strip.js';
import s from './AccountStrip.module.css';
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const when = value => <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
const meta = item => [item.key_label, item.model, item.status, item.amount && item.amount !== '0' ? `${item.amount} USDG` : ''].filter(Boolean).join(' · ');
// U105: approvals, alerts and deposits from the header, in a modal drawer. Same endpoints and decisions as the inbox and Agents.
export default function AccountDrawer({ apiKey, snapshot, onClose }) {
  const dialog = useRef(null), approvalsHeading = useRef(null), mounted = useRef(true);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [decided, setDecided] = useState({}); // approval ids decided here, hidden until the next read drops them
  const [armed, setArmed] = useState(null); // { id, at }: the approval whose Approve button waits for its confirming click
  useEffect(() => { if (!armed) return; const timer = setTimeout(() => setArmed(null), CONFIRM_MS); return () => clearTimeout(timer); }, [armed]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const element = dialog.current; element.showModal(); element.querySelector('button')?.focus(); accountPoller(apiKey).refresh(); return () => element.close(); }, [apiKey]);
  const request = (path, options) => api(path, { ...options, key: apiKey });
  async function run(id, operation, done) {
    setBusy(id); setError(''); setNotice('');
    try { await operation(); window.dispatchEvent(new Event(INBOX_EVENT)); if (mounted.current) done(); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(''); }
  }
  // Money moves only on a second, explicit click of the same button.
  const approve = item => { if (approveStep(armed, item.id) === 'arm') { setArmed({ id: item.id, at: Date.now() }); setNotice(''); return; } setArmed(null); decide(item, 'approve'); };
  const decide = (item, choice) => run(item.id, () => decideInboxApproval(request, item.approval_id, choice), () => {
    setDecided(old => ({ ...old, [item.id]: choice })); setNotice(choice === 'approve' ? 'Approved.' : 'Denied.');
    requestAnimationFrame(() => approvalsHeading.current?.focus());
  });
  // Keep Tab and Shift+Tab inside the drawer; Escape arrives as the dialog's cancel event.
  const trap = event => {
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll(FOCUSABLE)].filter(element => element.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || !items.includes(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !items.includes(active))) { event.preventDefault(); first.focus(); }
  };
  const page = snapshot?.inbox;
  const approvals = stripApprovals(page).filter(item => !decided[item.id]);
  const alerts = stripAlerts(page);
  const deposits = stripDeposits(snapshot?.deposits);
  const readErrors = [snapshot?.balanceError, snapshot?.inboxError, snapshot?.depositsError, snapshot?.readError].filter(Boolean);
  return createPortal(<dialog ref={dialog} className={s.drawer} aria-labelledby="account-drawer-title" onKeyDown={trap}
    onCancel={event => { event.preventDefault(); if (armed) setArmed(null); else onClose(); }} onClose={() => { if (!dialog.current?.open) onClose(); }} onClick={event => { if (event.target === event.currentTarget || event.target.closest?.('a[href]:not([target])')) onClose(); }}>
    <div className={s.panel}>
      <div className="modal-head"><h2 id="account-drawer-title">Your account</h2><button type="button" className="icon-button" aria-label="Close account updates" onClick={onClose}>×</button></div>
      <section className={s.section} aria-labelledby="account-drawer-balance">
        <h3 id="account-drawer-balance">Balance</h3>
        <p className={s.amount}>{snapshot?.balance != null ? formatBalance(snapshot.balance) : snapshot ? 'Unavailable' : 'Reading…'}</p>
        <a className="inline-link" href={ADD_FUNDS_HREF}>Add funds</a>
      </section>
      {error && <p role="alert" className="error">{error}</p>}
      <p role="status" className={s.notice}>{armed ? 'Select again within 5 seconds to approve.' : notice}</p>
      {readErrors.length > 0 && <p className="help-text">{readErrors[0]} The next refresh will try again.</p>}
      <section className={s.section} aria-labelledby="account-drawer-approvals">
        <h3 id="account-drawer-approvals" ref={approvalsHeading} tabIndex={-1}>Waiting for you</h3>
        {!page ? <p className="help-text">{snapshot ? 'Approvals could not be read.' : 'Reading approvals…'}</p> : !approvals.length ? <p>No pending approvals.</p> : <ul className={s.list}>{approvals.map(item => <li key={item.id}>
          <p><strong>{item.key_label || 'Unnamed agent'}</strong></p>
          <p>{intentSummary(item.intent)}</p>
          <p className="help-text">Limit {item.approval_limit} USDG · Expires {when(item.expires_at)}</p>
          {item.can_decide ? <div className={s.actions}>
            <Button type="button" className={armed?.id === item.id ? s.confirm : undefined} disabled={!!busy || Date.parse(item.expires_at) <= Date.now()} onClick={() => approve(item)} onBlur={() => { if (armed?.id === item.id) setArmed(null); }}>{armed?.id === item.id ? approveConfirmText(item) : 'Approve'}</Button>
            <Button type="button" secondary disabled={!!busy || Date.parse(item.expires_at) <= Date.now()} onClick={() => { setArmed(null); decide(item, 'deny'); }}>Deny</Button>
          </div> : <p className="help-text">A management or owner/admin key is needed to decide approvals.</p>}
        </li>)}</ul>}
        <a className="inline-link" href={APPROVALS_HREF}>Review approvals on Agents</a>
      </section>
      <section className={s.section} aria-labelledby="account-drawer-alerts">
        <div className={s.row}><h3 id="account-drawer-alerts">Alerts</h3>{alerts.length > 0 && <button type="button" className="text-button" disabled={!!busy} onClick={() => run('seen', () => markInboxSeen(request, window.localStorage, page), () => setNotice('Marked seen.'))}>Mark seen</button>}</div>
        {!page ? <p className="help-text">{snapshot ? 'Alerts could not be read.' : 'Reading alerts…'}</p> : !alerts.length ? <p>No new alerts.</p> : <ul className={s.list}>{alerts.map(item => <li key={item.id}>
          <div className={s.row}><a className="inline-link" href={safeHref(item.href)}>{item.title}</a>{when(item.at)}</div>
          {meta(item) && <p className="help-text">{meta(item)}</p>}
        </li>)}</ul>}
      </section>
      {!snapshot?.depositsOff && <section className={s.section} aria-labelledby="account-drawer-deposits">
        <h3 id="account-drawer-deposits">Deposits</h3>
        {!snapshot?.deposits ? <p className="help-text">{snapshot ? 'Deposit status could not be read.' : 'Reading deposits…'}</p> : !deposits.pending.length && !deposits.final.length ? <p>No deposits in progress.</p> : <ul className={s.list}>{[...deposits.pending, ...deposits.final].map(d => {
          const view = depositProgressView(d);
          return <li key={d.id} data-final={view.final}>
            {view.confirmation && <p><strong>{view.confirmation}</strong></p>}
            {d.tx_url ? <a className="inline-link" href={d.tx_url} target="_blank" rel="noopener noreferrer">View transaction ↗</a> : <code>{d.tx_hash}</code>}
            {view.worth && <p>{view.worth}</p>}
            <p>{view.status}</p>
            {d.note && <p className="help-text">{d.note}</p>}
            {d.capped && <p className="help-text">The per-deposit limit applies; the excess needs operator review.</p>}
          </li>;
        })}</ul>}
      </section>}
      <p className={s.foot}><a className="inline-link" href={INBOX_HREF}>Open inbox</a></p>
    </div>
  </dialog>, document.body);
}
