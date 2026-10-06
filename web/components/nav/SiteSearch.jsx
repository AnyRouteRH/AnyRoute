'use client';
import StopMenu from '../limits/StopMenu'; // B117
import { stoppedLabel, stopHelp } from '../../lib/stop-until'; // B117
import { useEffect, useMemo, useRef, useState } from 'react';
import { isSearchShortcut } from '../../lib/site-search';
import { GROUPS } from '../../lib/site-map';
// U106: actions beside links. Each opens its screen ready, or acts only after the same confirm step its page uses.
import { actionHref, agentChoices, agentQuestion, filterChoices, firstStep, loadAgents, modelChoices, needsSignIn, receiptIdFromQuery, runAgentCommand, searchAll, startHref } from '../../lib/site-actions';
import { FEATURE_OFF, errorState } from '../../lib/agents';
import { LIMIT_WORDS as W } from '../../lib/spending-limits';
import { api, toCatalogModel } from '../../lib/api';
import { useAccountKey } from '../account/useAccountKey';

const editable = target => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
const stepLabel = action => action.pick === 'receipt' ? 'Receipt id' : action.run === 'stop' ? 'Choose an agent to stop' : action.run === 'resume' ? 'Choose an agent to resume'
  : action.pick === 'model' ? 'Choose a model for Chat' : 'Choose a key or agent';
const HELP = { list: '↑ ↓ to choose · Enter to open · Esc to close', pick: '↑ ↓ to choose · Enter to select · Esc to go back', input: 'Enter to open · Esc to go back',
  confirm: 'Enter to confirm · Esc to go back', busy: 'Working…', done: 'Esc to close' };
const ARM_MS = 350; // a double click on a list row never lands on the confirm button that replaces it

