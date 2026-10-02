'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { decideInboxApproval, INBOX_EVENT, markInboxSeen } from '../../lib/inbox.js';
import { intentSummary } from '../../lib/agents.js';
import useInbox from './useInbox';
import s from './Inbox.module.css';
export default function AccountInbox({ apiKey, panel = false }) {
  const { page, error, busy, refresh } = useInbox(apiKey);
  const [action, setAction] = useState(''), [actionError, setActionError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const request = (path, options) => api(path, { ...options, key: apiKey });
  async function run(id, operation) {
    setAction(id); setActionError('');
    try { await operation(); if (mounted.current) window.dispatchEvent(new Event(INBOX_EVENT)); }
    catch (e) { if (mounted.current) setActionError(e.message); }
    finally { if (mounted.current) setAction(''); }
  }
  return <section className={s.inbox} aria-label="Inbox">
    {!panel && <h2>Inbox</h2>}
    <p>Review requests waiting for you and new account events.</p>
    <div className={s.actions}><button className="text-button" disabled={busy || !!action} onClick={refresh}>Refresh</button><button className="text-button" disabled={!page || busy || !!action} onClick={() => run('seen', () => markInboxSeen(request, window.localStorage, page))}>Mark seen</button>{panel && <a className="inline-link" href="/dashboard/#inbox">Open inbox</a>}</div>
    <p className="help-text">Seen time stays in this browser. Pending approvals stay counted until decided or expired. Alerts cover retained records. Host updates show the current status and record update time; earlier status changes are not retained here.</p>
    {page?.scope === 'key' && <p className="help-text">This key’s events only. A management or owner/admin key is needed to decide approvals.</p>}
    {(error || actionError) && <p role="alert" className="error">{error || actionError}</p>}
    {busy && <p role="status">Reading inbox…</p>}
    {!busy && page && !page.data.length && <p>No new items or pending approvals.</p>}
    {page?.capped && <p role="status">Showing up to 100 recent records per source. Open Activity or the linked view for earlier records; the count covers the items shown.</p>}
    <ul className={s.list}>{page?.data.map(item => <li key={item.id}>
      <div className={s.row}><a className="inline-link" href={item.href}>{item.title}</a><time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></div>
      <p className="help-text">{[item.key_label, item.model, item.status, item.amount && item.amount !== '0' ? `${item.amount} USDG` : ''].filter(Boolean).join(' · ')}</p>
      {item.kind === 'approval' && <><p>{intentSummary(item.intent)}</p>{item.intent?.intents?.filter(intent => intent.max_output_tokens !== undefined).map((intent, index) => <p className="help-text" key={index}>{intent.model} · Output limit: {intent.max_output_tokens} tokens</p>)}<p>Limit {item.approval_limit} USDG · Expires <time dateTime={item.expires_at}>{new Date(item.expires_at).toLocaleString()}</time></p>{item.can_decide && <div className={s.actions}>{['approve', 'deny'].map(choice => <Button secondary key={choice} disabled={!!action || Date.parse(item.expires_at) <= Date.now()} onClick={() => run(item.id, () => decideInboxApproval(request, item.approval_id, choice))}>{choice === 'approve' ? 'Approve' : 'Deny'}</Button>)}</div>}</>}
    </li>)}</ul>
  </section>;
}
