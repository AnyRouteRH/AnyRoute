'use client';
import AccountShell from '../../components/account/AccountShell';
import { useMemo } from 'react'; // C132
import { withSpendGlance, useSpendGlance } from '../../components/AgentSpendGlance'; // C132
import { useAccountKey } from '../../components/account/useAccountKey';
import { SealedBadge } from './SealedAgent';
import TelegramLink from "./TelegramLink";
import Autonomy from "./Autonomy";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/UI';
import { api } from '../../lib/api';
import { DAYS, LIMITS, FEATURE_OFF, capBars, reasonText, decisionText, intentSummary, eventsPage, confirmKill, errorState, utcTime } from '../../lib/agents';
import { stoppedLabel } from '../../lib/stop-until'; // B117
import { LIMIT_WORDS as W, limitsFromRulebook, rulebookFromLimits } from '../../lib/spending-limits';
import RulebookCard from '../../components/limits/RulebookSentences'; // B124
import SpendingLimits, { LimitGroup, useAgentGuard } from '../../components/limits/SpendingLimits';
import ReplayResult, { ReplayButton, useRuleReplay } from '../../components/limits/ReplayRules'; // Replay your rules
import s from './agents.module.css';
import Approvals from './Approvals';
import { BreakersForm, TrippedBadge } from './Breakers';
import AgentWorkspace from './AgentWorkspace';
import QuietAgentAlert from '../../components/QuietAgentAlert'; // D141
import Alerts from './Alerts';
import AlertFields from './AlertFields';
import StarterSetups from '../../components/limits/StarterSetups'; // U103: one entry point for starting values, in place of the V85 and V98 starter lists.
import RequestCheck from './RequestCheck'; // V85: check the selected agent’s rules.
import PayAgent from './PayAgent'; // Pay another agent: the rulebook decides, your own wallet sends, Anyroute checks and signs.
import { agentLink, focusSelector } from '../../lib/site-actions'; // U106: ⌘K links here to an agent's spending limits or default route.
import FollowPlaybook from '../../components/limits/FollowPlaybook'; // U115: follow a playbook, or stop following one.

function Field({ label, id, children }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}</div>;
}
function Errors({ errors }) {
  return errors.length > 0 && <ul className={s.errors} role="alert">{errors.map(e => <li key={e}>{e}</li>)}</ul>;
}
function Spend({ agent }) {
  return <div className={s.bars}>{capBars(agent).map(bar => <div key={bar.period}><span className={s.barLabel}><span>Rolling {bar.period}</span><span>{bar.label}</span></span><progress max="100" value={bar.percent} aria-label={`Rolling ${bar.period}: ${bar.label}`}/></div>)}</div>;
}

const SpendCaps = Spend; // C132: keep the existing caps renderer inside the spend glance.

