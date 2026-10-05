'use client';
// U115: on each key and agent, "Follows playbook X" with a link and Stop following, or Use a playbook to pick one.
// POST /api/v1/agents/:key_hash/playbook, after the same kind of confirmation the page asks before Stop.
import { useEffect, useState } from 'react';
import { Button } from '../UI';
import { PLAYBOOK_WORDS as W, followRequest, followersText, playbookHref, playbookPath } from '../../lib/playbooks';
import st from './SpendingLimits.module.css';

export default function FollowPlaybook({ id, keyHash, playbook, request, onChanged, disabled = false }) {
  const [books, setBooks] = useState(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const following = !!playbook;
  useEffect(() => {
    if (following) return;
    const ac = new AbortController();
    setBooks(null); setChoice('');
    request(playbookPath(), { signal: ac.signal }).then(r => { if (!ac.signal.aborted) setBooks(Array.isArray(r.data) ? r.data : []); }).catch(() => { if (!ac.signal.aborted) setBooks([]); });
    return () => ac.abort();
  }, [request, following, keyHash]);
  const run = async target => {
    const next = followRequest(keyHash, target);
    if (!window.confirm(next.confirm)) return;
    setBusy(true); setError('');
    try { await request(next.path, { method: 'POST', body: next.body }); onChanged?.(); }
    catch (e) { setError(e?.message || 'The request could not be completed.'); }
    finally { setBusy(false); }
  };
  return <fieldset disabled={disabled || busy} className={st.group}><legend>{W.title}</legend>
    {playbook ? <>
      <p className={st.state}><span className="badge">Follows a playbook</span><span>Follows playbook <a href={playbookHref(playbook.id)}>{playbook.name}</a>, version {playbook.version}.</span></p>
      <p className="help-text">{W.locked}</p>
      <Button type="button" secondary onClick={() => run(null)}>{W.stop}</Button>
    </> : <>
      <div className="field"><label htmlFor={`${id}-playbook`}>{W.follow}</label>
        <select id={`${id}-playbook`} value={choice} onChange={e => setChoice(e.target.value)}>
          <option value="">{books === null ? 'Reading playbooks…' : books.length ? W.choose : 'No playbooks yet'}</option>
          {(books || []).map(b => <option key={b.id} value={b.id}>{b.name} · {followersText(b.followers)}</option>)}
        </select>
      </div>
      <Button type="button" secondary disabled={!choice} onClick={() => run(books.find(b => b.id === choice))}>{W.followButton}</Button>
      <p className="help-text">{W.followHelp} <a href="/dashboard/#playbooks">Manage playbooks</a></p>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </fieldset>;
}
