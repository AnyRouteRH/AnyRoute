'use client';
import { SealedBadge } from './SealedAgent';
import TelegramLink from "./TelegramLink";
import Autonomy from "./Autonomy";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/UI';
import { api, loadKey, saveKey, clearKey, validKey } from '../../lib/api';
import { LANES, DAYS, CAP_FIELDS, LIMITS, FEATURE_OFF, buildPolicy, policyForm, capBars, reasonText, decisionText, intentSummary, eventsPage, sampleIntent, confirmKill, errorState, utcTime } from '../../lib/agents';
import s from './agents.module.css';
import Approvals from './Approvals';
import { BreakersForm, TrippedBadge } from './Breakers';
import AgentWorkspace from './AgentWorkspace';
import Alerts from './Alerts';
import AlertFields from './AlertFields';

function Field({ label, id, children }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}</div>;
}
function Errors({ errors }) {
  return errors.length > 0 && <ul className={s.errors} role="alert">{errors.map(e => <li key={e}>{e}</li>)}</ul>;
}
function Spend({ agent }) {
  return <div className={s.bars}>{capBars(agent).map(bar => <div key={bar.period}><span className={s.barLabel}><span>Rolling {bar.period}</span><span>{bar.label}</span></span><progress max="100" value={bar.percent} aria-label={`Rolling ${bar.period}: ${bar.label}`}/></div>)}</div>;
}

