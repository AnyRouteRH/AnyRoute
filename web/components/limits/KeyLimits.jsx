'use client';
// U102: spending limits for any key, from where keys are managed. The same endpoints as /agents: the key's rulebook,
// plus kill and resume for Stop and Resume. Rules this editor does not show are written back unchanged.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { FEATURE_OFF, confirmKill, errorState, formatUsd, utcTime } from '../../lib/agents';
import { LIMIT_WORDS as W, KEY_BUDGET_WORDS as KB, budgetResetText, keyBudgetText, keySaveNotice, keySavePlan, limitsFromRulebook, rulebookFromLimits, saveKeyLimits, topupSummary, topupText } from '../../lib/spending-limits';
import ReplayResult, { ReplayButton, useRuleReplay } from './ReplayRules'; // Replay your rules
import SpendingLimits, { KeyBudgetField, LimitGroup, useAgentGuard } from './SpendingLimits';
import { Button, Modal } from '../UI';

// U104: the key's total budget (its own limit) is set here too, beside the caps. Save writes the budget with PATCH
// /api/v1/keys/:hash when it changed and the rulebook as before; with rulebooks switched off, the budget alone.
// U113: Auto top-up sits under the total budget and saves in the same PATCH (`topup`), read fresh with this week's top-ups.
export default function KeyLimits({ apiKey, keyHash, name, current, budget = null, reset = null, spent = null, topup = null, onSaved, onClose }) {
  const guard = useAgentGuard();
  const [row, setRow] = useState(null);
  const [form, setForm] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [savedBudget, setSavedBudget] = useState(budget);
  const [budgetValue, setBudgetValue] = useState(() => keyBudgetText(budget));
  const [savedTopup, setSavedTopup] = useState(topup);
  const [topupValue, setTopupValue] = useState(() => topupText(topup));
  const [week, setWeek] = useState(null);
  const [view, setView] = useState({ busy: true, off: false, error: '', notice: '' });
  const [errors, setErrors] = useState([]);
  const [revision, setRevision] = useState(0);
  const request = useCallback((path, options = {}) => api(path, { ...options, key: apiKey }), [apiKey]);
  const path = '/api/v1/agents/' + encodeURIComponent(keyHash);
  const replay = useRuleReplay(request, keyHash);
  const draft = form ? rulebookFromLimits(form) : null;
  const replayNow = () => { if (form) replay.run(rulebookFromLimits(form)); };
  const replaySetup = () => { replayNow(); replay.reveal(); }; // Start from a setup: Replay it first
  useEffect(() => {
    const ac = new AbortController();
    setView(v => ({ ...v, busy: true, error: '' }));
    request('/api/v1/agents', { signal: ac.signal }).then(r => {
      if (ac.signal.aborted) return;
      const found = Array.isArray(r.data) ? r.data.find(a => a.key_hash === keyHash) : null;
      if (!found) throw new Error('The signed-in key cannot manage this key’s spending limits.');
      const own = found.policies?.find(p => !p.inherited && p.key_hash === keyHash) ?? null;
      setRow({ inherited: (found.policies || []).filter(p => p.inherited).length, own });
      const initial = limitsFromRulebook(own?.policy ?? null);
      setForm(initial); setLoaded(initial); setErrors([]);
      setView(v => ({ ...v, busy: false }));
    }).catch(e => { if (!ac.signal.aborted) { const state = errorState(e); setView(v => ({ ...v, busy: false, off: state.off, error: state.off ? '' : state.message })); } });
    return () => ac.abort();
  }, [request, keyHash, revision]);
  useEffect(() => {
    const ac = new AbortController();
    request('/api/v1/keys/' + encodeURIComponent(keyHash), { signal: ac.signal }).then(r => {
      if (ac.signal.aborted || !r?.data) return;
      setSavedTopup(r.data.topup ?? null); setTopupValue(topupText(r.data.topup ?? null)); setWeek(r.data.topups_this_week_usd ?? null);
    }).catch(() => {});
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
  const budgetField = { value: budgetValue, onChange: setBudgetValue, help: [KB.help, budgetResetText(reset), spent == null ? '' : `Spent so far: ${formatUsd(spent)}.`].filter(Boolean).join(' '),
    topup: { value: topupValue, onChange: setTopupValue, summary: topupSummary(topupValue, { week, reset }) } };
  const save = e => {
    e.preventDefault();
    const plan = keySavePlan({ form, loaded, budget: budgetValue, savedBudget, topup: topupValue, savedTopup, reset });
    setErrors(plan.errors);
    if (plan.errors.length) return;
    mutate(() => saveKeyLimits(request, keyHash, plan, (limit, body) => { if (limit !== undefined) setSavedBudget(limit); if (body.topup !== undefined) setSavedTopup(body.topup); onSaved?.(); }), keySaveNotice(plan));
  };
  const failed = errors.length > 0 && <ul className="error" role="alert">{errors.map(error => <li key={error}>{error}</li>)}</ul>;
  return <Modal title={`${W.title} · ${name}`} onClose={onClose}>
    <p className="help-text">Caps and rules are saved as this key’s rulebook, and the total budget and auto top-up on the key itself; the router enforces both. UTC windows, circuit breakers, alerts and request checks are on <a className="inline-link" href="/agents/">Agents</a>, and saving here keeps them as they are.{current ? ' These limits also apply to the key signed in here.' : ''}</p>
    {view.off && <p role="status">{FEATURE_OFF}</p>}
    {view.busy && !form && !view.off && <p role="status">Reading spending limits…</p>}
    {view.error && <div className="error" role="alert">{view.error}</div>}
    {form && <form onSubmit={save}>
      <SpendingLimits key={revision} id="key-limits" value={form} onChange={setForm} disabled={view.busy} setups="key" scope guard={guard || own?.policy?.actions !== undefined} onReplay={replaySetup} budget={budgetField} stop={stop}/>
      {row.inherited > 0 && <p className="help-text">This key also follows {row.inherited === 1 ? 'an inherited rulebook' : `${row.inherited} inherited rulebooks`} from the key that created it. Change those on that key.</p>}
      {failed}
      <div className="button-row"><Button type="submit" disabled={view.busy}>{W.save}</Button><ReplayButton replay={replay} disabled={view.busy} onRun={replayNow}/>{own && <Button type="button" secondary disabled={view.busy} onClick={() => { if (window.confirm('Remove these spending limits? Their rules will no longer apply.')) mutate(() => request(path + '/policy', { method: 'DELETE' }), 'Spending limits removed.'); }}>{W.remove}</Button>}</div>
      <ReplayResult id="key-limits-replay" replay={replay} current={draft?.policy}/>
    </form>}
    {!form && view.off && <form onSubmit={save}>
      <LimitGroup title={KB.title} disabled={view.busy}><KeyBudgetField id="key-limits" budget={budgetField}/></LimitGroup>
      {failed}
      <div className="button-row"><Button type="submit" disabled={view.busy}>{KB.save}</Button></div>
    </form>}
    {view.notice && <p role="status">{view.notice}</p>}
    <p className="help-text">{W.scopeOnly}</p>
  </Modal>;
}
