'use client';
// U103: Start from a setup, the one entry point for starting values wherever the spending limits editor appears. One click
// fills the editor with a setup's values and lists what it set; the editor's own Save writes the rulebook, and Undo puts
// back the values from before. This component never calls the API. Without onChange it is a read-only preview (/agents
// before an agent is selected), which keeps the page's #starter-setups and #rulebook-templates anchors in place.
import { useState } from 'react';
import { openLine, setupsFor, setupSummary, withSetup } from '../../lib/starter-setups';
import st from './SpendingLimits.module.css';

export const SETUP_WORDS = {
  title: 'Start from a setup',
  help: 'One click fills the fields below with a setup’s values. Nothing is saved until you save.',
  preview: 'See what each setup sets. Connect a management or owner/admin key and select an agent: a setup then fills that agent’s spending limits for you to review and save.',
  more: 'More starting points', choose: 'Choose a single starter', kept: 'Anything not listed stays as it is.', undo: 'Undo',
  proven: 'Proven hardware means endpoints with a fresh hardware attestation the router verified. It describes where a request is answered; the router still reads ordinary request text in memory.',
};
const W = SETUP_WORDS;

export default function StarterSetups({ id = 'setups', view, value, onChange, guard = false, disabled = false }) {
  const preview = !onChange;
  const { setups, more } = setupsFor(view, { guard });
  const [picked, setPicked] = useState(preview ? setups[0]?.id ?? null : null);
  const [before, setBefore] = useState(null);
  const setup = [...setups, ...more].find(s => s.id === picked);
  const summary = setup ? setupSummary(setup, { view, guard }) : null;
  const pick = next => {
    setPicked(next.id);
    if (preview) return;
    const base = before ?? value; // Another pick starts again from the values before the first one.
    setBefore(base);
    onChange(withSetup(base, next, { view, guard }));
  };
  const undo = () => { onChange(before); setBefore(null); setPicked(null); };
  const anchors = view === 'agents' && <><span id="rulebook-templates"/>{guard && <span id="agent-guard"/>}</>;
  const body = <>
    <p className="help-text">{preview ? W.preview : W.help}</p>
    <div className={st.setups} role="group" aria-label="Setups">
      {setups.map(s => <button key={s.id} type="button" className={st.setup} aria-pressed={picked === s.id} onClick={() => pick(s)}><strong>{s.name}</strong><span>{s.blurb}</span></button>)}
    </div>
    {more.length > 0 && <div className="field"><label htmlFor={`${id}-more-starters`}>{W.more}</label>
      <select id={`${id}-more-starters`} value={more.some(s => s.id === picked) ? picked : ''} onChange={e => { const next = more.find(s => s.id === e.target.value); if (next) pick(next); }}>
        <option value="">{W.choose}</option>
        <optgroup label="Rulebook starters">{more.filter(s => !s.guardOnly).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
        {more.some(s => s.guardOnly) && <optgroup label="Action rulebooks (Agent Guard)">{more.filter(s => s.guardOnly).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
      </select>
    </div>}
    {summary && <div className={st.summary} role="status">
      <p><strong>{setup.name}</strong> {preview ? 'sets:' : 'filled in:'}</p>
      {more.includes(setup) && <p>{setup.blurb}</p>}
      <ul>{summary.lines.map(l => <li key={l.part}>{l.text}</li>)}{summary.open.length > 0 && <li>{openLine(summary.open)}</li>}</ul>
      {summary.note && <p className="help-text">{summary.note}</p>}
      {summary.elsewhere.length > 0 && <p className="help-text">On <a href="/agents/">Agents</a>, this setup also sets: {summary.elsewhere.map(l => l.text).join('; ')}.</p>}
      {summary.proven && <p className="help-text">{W.proven} <a href="/status/#proof-time">See proof-time by provider</a>.</p>}
      <p className="help-text">{W.kept}{preview ? '' : ' Review the fields below, then save.'}</p>
      {before && <button type="button" className="text-button" onClick={undo}>{W.undo}</button>}
    </div>}
  </>;
  return preview
    ? <section id="starter-setups" className="control-panel">{anchors}<h2>{W.title}</h2>{body}</section>
    : <fieldset id={view === 'agents' ? 'starter-setups' : undefined} disabled={disabled} className={st.group}><legend>{W.title}</legend>{anchors}{body}</fieldset>;
}