function RulebookForm({ policy, onSave, onRemove, busy, hasPolicy }) {
  const [form, setForm] = useState(() => policyForm(policy));
  const [errors, setErrors] = useState([]);
  const [json, setJson] = useState(false);
  const set = (name, value) => setForm(f => ({ ...f, [name]: value }));
  const windowSet = (index, patch) => setForm(f => ({ ...f, windows: f.windows.map((w, i) => i === index ? { ...w, ...patch } : w) }));
  const built = buildPolicy(form);
  return <form onSubmit={e => { e.preventDefault(); setErrors(built.errors); if (!built.errors.length) onSave(built.policy); }}>
    <fieldset disabled={busy} className={s.fieldset}><legend>Models and tools</legend><p className="help-text">One entry per line or comma. Model identifiers and author/* patterns are accepted. Deny wins. Blank lists add no restriction.</p>
      <div className="two-fields">{[['modelAllow','Allowed models'],['modelDeny','Denied models'],['toolAllow','Allowed tools'],['toolDeny','Denied tools']].map(([name,label]) => <Field key={name} id={name} label={label}><textarea id={name} value={form[name]} onChange={e => set(name,e.target.value)} rows={3}/></Field>)}</div>
    </fieldset>
    <fieldset disabled={busy} className={s.fieldset}><legend>Allowed lanes</legend><label className="check-label"><input type="checkbox" checked={form.restrictLanes} onChange={e => set('restrictLanes',e.target.checked)}/>Restrict lanes</label>
      <div className={s.checks}>{LANES.map(lane => <label className="check-label" key={lane}><input type="checkbox" disabled={!form.restrictLanes} checked={form.lanes.includes(lane)} onChange={e => set('lanes',e.target.checked ? [...form.lanes,lane] : form.lanes.filter(l => l !== lane))}/>{lane}</label>)}</div>
      <p className="help-text">With restrictions on, no checked lanes means every lane is denied. Selecting a lane does not establish its availability.</p>
    </fieldset>
    <fieldset disabled={busy} className={s.fieldset}><legend>Budget caps</legend><p className="help-text">Blank caps are omitted. Spend uses rolling hour, day and week windows.</p>
      <div className="two-fields">{CAP_FIELDS.map(name => <Field key={name} id={name} label={name === 'max_output_tokens' ? 'Maximum output tokens' : `${name.replace('per_', 'Per ').replace('_usd', '')} cap (USD)`}><input id={name} type="number" min={name === 'max_output_tokens' ? 1 : 0} max={name === 'max_output_tokens' ? LIMITS.tokens : LIMITS.usd} step={name === 'max_output_tokens' ? 1 : 'any'} value={form.caps[name]} onChange={e => set('caps',{ ...form.caps,[name]:e.target.value })}/></Field>)}</div>
    </fieldset>
    <fieldset disabled={busy} className={s.fieldset}><legend>Time windows (UTC)</legend><label className="check-label"><input type="checkbox" checked={form.restrictWindows} onChange={e => set('restrictWindows',e.target.checked)}/>Only allow requests within these UTC windows</label><p className="help-text">No windows while this restriction is on denies every time. The router evaluates window boundaries.</p>
      {form.restrictWindows && <>{form.windows.map((w,index) => <div className={s.window} key={index}><div className={s.checks}>{DAYS.map((day,d) => <label className="check-label" key={day}><input type="checkbox" checked={w.days.includes(d)} onChange={e => windowSet(index,{ days:e.target.checked ? [...w.days,d] : w.days.filter(v => v !== d) })}/>{day}</label>)}</div><div className="two-fields">{['start','end'].map(time => <Field key={time} id={`window-${index}-${time}`} label={`${time} (UTC)`}><input id={`window-${index}-${time}`} type="time" step="60" required value={w[time]} onChange={e => windowSet(index,{ [time]:e.target.value })}/></Field>)}</div><button type="button" className="text-button" onClick={() => set('windows',form.windows.filter((_,i) => i !== index))}>Remove window {index+1}</button></div>)}<Button type="button" secondary disabled={form.windows.length >= 64} onClick={() => set('windows',[...form.windows,{ days:[1,2,3,4,5],start:'09:00',end:'17:00' }])}>Add UTC window</Button></>}
    </fieldset>
    <fieldset disabled={busy} className={s.fieldset}><legend>Approval and breaches</legend><Field label="Require approval above (USD)" id="approval"><input id="approval" type="number" step="any" max={LIMITS.usd} value={form.approval} onChange={e => set('approval',e.target.value)}/></Field><Field label="On breach" id="breach"><select id="breach" value={form.onBreach} onChange={e => set('onBreach',e.target.value)}><option value="deny">Deny this request</option><option value="kill">Kill agent</option></select></Field><p className="help-text">A kill breach stops future requests until the principal resumes the agent.</p></fieldset>
    <BreakersForm values={form.breakers} onChange={values => set('breakers', values)} busy={busy}/>
    <AlertFields value={form.alerts} onChange={value => set('alerts',value)} disabled={busy}/>
    <Errors errors={errors}/><div className="button-row"><Button type="submit" disabled={busy}>Save rulebook</Button>{hasPolicy && <Button type="button" secondary disabled={busy} onClick={() => { if (window.confirm('Remove this rulebook? Its restrictions will no longer apply.')) onRemove(); }}>Remove rulebook</Button>}<button type="button" className="text-button" aria-expanded={json} onClick={() => setJson(!json)}>{json ? 'Hide JSON' : 'View JSON'}</button></div>
    {json && <><Errors errors={built.errors}/><pre className={s.json}>{JSON.stringify(built.policy,null,2)}</pre></>}
  </form>;
}

function TryIt({ principalKey, onError }) {
  const [form,setForm] = useState({ model:'qwen/qwen3-32b',lane:'public',cost:'0.01',tokens:'512',tools:'' });
  const [agentKey,setAgentKey] = useState('');
  const [errors,setErrors] = useState([]);
  const [result,setResult] = useState(null);
  const [busy,setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const set = (name,value) => { setForm(f => ({ ...f,[name]:value })); setResult(null); };
  return <section className="control-panel"><h2>Try it</h2><p className="help-text">Checks the calling key’s rulebook against a sample intent. It sends no prompt, runs no inference and records no event. Selecting an agent above does not change the calling key. Paste that agent’s key below to check its rulebook.</p>
    <form onSubmit={async e => { e.preventDefault(); const {intent,errors:issues} = sampleIntent(form); if (agentKey && !validKey(agentKey)) issues.push('Enter a valid agent API key.'); setErrors(issues); setResult(null); if (issues.length) return; setBusy(true); try { const r = await api('/api/v1/agents/check',{ key:agentKey.trim() || principalKey,method:'POST',body:intent }); if (alive.current) setResult(r.data); } catch(error) { if (alive.current) onError(error); } finally { if (alive.current) setBusy(false); } }}>
      <fieldset className={s.fieldset} disabled={busy}><legend>Intent</legend><Field label="Agent key (optional; otherwise uses your connected key)" id="check-key"><input id="check-key" type="password" autoComplete="off" spellCheck={false} value={agentKey} onChange={e => { setAgentKey(e.target.value); setResult(null); }}/></Field><p className="help-text">This optional key stays in memory on this page only.</p>
        <Field label="Model identifier" id="intent-model"><input id="intent-model" required maxLength={160} value={form.model} onChange={e => set('model',e.target.value)}/></Field><div className="two-fields"><Field label="Lane" id="intent-lane"><select id="intent-lane" value={form.lane} onChange={e => set('lane',e.target.value)}>{LANES.map(l => <option key={l}>{l}</option>)}</select></Field><Field label="Estimated cost (USD)" id="intent-cost"><input id="intent-cost" required type="number" min="0" max={LIMITS.usd} step="any" value={form.cost} onChange={e => set('cost',e.target.value)}/></Field></div><Field label="Maximum output tokens" id="intent-tokens"><input id="intent-tokens" type="number" min="1" max={LIMITS.tokens} step="1" value={form.tokens} onChange={e => set('tokens',e.target.value)}/></Field><Field label="Tools (one per line or comma)" id="intent-tools"><textarea id="intent-tools" value={form.tools} onChange={e => set('tools',e.target.value)} rows={2}/></Field></fieldset><Errors errors={errors}/><Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Preview decision'}</Button>
    </form>{result && <div className={s.result} role="status"><strong>{decisionText(result.decision)}</strong><ul>{(result.reasons || []).map((r,i) => <li key={i}>{reasonText(r)}</li>)}</ul></div>}
  </section>;
}

function AgentDetail({ agent, request, refreshList, refreshVersion, onError }) {
  const [record,setRecord] = useState(null);
  const [events,setEvents] = useState([]);
  const [next,setNext] = useState(null);
  const [busy,setBusy] = useState(true);
  const [eventBusy,setEventBusy] = useState(false);
  const [reason,setReason] = useState('');
  const [revision,setRevision] = useState(0);
  const [notice,setNotice] = useState('');
  const [readError,setReadError] = useState('');
  const alive = useRef(true);
  const path = '/api/v1/agents/'+encodeURIComponent(agent.key_hash);
  useEffect(() => {
    alive.current = true;
    const ac = new AbortController(); setBusy(true); setRecord(null); setReadError(''); setEvents([]); setNext(null);
    Promise.all([request(path+'/policy',{ signal:ac.signal }),request(path+'/events',{ signal:ac.signal })]).then(([p,e]) => {
      if (ac.signal.aborted) return; setRecord(p.data || { policy:null }); const page = eventsPage(e); setEvents(page.events); setNext(page.next);
    }).catch(error => { if (!ac.signal.aborted) { setReadError(errorState(error).message); onError(error); } }).finally(() => { if (!ac.signal.aborted) setBusy(false); });
    return () => { alive.current = false; ac.abort(); };
  }, [path,request,revision,refreshVersion,onError]);
  const mutate = async action => {
    setBusy(true); setNotice('');
    try { const changed = await action(); if (!alive.current) return; if (changed !== false) { setNotice('Updated.'); refreshList(); setRevision(r => r+1); } }
    catch(error) { if (alive.current) onError(error); }
    finally { if (alive.current) setBusy(false); }
  };
  const killed = record?.killed ?? agent.killed;
  const policy = record?.policy ?? record?.spec ?? (record?.version === 1 && record?.models ? record : null);
  return <>
    <section className="control-panel"><div className={s.heading}><h2>{agent.name || 'Unnamed agent'}</h2><span className={'badge'+(killed ? ' dark' : '')}>{killed ? 'Killed' : 'Running'}</span></div>
      <TrippedBadge record={record} agent={agent}/>
      <span className={s.hash}>Key {agent.key_hash}</span><Spend agent={agent}/><p className={s.hash}>Policy SHA {record?.sha256 || agent.policy_sha256 || 'None'}</p>
      {notice && <p role="status">{notice}</p>}{busy && <p role="status">Reading or updating rulebook…</p>}{readError && <><p role="alert">{readError}</p><Button secondary disabled={busy} onClick={() => setRevision(r => r+1)}>Read rulebook again</Button></>}
      {record && <RulebookForm key={revision} policy={policy} hasPolicy={!!policy} busy={busy} onSave={body => mutate(() => request(path+'/policy',{ method:'PUT',body }))} onRemove={() => mutate(() => request(path+'/policy',{ method:'DELETE' }))}/>}
    </section>
    <section className="control-panel"><h2>Kill switch</h2><p className="help-text">Stops subsequent requests through AnyRoute. A request already in flight may finish.</p>
      {killed && <p>Killed: {utcTime(record?.killed_at || agent.killed_at)}<br/>Reason: {record?.killed_reason || agent.killed_reason || 'Not recorded'}</p>}
      {!killed && <Field id="kill-reason" label="Kill reason (optional)"><input id="kill-reason" value={reason} onChange={e => setReason(e.target.value)} disabled={busy}/></Field>}
      {killed ? <Button disabled={busy} onClick={() => mutate(() => request(path+'/resume',{ method:'POST' }))}>Resume</Button> : <Button className={s.kill} disabled={busy} onClick={() => mutate(() => confirmKill(agent,reason,message => window.confirm(message),request))}>Kill agent</Button>}
    </section>
    <section className="control-panel"><h2>Event log</h2><p className="help-text">Newest first, 50 per page. These intents contain model, lane, estimated cost and tools; no prompt or response text is shown.</p>
      {!events.length && <p>{busy ? 'Reading events…' : readError ? 'Events could not be read.' : 'No events recorded.'}</p>}
      <ol className={s.events}>{events.map(event => <li className={s.event} key={event.id}><div className={s.heading}><strong>{decisionText(event.decision || event.kind)}</strong><time dateTime={event.ts}>{utcTime(event.ts)}</time></div><p>{intentSummary(event.intent)}</p>{event.reasons?.length > 0 && <ul>{event.reasons.map((r,i) => <li key={i}>{reasonText(r)}</li>)}</ul>}</li>)}</ol>
      {next != null && <Button secondary disabled={eventBusy || busy} onClick={async () => { setEventBusy(true); try { const page = eventsPage(await request(path+'/events?cursor='+encodeURIComponent(next))); if (alive.current) { setEvents(old => { const ids = new Set(old.map(e => String(e.id))); return [...old,...page.events.filter(e => !ids.has(String(e.id)))]; }); setNext(page.next); } } catch(error) { if (alive.current) onError(error); } finally { if (alive.current) setEventBusy(false); } }}>{eventBusy ? 'Reading…' : 'Load older events'}</Button>}
    </section>
  </>;
}

export default function Agents() {
  const [key,setKey] = useState('');
  const [draft,setDraft] = useState('');
  const [agents,setAgents] = useState([]);
  const [selected,setSelected] = useState('');
  const [busy,setBusy] = useState(false);
  const [off,setOff] = useState(false);
  const [error,setError] = useState('');
  const [loaded,setLoaded] = useState(false);
  const [revision,setRevision] = useState(0);
  const onError = useCallback(error => { const state = errorState(error); setOff(state.off); setError(state.off ? '' : state.message); }, []);
  const request = useCallback((path,options = {}) => api(path,{ ...options,key }), [key]);
  useEffect(() => { const stored = loadKey(); if (stored) { setKey(stored); setDraft(stored); } }, []);
  useEffect(() => {
    if (!key) return;
    const ac = new AbortController(); setBusy(true); setError(''); setOff(false); setLoaded(false);
    api('/api/v1/agents',{ key,signal:ac.signal }).then(r => { if (ac.signal.aborted) return; const rows = r.data; if (!Array.isArray(rows)) throw new Error('The agent list response could not be read.'); setAgents(rows); setLoaded(true); setSelected(old => rows.some(a => a.key_hash === old) ? old : rows[0]?.key_hash || ''); }).catch(error => { if (!ac.signal.aborted) onError(error); }).finally(() => { if (!ac.signal.aborted) setBusy(false); });
    return () => ac.abort();
  }, [key,revision,onError]);
  const agent = agents.find(a => a.key_hash === selected);
  return <div className={s.body}>
    <section className="control-panel"><h2>Your API key</h2><p className="help-text">Use a management key or an owner/admin key for this account. The dashboard’s session-storage key is reused. It stays in this browser tab until you disconnect or close it.</p>
      <form onSubmit={e => { e.preventDefault(); const value = draft.trim(); if (!validKey(value)) { setError('Enter a valid AnyRoute API key.'); return; } saveKey(value); setKey(value); setAgents([]); setSelected(''); setOff(false); setRevision(r => r+1); }}><Field id="principal-key" label="Principal API key"><input id="principal-key" type="password" autoComplete="off" spellCheck={false} required value={draft} onChange={e => setDraft(e.target.value)}/></Field><div className="button-row"><Button type="submit" disabled={busy}>Connect key</Button>{key && <Button type="button" secondary onClick={() => { clearKey(); setKey(''); setDraft(''); setAgents([]); setSelected(''); setLoaded(false); setOff(false); setError(''); }}>Disconnect</Button>}</div></form>
    </section>
    {error && <p className="note" role="alert">{error}</p>}
    {off ? <section className="empty" role="status"><h2>{FEATURE_OFF}</h2><p>This router is not serving agent rulebooks.</p></section> : <>
      {key && <section aria-label="Agent keys"><div className={s.heading}><h2>Agent keys</h2><button className="text-button" disabled={busy} onClick={() => setRevision(r => r+1)}>Refresh</button></div>{busy && <p role="status">Reading agent keys…</p>}{loaded && !agents.length && <div className="empty"><p>No agent keys returned for this account.</p><a className="inline-link" href="/dashboard/#api-keys">Manage API keys</a></div>}<div className={s.list}>{agents.map(a => <button key={a.key_hash} className={s.agent} aria-pressed={selected === a.key_hash} onClick={() => { setSelected(a.key_hash); setError(''); }}><div className={s.heading}><strong>{a.name || 'Unnamed agent'}</strong><span className={s.badges}><span className="badge">Rulebook {a.has_policy ? 'on' : 'off'}</span>{a.killed && <span className="badge dark">Killed</span>}</span></div><SealedBadge sealed={a.sealed}/><span className={s.hash}>Policy SHA {a.policy_sha256 ? a.policy_sha256.slice(0,12) : 'None'}</span><Spend agent={a}/></button>)}</div></section>}
      {key && <section aria-label="Agent keys"><div className={s.heading}><h2>Agent keys</h2><button className="text-button" disabled={busy} onClick={() => setRevision(r => r+1)}>Refresh</button></div>{busy && <p role="status">Reading agent keys…</p>}{loaded && !agents.length && <div className="empty"><p>No agent keys returned for this account.</p><a className="inline-link" href="/dashboard/#api-keys">Manage API keys</a></div>}<div className={s.list}>{agents.map(a => <button key={a.key_hash} className={s.agent} aria-pressed={selected === a.key_hash} onClick={() => { setSelected(a.key_hash); setError(''); }}><div className={s.heading}><strong>{a.name || 'Unnamed agent'}</strong><span className={s.badges}><span className="badge">Rulebook {a.has_policy ? 'on' : 'off'}</span>{a.killed && <span className="badge dark">Killed</span>}</span></div><span className={s.hash}>Policy SHA {a.policy_sha256 ? a.policy_sha256.slice(0,12) : 'None'}</span><Spend agent={a}/></button>)}</div></section>}
      {key && <TelegramLink key={key} principalKey={key}/>}
      {key && <Approvals key={key} request={request} agents={agents} onError={onError}/>}
      {key && agent && <Autonomy agent={agent}/> }
      {key && agent && <AgentWorkspace key={key+agent.key_hash} agent={agent} request={request} refreshVersion={revision}><AgentDetail agent={agent} request={request} onError={onError} refreshVersion={revision} refreshList={() => setRevision(r => r+1)}/></AgentWorkspace>}
      {key && agent && <Alerts key={key+agent.key_hash} keyHash={agent.key_hash} request={request} refreshVersion={revision} onError={onError}/>}
      {key && <TryIt key={key} principalKey={key} onError={onError}/>}
      {!key && <p className="note">Connect your key to read and manage agent rulebooks.</p>}
    </>}
    <p className="help-text">For ordinary requests on every lane today, AnyRoute’s router reads request text in memory to route it, and the provider that answers reads it too. Rulebooks constrain requests through AnyRoute; they do not control calls sent elsewhere.</p>
  </div>;
}
