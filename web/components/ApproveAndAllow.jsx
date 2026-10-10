'use client';
// B118: a second explicit confirmation before changing the rulebook.
import { useEffect, useState } from 'react';
import { Button } from './UI';
import s from './ApproveAndAllow.module.css';
import { allowChangeText, confirmAllowChange, playbookAllowLink, readAllowChange } from '../lib/approve-and-allow.js';
export default function ApproveAndAllow({ request, id, disabled, onApproved }) {
  const [change, setChange] = useState(null), [review, setReview] = useState(false);
  const [book, setBook] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [forbidden, setForbidden] = useState(false); // E153
  useEffect(() => {
    const ac = new AbortController(); setForbidden(false); setChange(null); setBook(null); setReview(false);
    readAllowChange(request, id, ac.signal).then(r => { if (!ac.signal.aborted) setChange(r.data); }).catch(e => {
      if (ac.signal.aborted) return;
      if (e.status === 403) { setForbidden(true); setError(''); } // E153
      else if (e.type === 'playbook_linked') setBook({ id: e.metadata?.playbook_id, message: e.message });
      else if (e.status !== 409) setError(e.message);
    });
    return () => ac.abort();
  }, [request, id, revision]);
  async function confirm() {
    setBusy(true); setError('');
    try {
      await confirmAllowChange(request, id, change);
      window.dispatchEvent(new Event('anyroute:agents-changed'));
      window.dispatchEvent(new Event('anyroute-inbox-changed'));
      onApproved?.();
    } catch (e) { setError(e.message); setRevision(r => r + 1); }
    finally { setBusy(false); }
  }
  if (forbidden) return null; // E153: delegated approval never offers rulebook changes.
  return <div style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
    {book && <p className="help-text">{book.message} <a className="inline-link" href={playbookAllowLink(book.id)}>Open playbook</a></p>}
    {change && !review && <Button secondary className={s.option} disabled={disabled || busy} onClick={() => setReview(true)}>Approve and allow next time</Button>}
    {change && review && <div className={"control-panel " + s.review} aria-label="Review ask-first amount">
      <p>{allowChangeText(change)}</p><p className="help-text">Only this agent’s ask-first amount changes. Caps and other rules still apply. This approval stays single-use and expires at its original deadline.</p>
      <div className="button-row"><Button className={s.option} disabled={disabled || busy} onClick={confirm}>{busy ? 'Saving…' : 'Confirm and approve'}</Button><Button secondary disabled={busy} onClick={() => setReview(false)}>Cancel</Button></div>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
