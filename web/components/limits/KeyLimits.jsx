'use client';
// U102: spending limits for any key, from where keys are managed. The same endpoints as /agents: the key's rulebook,
// plus kill and resume for Stop and Resume. Rules this editor does not show are written back unchanged.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { FEATURE_OFF, confirmKill, errorState, utcTime } from '../../lib/agents';
import { LIMIT_WORDS as W, limitsFromRulebook, rulebookFromLimits } from '../../lib/spending-limits';
import SpendingLimits, { useAgentGuard } from './SpendingLimits';
import { Button, Modal } from '../UI';

export default function KeyLimits({ apiKey, keyHash, name, current, onClose }) {
  const guard = useAgentGuard();
  const [row, setRow] = useState(null);
  const [form, setForm] = useState(null);
  const [view, setView] = useState({ busy: true, off: false, error: '', notice: '' });
  const [errors, setErrors] = useState([]);
  const [revision, setRevision] = useState(0);
  const request = useCallback((path, options = {}) => api(path, { ...options, key: apiKey }), [apiKey]);
  const path = '/api/v1/agents/' + encodeURIComponent(keyHash);
  useEffect(() => {
    const ac = new AbortController();
    setView(v => ({ ...v, busy: true, error: '' }));
    request('/api/v1/agents', { signal: ac.signal }).then(r => {
      if (ac.signal.aborted) return;
      const found = Array.isArray(r.data) ? r.data.find(a => a.key_hash === keyHash) : null;
      if (!found) throw new Error('The signed-in key cannot manage this key’s spending limits.');
      const own = found.policies?.find(p => !p.inherited && p.key_hash === keyHash) ?? null;
      setRow({ inherited: (found.policies || []).filter(p => p.inherited).length, own });
      setForm(limitsFromRulebook(own?.policy ?? null)); setErrors([]);
      setView(v => ({ ...v, busy: false }));
    }).catch(e => { if (!ac.signal.aborted) { const state = errorState(e); setView(v => ({ ...v, busy: false, off: state.off, error: state.off ? '' : state.message })); } });
    return () => ac.abort();
  }, [request, keyHash, revision]);
  const mutate = async (action, notice) => {
    setView(v => ({ ...v, busy: true, error: '', notice: '' }));
    try { if (await action() === false) return setView(v => ({ ...v, busy: false })); setView(v => ({ ...v, notice })); setRevision(r => r + 1); }
    catch (e) { setView(v => ({ ...v, busy: false, error: e.message || 'The request could not be completed.' })); }
  };
  const own = row?.own;
  const stop = { stopped: !!own?.killed, ready: !!own, busy: view.busy, reason: true,
    detail: own?.killed ? `Since ${utcTime(own.killed_at)}. Reason: ${own.killed_reason || 'Not recorded'}.` : null,
    onStop: reason => mutate(() => confirmKill({ key_hash: keyHash, name }, reason, message => window.confirm(message), request), 'Stopped.'),
    onResume: () => mutate(() => request(path + '/resume', { method: 'POST' }), 'Resumed.') };
  const built = form && rulebookFromLimits(form);
  return <Modal title={`${W.title} · ${name}`} onClose={onClose}>
    <p className="help-text">Saved as this key’s rulebook; the router enforces it. UTC windows, circuit breakers, alerts and request checks are on <a className="inline-link" href="/agents/">Agents</a>, and saving here keeps them as they are. This key’s budget still applies.{current ? ' These limits also apply to the key signed in here.' : ''}</p>
    {view.off && <p role="status">{FEATURE_OFF}</p>}
    {view.busy && !form && !view.off && <p role="status">Reading spending limits…</p>}
    {view.error && <div className="error" role="alert">{view.error}</div>}
    {form && <form onSubmit={e => { e.preventDefault(); setErrors(built.errors); if (!built.errors.length) mutate(() => request(path + '/policy', { method: 'PUT', body: built.policy }), 'Spending limits saved.'); }}>
      <SpendingLimits key={revision} id="key-limits" value={form} onChange={setForm} disabled={view.busy} setups="key" scope guard={guard || own?.policy?.actions !== undefined} stop={stop}/>
      {row.inherited > 0 && <p className="help-text">This key also follows {row.inherited === 1 ? 'an inherited rulebook' : `${row.inherited} inherited rulebooks`} from the key that created it. Change those on that key.</p>}
      {errors.length > 0 && <ul className="error" role="alert">{errors.map(error => <li key={error}>{error}</li>)}</ul>}
      <div className="button-row"><Button type="submit" disabled={view.busy}>{W.save}</Button>{own && <Button type="button" secondary disabled={view.busy} onClick={() => { if (window.confirm('Remove these spending limits? Their rules will no longer apply.')) mutate(() => request(path + '/policy', { method: 'DELETE' }), 'Spending limits removed.'); }}>{W.remove}</Button>}</div>
    </form>}
    {view.notice && <p role="status">{view.notice}</p>}
    <p className="help-text">{W.scopeOnly}</p>
  </Modal>;
}
