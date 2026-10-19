'use client';
// K187
import { useEffect, useRef, useState } from 'react';
import { INBOX_EVENT } from '../../lib/inbox.js';
import { snoozeNotice, snoozeUntil, snoozeUrl, snoozedSelected, unsnoozeNotice } from '../../lib/inbox-snooze.js';
import { INBOX_FILTER_EVENT } from './useInboxFilters';
import s from './InboxSnooze.module.css';
const FEEDBACK = 'anyroute-inbox-snooze-feedback';
export function SnoozedChip({ busy }) {
  const [active, setActive] = useState(false);
  useEffect(() => { const sync = () => setActive(snoozedSelected(window.location.search)); sync(); window.addEventListener('popstate', sync); window.addEventListener(INBOX_FILTER_EVENT, sync); return () => { window.removeEventListener('popstate', sync); window.removeEventListener(INBOX_FILTER_EVENT, sync); }; }, []);
  function choose() { window.history.pushState(null, '', snoozeUrl(window.location.href, !active)); window.dispatchEvent(new Event(INBOX_FILTER_EVENT)); }
  return <button type="button" aria-pressed={active} disabled={busy} onClick={choose}>Snoozed</button>;
}
export function SnoozeFeedback({ apiKey }) {
  const [message, setMessage] = useState('');
  useEffect(() => { setMessage(''); const receive = event => { if (event.detail.key === apiKey) setMessage(event.detail.message); }; window.addEventListener(FEEDBACK, receive); return () => window.removeEventListener(FEEDBACK, receive); }, [apiKey]);
  return message ? <p role="status">{message}</p> : null;
}
export default function InboxSnooze({ item, request, apiKey, disabled }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), currentKey = useRef(apiKey); currentKey.current = apiKey;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(choice) {
    const key = apiKey; setBusy(true); setError('');
    try {
      const result = choice === 'undo' ? await unsnoozeNotice(request, item) : await snoozeNotice(request, item, snoozeUntil(choice));
      if (alive.current && currentKey.current === key) {
        const message = result.capped ? result.message : choice === 'undo' ? 'Notice returned to your inbox as unread.' : 'Notice snoozed until ' + new Date(result.until).toLocaleString() + '.';
        window.dispatchEvent(new CustomEvent(FEEDBACK, { detail: { key, message } })); window.dispatchEvent(new Event(INBOX_EVENT));
      }
    } catch (e) { if (alive.current && currentKey.current === key) setError(e.message); }
    finally { if (alive.current && currentKey.current === key) setBusy(false); }
  }
  return <div className={s.controls}>
    {item.snoozed_until ? <><p>Returns <time dateTime={item.snoozed_until}>{new Date(item.snoozed_until).toLocaleString()}</time></p><button type="button" className="text-button" disabled={disabled || busy} onClick={() => run('undo')}>Unsnooze</button></> : <details><summary>Snooze</summary><div className={s.options}>{[['hour', 'Snooze for 1 hour'], ['tomorrow', 'Snooze until tomorrow 9:00'], ['monday', 'Snooze until Monday']].map(([choice, label]) => <button type="button" className="text-button" key={choice} disabled={disabled || busy} onClick={() => run(choice)}>{label}</button>)}</div>{item.expires_at && <p className="help-text">Snoozing stops at this approval’s expiry. It does not extend the time to decide.</p>}</details>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
