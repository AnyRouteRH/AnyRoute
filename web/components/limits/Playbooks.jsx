'use client';
// U115: Playbooks, in Keys & limits. List the account's (or the team's) playbooks, make one from a starter setup or from a
// key's current rules, edit it in the shared spending limits editor and see which keys follow it. GET/POST/PUT/DELETE
// /api/v1/playbooks; the router copies each change to every following key.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { FEATURE_OFF, errorState, utcTime } from '../../lib/agents';
import { PLAYBOOK_WORDS as W, deleteRequest, followersText, linkedPlaybook, playbookBody, playbookForm, playbookPath, scopeText, startChoices, startRules } from '../../lib/playbooks';
import { RulebookSentences } from './RulebookSentences'; // B124
import SpendingLimits, { useAgentGuard } from './SpendingLimits';
import { Button } from '../UI';
import st from './SpendingLimits.module.css';

function Editor({ id, playbook, agents, guard, busy, onSave, onCancel }) {
  const isNew = !playbook;
  const [name, setName] = useState(playbook?.name ?? '');
  const [start, setStart] = useState('empty');
  const [form, setForm] = useState(() => playbookForm(playbook?.policy));
  const [errors, setErrors] = useState([]);
  const choices = isNew ? startChoices(agents) : [];
  const built = playbookBody(name, form);
  const group = label => choices.filter(c => c.group === label).map(c => <option key={c.value} value={c.value}>{c.label}</option>);
  return <form onSubmit={e => { e.preventDefault(); setErrors(built.errors); if (!built.errors.length) onSave(built.body); }}>
    <div className="field"><label htmlFor={`${id}-name`}>{W.name}</label><input id={`${id}-name`} maxLength={100} value={name} onChange={e => setName(e.target.value)}/></div>
    {isNew && <div className="field"><label htmlFor={`${id}-start`}>{W.from}</label>
      <select id={`${id}-start`} value={start} disabled={busy} onChange={e => { setStart(e.target.value); setForm(playbookForm(startRules(e.target.value, agents, { guard }))); }}>
        <option value="empty">{W.empty}</option>
        <optgroup label={W.setups}>{group(W.setups)}</optgroup>
        {choices.some(c => c.group === W.keys) && <optgroup label={W.keys}>{group(W.keys)}</optgroup>}
      </select>
      <p className="help-text">Fills the rules below. Nothing is saved until you save.</p>
    </div>}
    <SpendingLimits id={id} value={form} onChange={setForm} disabled={busy} scope guard={guard || form.guard != null}/>
    <p className="help-text">{W.editorHelp}</p>
    {errors.length > 0 && <ul className="error" role="alert">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
    <div className="button-row">
      <Button type="submit" disabled={busy}>{W.save}</Button>
      <Button type="button" secondary disabled={busy} onClick={onCancel}>{W.cancel}</Button>
    </div>
  </form>;
}

function Card({ playbook: p, open, busy, onEdit, onDelete, children }) {
  return <li id={'playbook-' + p.id} className={st.playbook} aria-current={open || undefined}>
    <h3>{p.name}</h3>
    <div className={st.badges}><span className="badge">{scopeText(p)}</span><span className="badge">Version {p.version}</span><span className="badge">{followersText(p.followers)}</span></div>
    <RulebookSentences policy={p.policy}/> {/* B124 */}
    <p className="help-text">Rules SHA-256 {p.sha256.slice(0, 16)}… · Changed {utcTime(p.updated_at)}</p>
    {p.keys.length > 0 && <ul>{p.keys.map(k => <li key={k.key_hash}><a href={`/agents/?agent=${encodeURIComponent(k.key_hash)}`}>{k.name || 'Unnamed key'}</a> · {k.key_hash.slice(0, 12)}</li>)}</ul>}
    {p.followers > p.keys.length && <p className="help-text">{p.followers - p.keys.length} more in other teams.</p>}
    {p.can_edit ? <div className="button-row"><Button type="button" secondary disabled={busy} onClick={onEdit}>{W.edit}</Button><Button type="button" secondary disabled={busy} onClick={onDelete}>{W.remove}</Button></div> : <p className="help-text">{W.readOnly}</p>}
    {children}
  </li>;
}

export default function Playbooks({ live, apiKey }) {
  const guard = useAgentGuard();
  const request = useCallback((path, options = {}) => api(path, { ...options, key: apiKey }), [apiKey]);
  const [list, setList] = useState(null);
  const [agents, setAgents] = useState([]);
  const [view, setView] = useState({ busy: false, off: false, error: '', notice: '' });
  const [editing, setEditing] = useState(undefined); // undefined: none; null: a new playbook; an id: that playbook
  const [open, setOpen] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!live || !apiKey) return;
    const ac = new AbortController();
    setView(v => ({ ...v, busy: true, error: '' }));
    Promise.all([request(playbookPath(), { signal: ac.signal }), request('/api/v1/agents', { signal: ac.signal }).catch(() => ({ data: [] }))]).then(([p, a]) => {
      if (ac.signal.aborted) return;
      const rows = Array.isArray(p.data) ? p.data : [];
      setList(rows); setAgents(Array.isArray(a.data) ? a.data : []);
      setOpen(old => old ?? linkedPlaybook(window.location.search, rows));
      setView(v => ({ ...v, busy: false }));
    }).catch(e => { if (!ac.signal.aborted) { const s = errorState(e); setView(v => ({ ...v, busy: false, off: s.off, error: s.off ? '' : s.message })); } });
    return () => ac.abort();
  }, [live, apiKey, request, revision]);
  useEffect(() => { if (open && list) document.getElementById('playbook-' + open)?.scrollIntoView({ block: 'center' }); }, [open, list]); // ?playbook=<id> from a key's link
  const mutate = async (action, notice) => {
    setView(v => ({ ...v, busy: true, error: '', notice: '' }));
    try { await action(); setEditing(undefined); setView(v => ({ ...v, notice })); setRevision(r => r + 1); }
    catch (e) { setView(v => ({ ...v, busy: false, error: e?.message || 'The request could not be completed.' })); }
  };
  const remove = p => { const next = deleteRequest(p); if (window.confirm(next.confirm)) mutate(() => request(next.path, { method: 'DELETE' }), 'Playbook deleted.'); };
  const editor = p => <Editor id={p ? 'playbook-edit' : 'playbook-new'} playbook={p} agents={agents} guard={guard} busy={view.busy}
    onSave={body => mutate(() => p ? request(playbookPath(p.id), { method: 'PUT', body }) : request(playbookPath(), { method: 'POST', body }), 'Playbook saved.')}
    onCancel={() => setEditing(undefined)}/>;
  return <section className="control-panel" aria-labelledby="playbooks-title">
    <div className="panel-heading"><h2 id="playbooks-title">{W.title}</h2></div>
    <p>{W.intro}</p>
    {!live || !apiKey ? <p className="help-text">{W.connect}</p> : view.off ? <p role="status">{FEATURE_OFF}</p> : <>
      {view.busy && <p role="status">Reading playbooks…</p>}
      {view.error && <div className="error" role="alert">{view.error}</div>}
      {view.notice && <p role="status">{view.notice}</p>}
      {list && !list.length && <p>{W.none}</p>}
      {list && list.length > 0 && <ul className={st.playbooks}>{list.map(p => <Card key={p.id} playbook={p} open={open === p.id} busy={view.busy} onEdit={() => setEditing(p.id)} onDelete={() => remove(p)}>{editing === p.id && editor(p)}</Card>)}</ul>}
      {list && (editing === null ? editor(null) : <Button type="button" disabled={view.busy} onClick={() => setEditing(null)}>{W.create}</Button>)}
      <p className="help-text">Keys follow a playbook from their spending limits, here in API keys or on <a className="inline-link" href="/agents/">Agents</a>. A key follows one playbook or keeps its own rules, never both. Stop and Resume stay per key.</p>
    </>}
  </section>;
}