// U102: the shared spending limits editor, plus the rulebook's other rules and, where it applies, Agent Guard's actions.
// U115: `locked` while the key follows a playbook: its rules are shown read-only; Stop and Resume still work.
function RulebookForm({ policy, onSave, onRemove, busy: working, locked = false, hasPolicy, guard, stop, request, keyHash }) {
  const busy = working || locked;
  const [form, setForm] = useState(() => limitsFromRulebook(policy));
  const [errors, setErrors] = useState([]);
  const set = (name, value) => setForm(f => ({ ...f, [name]: value }));
  const windowSet = (index, patch) => setForm(f => ({ ...f, windows: f.windows.map((w, i) => i === index ? { ...w, ...patch } : w) }));
  const built = rulebookFromLimits(form);
  const replay = useRuleReplay(request, keyHash);
  const replaySetup = () => { replay.run(rulebookFromLimits(form)); replay.reveal(); };
  return <form onSubmit={e => { e.preventDefault(); setErrors(built.errors); if (!built.errors.length) onSave(built.policy); }}>
    <SpendingLimits id="rulebook" value={form} onChange={setForm} disabled={working} locked={locked} setups="agents" scope guard={guard || policy?.actions !== undefined} stop={stop} onReplay={replaySetup}>
      <LimitGroup title="More rules" disabled={busy}>
        <div className="two-fields"><Field label="Maximum output tokens" id="max_output_tokens"><input id="max_output_tokens" type="number" min="1" max={LIMITS.tokens} step="1" value={form.caps.max_output_tokens} onChange={e => set('caps',{ ...form.caps,max_output_tokens:e.target.value })}/></Field>
        <Field label="Ask me first after calls per hour" id="approval-calls"><input id="approval-calls" type="number" step="1" min="1" max="1000000" value={form.approvalCalls ?? ''} onChange={e => set('approvalCalls',e.target.value)}/></Field></div>
        <p className="help-text">Optional. Calls per hour counts model calls in a rolling hour and needs an amount in “Ask me first above”.</p>
        <Field label="If a limit is reached" id="breach"><select id="breach" value={form.onBreach} onChange={e => set('onBreach',e.target.value)}><option value="deny">Refuse that request</option><option value="kill">Stop this key until you resume it</option></select></Field><p className="help-text">Stopping on a breach refuses future requests until you resume.</p>
      </LimitGroup>
      <LimitGroup title="Time windows (UTC)" disabled={busy}><label className="check-label"><input type="checkbox" checked={form.restrictWindows} onChange={e => set('restrictWindows',e.target.checked)}/>Only allow requests within these UTC windows</label><p className="help-text">No windows while this restriction is on denies every time. The router evaluates window boundaries.</p>
        {form.restrictWindows && <>{form.windows.map((w,index) => <div className={s.window} key={index}><div className={s.checks}>{DAYS.map((day,d) => <label className="check-label" key={day}><input type="checkbox" checked={w.days.includes(d)} onChange={e => windowSet(index,{ days:e.target.checked ? [...w.days,d] : w.days.filter(v => v !== d) })}/>{day}</label>)}</div><div className="two-fields">{['start','end'].map(time => <Field key={time} id={`window-${index}-${time}`} label={`${time} (UTC)`}><input id={`window-${index}-${time}`} type="time" step="60" required value={w[time]} onChange={e => windowSet(index,{ [time]:e.target.value })}/></Field>)}</div><button type="button" className="text-button" onClick={() => set('windows',form.windows.filter((_,i) => i !== index))}>Remove window {index+1}</button></div>)}<Button type="button" secondary disabled={form.windows.length >= 64} onClick={() => set('windows',[...form.windows,{ days:[1,2,3,4,5],start:'09:00',end:'17:00' }])}>Add UTC window</Button></>}
      </LimitGroup>
      <BreakersForm values={form.breakers} onChange={values => set('breakers', values)} busy={busy}/>
      <AlertFields value={form.alerts} onChange={value => set('alerts',value)} disabled={busy}/>
    </SpendingLimits>
    <Errors errors={errors}/><div className="button-row">{!locked && <Button type="submit" disabled={busy}>{W.save}</Button>}<ReplayButton replay={replay} disabled={working} onRun={() => replay.run(built)}/>{hasPolicy && !locked && <Button type="button" secondary disabled={busy} onClick={() => { if (window.confirm('Remove these spending limits? Their rules will no longer apply.')) onRemove(); }}>{W.remove}</Button>}</div>
    <ReplayResult id="replay-rules" replay={replay} current={built.policy}/>
  </form>;
}

