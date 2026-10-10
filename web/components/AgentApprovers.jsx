'use client';
// E153
import { useEffect, useId, useState } from 'react';
import { Button } from './UI';
import { APPROVER_MODES, approversBody, approversPath } from '../lib/agent-approvers';
export default function AgentApprovers({ request, keyHash }) {
  const id = useId();
  const [data, setData] = useState(null), [mode, setMode] = useState('owners'), [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useEffect(() => {
    const ac = new AbortController(); setData(null); setError(''); setSaved(false);
    request(approversPath(keyHash), { signal: ac.signal }).then(({ data }) => {
      if (ac.signal.aborted) return;
      setData(data); setMode(data.mode); setMembers(data.member_ids);
    }).catch(e => { if (!ac.signal.aborted && e.status !== 404) setError(e.message); });
    return () => ac.abort();
  }, [request, keyHash]);
  if (!data) return error ? <p role="alert">{error}</p> : null;
  return <section className="control-panel" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><h2>Who can approve</h2>
    <p className="help-text">Choose who reviews this agent’s requests. Owners can always approve. Teammates cannot decide their own agent key’s requests. Approve and allow next time changes rules and stays with owners and admins.</p>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setSaved(false);
      try { const result = await request(approversPath(keyHash), { method: 'PUT', body: approversBody(mode, members) }); setData(result.data); setSaved(true); window.dispatchEvent(new Event('anyroute-inbox-changed')); }
      catch (e) { setError(e.message); } finally { setBusy(false); }
    }}><div className="field"><label htmlFor={id}>Who can approve</label><select id={id} value={mode} disabled={busy} onChange={e => { setMode(e.target.value); setSaved(false); }}>{APPROVER_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      {mode === 'specific_members' && <fieldset disabled={busy}><legend>Pick teammates</legend>{data.members.length ? data.members.map(member => <label key={member.id} className="check-label"><input type="checkbox" checked={members.includes(member.id)} onChange={e => { setMembers(old => e.target.checked ? [...old, member.id] : old.filter(id => id !== member.id)); setSaved(false); }}/>{member.name} · {member.role}</label>) : <p>No eligible teammates. Add teammates to this agent’s team first.</p>}</fieldset>}
      {error && <p role="alert">{error}</p>}{saved && <p role="status">Approvers saved.</p>}<Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save approvers'}</Button>
    </form><p className="help-text">Allowed approvers see pending requests in their inbox and on Agents. They can link their own Telegram for approval buttons. Telegram can read approval details. Approval still works once and expires at its original time.</p>
  </section>;
}
