// H173
'use client';
import { useEffect, useRef, useState } from 'react';
import { INBOX_EVENT } from '../../lib/inbox.js';
import { filterUrl, INBOX_GROUPS, markAllRead, undoMarkAllRead } from '../../lib/inbox-filters.js';
import { INBOX_FILTER_EVENT } from './useInboxFilters';
import s from './InboxFilters.module.css';
export default function InboxFilters({ apiKey, page, request, busy, refresh, panel }) {
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [undo, setUndo] = useState(null);
  const currentKey = useRef(apiKey), alive = useRef(true);
  currentKey.current = apiKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setUndo(null); setError(''); setPending(false); }, [apiKey]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), Math.max(0, undo.token.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [undo]);
  const kinds = page?.filters?.kinds || [], snapshot = page?.filters?.snapshot;
  const announce = () => window.dispatchEvent(new Event(INBOX_EVENT));
  function choose(next) {
    window.history.pushState(null, '', filterUrl(window.location.href, next));
    window.dispatchEvent(new Event(INBOX_FILTER_EVENT));
  }
  async function mark() {
    setPending(true); setError('');
    const key = apiKey;
    try {
      // The full snapshot is deliberate: marking all is independent of the selected chips.
      const token = await markAllRead(request, window.localStorage, snapshot);
      if (alive.current && currentKey.current === key) { setUndo({ key, token }); announce(); }
    } catch (e) { if (alive.current && currentKey.current === key) setError(e.message); }
    finally { if (alive.current && currentKey.current === key) setPending(false); }
  }
  function restore() {
    try {
      if (!undoMarkAllRead(window.localStorage, undo?.token, page?.seen_scope || undo?.token.scope)) throw new Error('Undo is no longer available. Refresh to see the current inbox.');
      setUndo(null); announce();
    } catch (e) { setUndo(null); setError(e.message); }
  }
  return <div className={s.controls}>
    <div className={s.chips} role="group" aria-label="Filter inbox by kind">
      <button type="button" aria-pressed={!kinds.length} onClick={() => choose([])}>All <span>{Object.values(page?.filters?.counts || {}).reduce((a, b) => a + b, 0)}</span></button>
      {INBOX_GROUPS.map(([kind, label]) => <button type="button" key={kind} aria-pressed={kinds.includes(kind)} onClick={() => choose(kinds.includes(kind) ? kinds.filter(value => value !== kind) : [...kinds, kind])}>{label} <span>{page?.filters?.counts[kind] || 0}</span></button>)}
    </div>
    <div className={s.actions}><button type="button" className="text-button" disabled={busy || pending} onClick={refresh}>Refresh</button><button type="button" className="text-button" disabled={!snapshot || busy || pending} onClick={mark}>Mark all read</button>{panel && <a className="inline-link" href={typeof window === 'undefined' ? '/dashboard/#inbox' : filterUrl(window.location.origin + '/dashboard/' + window.location.search + '#inbox', kinds)}>Open inbox</a>}</div>
    {undo?.key === apiKey && (!page || undo.token.scope === page.seen_scope) && <p role="status">Marked all read. <button type="button" className="text-button" disabled={pending} onClick={restore}>Undo</button> <span className="help-text">Available for 10 seconds.</span></p>}
    {error && <p role="alert" className="error">{error}</p>}
    <p className="help-text">Read time stays in this browser for this account or key. Mark all read includes every kind. Requests that still need a decision stay highlighted. Counts cover returned items; Activity shows retained event history. Host updates show the current status and record update time; earlier status changes are not retained here.</p>
  </div>;
}
export function InboxItemReadState({ item }) {
  const decision = item.kind === 'approval' && item.status === 'pending';
  return <p className={s.readState} data-inbox-decision={decision || undefined}>{decision && <strong>Needs a decision · </strong>}{item.unread ? 'Unread' : 'Read'}</p>;
}
