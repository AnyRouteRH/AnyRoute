'use client';
// Replay your rules: "Replay last 7 days" sits beside Save wherever the spending limits editor edits a saved key or agent,
// and the result shows below. The parent holds the replay (useRuleReplay) so Start from a setup can offer "Replay it first"
// with the same result. The router evaluates; this only shows counts, reasons and examples. Nothing is saved.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { REPLAY_WORDS as W, replayBar, replayCompareText, replayExamples, replayHeadline, replayReasons, replayStale, replayStopText, runReplay } from '../../lib/rule-replay';
import st from './SpendingLimits.module.css';

const idle = { busy: false, data: null, error: '', errors: [], policy: null };

/** `request` is api() with the signed-in key. run() takes the editor's built rulebook ({ policy, errors }). */
export function useRuleReplay(request, keyHash) {
  const [state, setState] = useState(idle);
  const pending = useRef(null), target = useRef(null);
  useEffect(() => { pending.current?.abort(); setState(idle); return () => pending.current?.abort(); }, [request, keyHash]);
  const run = useCallback(async built => {
    pending.current?.abort();
    if (built.errors.length) return setState(s => ({ ...s, busy: false, error: '', errors: built.errors }));
    const controller = new AbortController();
    pending.current = controller;
    setState(s => ({ ...s, busy: true, error: '', errors: [] }));
    try {
      const data = await runReplay(request, keyHash, built.policy, { signal: controller.signal });
      if (!controller.signal.aborted) setState({ ...idle, data, policy: built.policy });
    } catch (error) {
      if (!controller.signal.aborted) setState(s => ({ ...s, busy: false, error: error?.message || 'The replay could not be completed.' }));
    } finally { if (pending.current === controller) pending.current = null; }
  }, [request, keyHash]);
  const reveal = useCallback(() => { const el = target.current; if (!el) return; el.scrollIntoView({ block: 'nearest' }); el.focus({ preventScroll: true }); }, []);
  return { ...state, run, reveal, target };
}

/** After a starter setup fills the editor: replay those values before saving them. */
export function ReplayFirst({ onReplay }) {
  return <p className="help-text"><button type="button" className="text-button" onClick={onReplay}>{W.setup}</button> {W.setupHelp}</p>;
}

export function ReplayButton({ replay, onRun, disabled = false }) {
  return <Button type="button" secondary disabled={disabled || replay.busy} onClick={onRun}>{replay.busy ? W.busy : W.button}</Button>;
}

export default function ReplayResult({ id, replay, current }) {
  const { data, busy, error, errors } = replay;
  const bar = data ? replayBar(data) : [];
  const reasons = data ? replayReasons(data) : [];
  const examples = data ? replayExamples(data) : [];
  const stop = data ? replayStopText(data) : '';
  const compare = data ? replayCompareText(data) : '';
  return <div id={id} ref={replay.target} tabIndex={-1} className={st.replay} aria-live="polite">
    {!data && !busy && !error && !errors.length && <p className="help-text">{W.help}</p>}
    {errors.length > 0 && <div role="alert"><p>{W.fix}</p><ul className="error">{errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status">{W.busy}</p>}
    {data && <section className={st.replayResult} aria-label={W.title}>
      <p className={st.replayDone}><strong>{W.done}</strong></p>
      {replayStale(replay.policy, current) && <p className="help-text">{W.stale}</p>}
      <p>{replayHeadline(data)}</p>
      {data.evaluated > 0 && <>
        <div className={st.replayBar} role="img" aria-label={bar.map(s => `${s.label}: ${s.count}`).join(', ')}>
          {bar.filter(s => s.count > 0).map(s => <span key={s.key} className={st[s.key]} style={{ flexGrow: s.count }}/>)}
        </div>
        <ul className={st.replayLegend}>{bar.map(s => <li key={s.key}><i className={st[s.key]} aria-hidden="true"/>{s.label} <strong>{s.count.toLocaleString('en-US')}</strong> <span>{s.percent}%</span></li>)}</ul>
        {stop && <p className={st.replayStop}>{stop}</p>}
        {compare && <p className="help-text">{compare}</p>}
        {reasons.length > 0 && <><h4 className={st.replayHeading}>{W.reasons}</h4><ul className={st.replayReasons}>{reasons.map(r => <li key={r.code}>{r.text} <strong>({r.count.toLocaleString('en-US')})</strong></li>)}</ul></>}
        {examples.length > 0 && <details className={st.replayExamples}><summary>{W.examples} ({examples.length})</summary>
          <ol>{examples.map(e => <li key={e.id} className={st[e.tone]}>
            <div className={st.replayExampleHead}><strong>{e.decision}</strong><time>{e.time}</time></div>
            <p>{[e.what, e.lane, e.cost].filter(Boolean).join(' · ')}</p>
            {e.reason && <p>{e.reason}</p>}
            <p className="help-text">{e.actual}{e.changed ? ' · different now' : ''}</p>
          </li>)}</ol>
        </details>}
      </>}
      {data.notes.length > 0 && <><h4 className={st.replayHeading}>{W.notes}</h4><ul className={st.replayNotes}>{data.notes.map(n => <li key={n}>{n}</li>)}</ul></>}
    </section>}
  </div>;
}