export default function SiteSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(null); // { action, phase: pick | input | confirm | busy | done, choice, error }
  const [filter, setFilter] = useState('');
  const [items, setItems] = useState({ state: 'idle', choices: [] });
  const [message, setMessage] = useState('');
  const [key] = useAccountKey();
  const signedIn = !!key;
  const dialog = useRef(null);
  const input = useRef(null);
  const confirmButton = useRef(null);
  const doneButton = useRef(null);
  const loading = useRef(null);
  const models = useRef(null);
  const armed = useRef(0);
  const results = useMemo(() => searchAll(query), [query]);
  const choices = useMemo(() => step?.phase === 'pick' ? filterChoices(filter, items.choices) : [], [step?.phase, filter, items]);
  const phase = step?.phase || 'list';
  const list = phase === 'list' ? results : choices;
  useEffect(() => {
    const show = () => { setQuery(''); setSelected(0); setStep(null); setFilter(''); setMessage(''); setOpen(true); };
    const shortcut = event => {
      if (isSearchShortcut(event, { pathname: location.pathname, editable: editable(event.target), dialogOpen: !!document.querySelector('dialog[open]') })) { event.preventDefault(); show(); }
    };
    window.addEventListener('anyroute:site-search', show);
    document.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('anyroute:site-search', show); document.removeEventListener('keydown', shortcut); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const node = dialog.current;
    node.showModal(); input.current?.focus();
    return () => { loading.current?.abort(); node.close(); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (phase === 'confirm') { armed.current = performance.now(); (confirmButton.current?.querySelector('button') ?? confirmButton.current)?.focus(); }
    else if (phase === 'done') doneButton.current?.focus();
    else if (phase !== 'busy') input.current?.focus();
  }, [open, phase]);
  useEffect(() => {
    if (open) dialog.current?.querySelector(`[data-result="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, query, filter, phase]);
  const close = () => setOpen(false);
  const go = href => { if (!href) return; close(); window.location.assign(href); };
  const request = (path, options = {}) => api(path, { ...options, key });
  const rowHref = row => row.kind !== 'action' ? row.href : needsSignIn(row, signedIn) ? startHref(row) : row.prefill ? actionHref(row, row.prefill) : firstStep(row) ? null : startHref(row);

  // Only a signed-in key reads its agents; the model catalogue is public and read once per page.
  const load = action => {
    loading.current?.abort();
    const ac = new AbortController(); loading.current = ac;
    const done = next => { if (!ac.signal.aborted) setItems(next); };
    setItems({ state: 'loading', choices: [] });
    if (action.pick === 'agent') loadAgents(request, signedIn, ac.signal).then(r => done(r.state === 'ok' ? { state: 'ok', choices: agentChoices(r.rows, action) } : { state: r.state, choices: [], error: r.error })).catch(() => {});
    else (models.current ? Promise.resolve(models.current) : api('/api/v1/models', { signal: ac.signal }).then(r => (models.current = modelChoices((r?.data || []).map(toCatalogModel)))))
      .then(rows => done({ state: 'ok', choices: rows })).catch(error => { if (error?.name !== 'AbortError') done({ state: 'error', choices: [], error: 'The model catalogue could not be loaded. Try again.' }); });
  };
  const chooseResult = row => {
    if (!row) return;
    const href = rowHref(row);
    if (href) return go(href);
    const next = firstStep(row);
    setStep({ action: row, phase: next }); setFilter(next === 'input' ? receiptIdFromQuery(query) : ''); setSelected(0); setMessage('');
    if (next === 'pick') load(row);
  };
  const chooseChoice = choice => {
    if (!choice) return;
    if (choice.disabled) return setMessage(`${choice.title}: ${choice.note}`);
    if (step.action.run) { setStep({ ...step, phase: 'confirm', choice, error: '' }); setMessage(''); return; }
    go(actionHref(step.action, choice.id));
  };
  const submitReceipt = () => {
    const href = actionHref(step.action, filter.trim());
    if (href) go(href); else setMessage('That is not a valid receipt id. Ids use letters, digits and . _ : -');
  };
  const back = () => {
    if (!step || phase === 'busy') return;
    setMessage('');
    if (phase === 'confirm') return setStep({ ...step, phase: 'pick', choice: null, error: '' });
    loading.current?.abort(); setStep(null); setSelected(0);
  };
  // The confirm step: the agentQuestion() words are on screen and this is the person's answer. Nothing runs before it.
  const confirm = async (until) => { // B117
    if (phase !== 'confirm' || performance.now() - armed.current < ARM_MS) return;
    const { action, choice } = step;
    setStep({ ...step, phase: 'busy', error: '' }); setMessage(action.run === 'stop' ? `Stopping ${choice.title}…` : `Resuming ${choice.title}…`);
    try {
      const changed = await runAgentCommand(action.run, choice.agent, request, { confirmed: true, signedIn, until: typeof until === 'string' ? until : undefined });
      if (!changed) { setStep({ ...step, phase: 'confirm', error: '' }); setMessage(''); return; }
      setStep({ ...step, phase: 'done' });
      window.dispatchEvent(new Event('anyroute:agents-changed')); // an open /agents page reads its list again
      setMessage(action.run === 'stop' ? `Stopped ${choice.title}. ${stoppedLabel(typeof until === 'string' ? until : null)}.` : `Resumed ${choice.title}. New requests through Anyroute are allowed again, within its spending limits.`);
    } catch (error) { setStep({ ...step, phase: 'confirm', error: errorState(error).message }); setMessage(''); }
  };
  const keys = event => {
    if (event.key === 'Escape' && step) { event.preventDefault(); if (phase === 'done') close(); else back(); return; }
    if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return; } // a held Enter never confirms
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && list.length && (phase === 'list' || phase === 'pick')) {
      event.preventDefault();
      setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
      input.current?.focus();
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault();
      if (phase === 'list') chooseResult(results[selected]);
      else if (phase === 'pick') chooseChoice(choices[selected]);
      else if (phase === 'input') submitReceipt();
    }
  };
  const listed = phase === 'list' || phase === 'pick';
  const option = (index, id) => ({ id, 'data-result': index, role: 'option', 'aria-selected': selected === index, onFocus: () => setSelected(index), onMouseMove: () => setSelected(index) });
  const status = message || (phase === 'list' ? (query.trim() ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : 'Start here')
    : phase === 'pick' ? (items.state === 'loading' ? (step.action.pick === 'agent' ? 'Reading your agents…' : 'Reading the model catalogue…') : items.state === 'ok' ? `${choices.length < items.choices.length ? `Showing ${choices.length} of ${items.choices.length}` : choices.length} ${step.action.pick === 'agent' ? (items.choices.length === 1 ? 'agent' : 'agents') : (items.choices.length === 1 ? 'model' : 'models')}` : '')
    : phase === 'input' ? 'Opens Verify with this receipt' : '');
  const activeId = phase === 'list' && results[selected] ? `search-${results[selected].kind === 'action' ? 'do-' : ''}${results[selected].id}` : phase === 'pick' && choices[selected] ? `search-pick-${selected}` : undefined;
  return <dialog ref={dialog} id="site-search" className="modal site-search" data-phase={phase} aria-labelledby="site-search-title" onCancel={event => { event.preventDefault(); if (step && phase !== 'done') back(); else close(); }} onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={keys}>
    <div className="modal-head">{step && phase !== 'done' && <button type="button" className="text-button search-back" onClick={back} disabled={phase === 'busy'}>Back</button>}<h2 id="site-search-title">{step ? step.action.title : 'Find anything'}</h2><button type="button" className="icon-button" aria-label="Close search" onClick={close}>×</button></div>
    {(phase === 'list' || phase === 'pick' || phase === 'input') && <>
      <label className="eyebrow" htmlFor="site-search-query">{step ? stepLabel(step.action) : 'Search tools, guides and actions'}</label>
      <input ref={input} id="site-search-query" type={phase === 'input' ? 'text' : 'search'} role={listed ? 'combobox' : undefined} aria-autocomplete={listed ? 'list' : undefined} aria-expanded={listed ? open : undefined} aria-controls={listed ? 'site-search-results' : undefined} aria-activedescendant={open && listed ? activeId : undefined}
        value={step ? filter : query} placeholder={phase === 'input' ? 'gen-…' : undefined} maxLength={phase === 'input' ? 128 : undefined}
        onChange={event => { if (step) setFilter(event.target.value); else setQuery(event.target.value); setSelected(0); setMessage(''); }} autoComplete="off" spellCheck="false" />
    </>}
    <p className="search-status" role="status">{status}</p>
    {phase === 'list' && <div className="search-results" id="site-search-results" role="listbox" aria-label="Matching tasks and actions">{open && results.map((row, index) => {
      const action = row.kind === 'action';
      const href = rowHref(row);
      const props = option(index, `search-${action ? 'do-' : ''}${row.id}`);
      const body = <><small>{action ? 'Action' : GROUPS.find(group => group.id === row.group).title}{action && needsSignIn(row, signedIn) && <em className="search-lock">Sign in first</em>}</small><strong>{row.prefill ? `Open receipt ${row.prefill}` : row.title}</strong><span>{row.description}</span></>;
      return href ? <a key={(action ? 'do-' : '') + row.id} {...props} href={href} onClick={close}>{body}</a> : <button key={'do-' + row.id} {...props} type="button" onClick={() => chooseResult(row)}>{body}</button>;
    })}</div>}
    {phase === 'list' && open && !results.length && <p className="search-empty">No matching tasks. Try another word or <a href="/docs/" onClick={close}>browse the docs</a>.</p>}
    {phase === 'pick' && <div className="search-results" id="site-search-results" role="listbox" aria-label={stepLabel(step.action)}>{choices.map((choice, index) => <button key={choice.id} {...option(index, `search-pick-${index}`)} type="button" aria-disabled={choice.disabled || undefined} onClick={() => chooseChoice(choice)}>
      <small>{step.action.pick === 'agent' ? 'Agent' : 'Model'}</small><strong>{choice.title}</strong><span>{choice.disabled ? choice.note : choice.description}</span>
    </button>)}</div>}
    {phase === 'pick' && items.state === 'ok' && !choices.length && <p className="search-empty">{items.choices.length ? 'Nothing matches. Try another word.' : step.action.pick === 'agent' ? <>No agent keys returned for this account. <a href="/dashboard/#api-keys" onClick={close}>Manage API keys</a></> : 'No models are available right now.'}</p>}
    {phase === 'pick' && (items.state === 'off' || items.state === 'error') && <p className="search-empty" role="alert">{items.error} {items.error === FEATURE_OFF && step.action.focus === 'limits' ? <a href="/dashboard/#api-keys" onClick={close}>Set a key’s budget in API keys</a> : <a href={startHref(step.action)} onClick={close}>Open {step.action.pick === 'model' ? 'Chat' : 'Agents'}</a>}</p>}
    {(phase === 'confirm' || phase === 'busy') && <div className="search-confirm" role="group" aria-labelledby="site-search-question">
      <p id="site-search-question">{agentQuestion(step.action.run, step.choice.agent)}</p>
      {step.action.run === 'stop' && <p className="help-text">{stopHelp}</p>}
      {step.error && <p className="error" role="alert">{step.error}</p>}
      <div className="button-row">
        {step.action.run === 'stop' ? <span ref={confirmButton}><StopMenu disabled={phase === 'busy'} onStop={confirm}/></span> : <button ref={confirmButton} type="button" className="ar-button" disabled={phase === 'busy'} onClick={confirm}><i aria-hidden="true"/><span>{step.action.run === 'stop' ? W.stop : W.resume}</span><b aria-hidden="true">→</b></button>} {/* B117 */}
        <button type="button" className="ar-button secondary" disabled={phase === 'busy'} onClick={back}><span>Back</span><b aria-hidden="true">→</b></button>
      </div>
    </div>}
    {phase === 'done' && <div className="search-confirm"><div className="button-row">
      <a className="ar-button" href={actionHref({ ...step.action, focus: null }, step.choice.id)} onClick={close}><i aria-hidden="true"/><span>Open Agents</span><b aria-hidden="true">→</b></a>
      <button ref={doneButton} type="button" className="ar-button secondary" onClick={close}><span>Close</span><b aria-hidden="true">→</b></button>
    </div></div>}
    <p className="search-help">{HELP[phase]}</p>
  </dialog>;
}