function AgentDetail({ agent, request, refreshList, refreshVersion, onError, guard }) {
  const [record,setRecord] = useState(null);
  const [events,setEvents] = useState([]);
  const [next,setNext] = useState(null);
  const [busy,setBusy] = useState(true);
  const [eventBusy,setEventBusy] = useState(false);
  const [revision,setRevision] = useState(0);
  const [notice,setNotice] = useState('');
  const [readError,setReadError] = useState('');
  const alive = useRef(true);
  const path = '/api/v1/agents/'+encodeURIComponent(agent.key_hash);
  useEffect(() => {
    alive.current = true;
    const ac = new AbortController(); setBusy(true); setRecord(null); setReadError(''); setEvents([]); setNext(null);
    // U102: the agent list already loaded, so a 404 here means this key has no rulebook yet, not that rulebooks are off.
    Promise.all([request(path+'/policy',{ signal:ac.signal }).catch(error => error?.status === 404 ? { data:{ policy:null } } : Promise.reject(error)),request(path+'/events',{ signal:ac.signal })]).then(([p,e]) => {
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
  const stop = { stopped: !!record?.killed, until: record?.stopped_until, ready: !!policy, busy, reason: true, // B117
    detail: record?.killed ? `Since ${utcTime(record.killed_at)}. Reason: ${record.killed_reason || 'Not recorded'}.` : null,
    onStop: (reason, until) => mutate(() => confirmKill(agent,reason,message => window.confirm(message),request,until)), // B117
    onResume: () => mutate(() => request(path+'/resume',{ method:'POST' })) };
  return <>
    <section className="control-panel"><div className={s.heading}><h2>{agent.name || 'Unnamed agent'}</h2><span className={'badge'+(killed ? ' dark' : '')}>{killed ? stoppedLabel(record?.stopped_until ?? agent.stopped_until) : 'Running'}</span></div>
      <TrippedBadge record={record} agent={agent}/>
      <span className={s.hash}>Key {agent.key_hash}</span><Spend agent={agent}/><p className={s.hash}>Policy SHA {record?.sha256 || agent.policy_sha256 || 'None'}</p>
      {notice && <p role="status">{notice}</p>}{busy && <p role="status">Reading or updating rulebook…</p>}{readError && <><p role="alert">{readError}</p><Button secondary disabled={busy} onClick={() => setRevision(r => r+1)}>Read rulebook again</Button></>}
      <FollowPlaybook id="rulebook" keyHash={agent.key_hash} playbook={agent.playbook ?? null} request={request} disabled={busy} onChanged={() => { setNotice('Updated.'); refreshList(); setRevision(r => r+1); }}/>
      {record && <><h3>{W.title}</h3><RulebookCard policy={policy} inherited={(agent.policies ?? []).filter(p => p.inherited)} stop={stop} busy={busy}><RulebookForm key={revision} policy={policy} hasPolicy={!!policy} busy={busy} locked={!!agent.playbook} guard={guard} request={request} keyHash={agent.key_hash} onSave={body => mutate(() => request(path+'/policy',{ method:'PUT',body }))} onRemove={() => mutate(() => request(path+'/policy',{ method:'DELETE' }))}/></RulebookCard></>} {/* B124 */}
      <p className="help-text">{W.scopeOnly}</p>
    </section>
    <section className="control-panel"><h2>Event log</h2><p className="help-text">Newest first, 50 per page. These intents contain model, lane, estimated cost and tools; no prompt or response text is shown.</p>
      {!events.length && <p>{busy ? 'Reading events…' : readError ? 'Events could not be read.' : 'No events recorded.'}</p>}
      <ol className={s.events}>{events.map(event => <li className={s.event} key={event.id}><div className={s.heading}><strong>{decisionText(event.decision || event.kind)}</strong><time dateTime={event.ts}>{utcTime(event.ts)}</time></div><p>{intentSummary(event.intent)}</p>{event.reasons?.length > 0 && <ul>{event.reasons.map((r,i) => <li key={i}>{reasonText(r)}</li>)}</ul>}</li>)}</ol>
      {next != null && <Button secondary disabled={eventBusy || busy} onClick={async () => { setEventBusy(true); try { const page = eventsPage(await request(path+'/events?cursor='+encodeURIComponent(next))); if (alive.current) { setEvents(old => { const ids = new Set(old.map(e => String(e.id))); return [...old,...page.events.filter(e => !ids.has(String(e.id)))]; }); setNext(page.next); } } catch(error) { if (alive.current) onError(error); } finally { if (alive.current) setEventBusy(false); } }}>{eventBusy ? 'Reading…' : 'Load older events'}</Button>}
    </section>
  </>;
}

export default function Agents() {
  const [key,setKey] = useAccountKey();
  const [agents,setAgents] = useState([]);
  const [selected,setSelected] = useState('');
  const [busy,setBusy] = useState(false);
  const [off,setOff] = useState(false);
  const [error,setError] = useState('');
  const [loaded,setLoaded] = useState(false);
  const [revision,setRevision] = useState(0);
  const guard = useAgentGuard(); // U102: Agent Guard's actions section shows where Guard is switched on.
  const onError = useCallback(error => { const state = errorState(error); setOff(state.off); setError(state.off ? '' : state.message); }, []);
  const request = useCallback((path,options = {}) => api(path,{ ...options,key }), [key]);
  const glance = useSpendGlance(request, key, revision); // C132
  const Spend = useMemo(() => withSpendGlance(SpendCaps, glance), [glance]); // C132: wrap each existing row without changing its markup.
  useEffect(() => {
    if (!key) return;
    const ac = new AbortController(); setBusy(true); setError(''); setOff(false); setLoaded(false);
    api('/api/v1/agents',{ key,signal:ac.signal }).then(r => { if (ac.signal.aborted) return; const rows = r.data; if (!Array.isArray(rows)) throw new Error('The agent list response could not be read.'); setAgents(rows); setLoaded(true); setSelected(old => rows.some(a => a.key_hash === old) ? old : rows[0]?.key_hash || ''); }).catch(error => { if (!ac.signal.aborted) onError(error); }).finally(() => { if (!ac.signal.aborted) setBusy(false); });
    return () => ac.abort();
  }, [key,revision,onError]);
  const agent = agents.find(a => a.key_hash === selected);
  // U106: /agents/?agent=…&focus=limits|route selects that agent once, then focuses that part of its spending limits.
  const linked = useRef(null);
  useEffect(() => { const reread = () => setRevision(r => r+1); window.addEventListener('anyroute:agents-changed', reread); return () => window.removeEventListener('anyroute:agents-changed', reread); }, []); // ⌘K stopped or resumed one
  useEffect(() => {
    const link = agentLink(location.search); if (!link) return;
    linked.current = link; setSelected(link.agent);
    const url = new URL(location.href); url.searchParams.delete('agent'); url.searchParams.delete('focus'); history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, []);
  useEffect(() => {
    const link = linked.current; if (!link || !loaded) return;
    linked.current = null;
    const selector = agent?.key_hash === link.agent && focusSelector(link.focus, 'rulebook'); if (!selector) return;
    const ready = () => { const el = document.querySelector(selector); return el && !el.matches(':disabled') ? el : null; };
    const go = el => { const editor = el.closest('details'); if (editor) editor.open = true; /* B124 */ el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); };
    const found = ready(); if (found) return void go(found);
    const watch = new MutationObserver(() => { const el = ready(); if (el) { stop(); go(el); } });
    const timer = setTimeout(() => watch.disconnect(), 15000); const stop = () => { watch.disconnect(); clearTimeout(timer); };
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return stop;
  }, [loaded, agent?.key_hash]);
  return <AccountShell publicContent current="Agents" apiKey={key} onConnect={value => { setKey(value); setAgents([]); setSelected(''); setOff(false); setError(''); }} onDisconnect={() => { setKey(''); setAgents([]); setSelected(''); setLoaded(false); setOff(false); setError(''); }}><div className={s.body}>
    {!(key && !off && agent) && <StarterSetups id="setup-preview" view="agents" guard={guard}/>} {/* U103: a preview until an agent is selected; then Start from a setup sits in its Spending limits. */}
    {!(key && !off && agent) && <p id="replay-rules" className="note">Select an agent after connecting to replay its spending limits on the last 7 days before you save them. Nothing is saved.</p>} {/* Replay your rules: beside Save once an agent is selected */}
    <div id="request-check">{key && !off && agent ? <RequestCheck key={key+selected} agent={agent} refreshVersion={revision}/> : <p className="note">Select an agent after connecting to check a request against its rules without spending.</p>}</div> {/* V85 */}
    <PayAgent agent={key && !off ? agent : null}/>
    {error && <p className="note" role="alert">{error}</p>}
    {off ? <section className="empty" role="status"><h2>{FEATURE_OFF}</h2><p>This router is not serving agent rulebooks.</p></section> : <>
      {key && <section aria-label="Agent keys"><div className={s.heading}><h2>Agent keys</h2><button className="text-button" disabled={busy} onClick={() => setRevision(r => r+1)}>Refresh</button></div>{busy && <p role="status">Reading agent keys…</p>}{loaded && !agents.length && <div className="empty"><p>No agent keys returned for this account.</p><a className="inline-link" href="/dashboard/#api-keys">Manage API keys</a></div>}<div className={s.list}>{agents.map(a => <div key={a.key_hash}><button className={s.agent} aria-pressed={selected === a.key_hash} onClick={() => { setSelected(a.key_hash); setError(''); }}><div className={s.heading}><strong>{a.name || 'Unnamed agent'}</strong><span className={s.badges}><span className="badge">Rulebook {a.has_policy ? 'on' : 'off'}</span>{a.playbook && <span className="badge">Playbook {a.playbook.name}</span>}{a.killed && <span className="badge dark">{stoppedLabel(a.stopped_until)}</span>}</span></div><span className={s.hash}>Policy SHA {a.policy_sha256 ? a.policy_sha256.slice(0,12) : 'None'}</span><Spend agent={a}/></button><SealedBadge sealed={a.sealed}/><QuietAgentAlert key={key+a.key_hash} agent={a} request={request}/>{/* D141 */}</div>)}</div></section>}
      {key && <TelegramLink key={key} principalKey={key}/>}
      {key && <section id="approvals"><Approvals key={key} request={request} agents={agents} onError={onError}/></section>}
      {key && agent && <Autonomy agent={agent}/> }
      {key && agent && <AgentWorkspace key={key+agent.key_hash} agent={agent} request={request} refreshVersion={revision}><AgentDetail agent={agent} request={request} onError={onError} guard={guard} refreshVersion={revision} refreshList={() => setRevision(r => r+1)}/></AgentWorkspace>}
      {key && agent && <Alerts key={"alerts"+key+agent.key_hash} /* U102: a key distinct from AgentWorkspace’s, so switching agents leaves no stale panel. */ keyHash={agent.key_hash} request={request} refreshVersion={revision} onError={onError}/>}
      {!key && <p className="note">Connect your key to read and manage agent rulebooks.</p>}
    </>}
    <p className="help-text">For ordinary requests on every lane today, Anyroute’s router reads request text in memory to route it, and the provider that answers reads it too. Rulebooks constrain requests through Anyroute; they do not control calls sent elsewhere.</p>
  </div></AccountShell>;
}
