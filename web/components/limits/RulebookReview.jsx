'use client';
// K189: capture the existing form submit; only Save after review reaches its existing handler.
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../UI';
import ReplayResult, { ReplayButton } from './ReplayRules';
import { approverReviewLines, currentReviewReplay, reviewReplaySummary, reviewSignature, reviewState, rulebookReviewLines } from '../../lib/rulebook-review';
import s from './RulebookReview.module.css';

const ReviewContext = createContext(null);
function ReviewButton({ type, disabled, children, ...props }) {
  const state = useContext(ReviewContext);
  if (type !== 'submit') return <Button type={type} disabled={disabled} {...props}>{children}</Button>;
  return <><Button type="submit" disabled={disabled || state.disabled} {...props}>{state.label}</Button>
    {state.notice && <span role="status">{state.notice}</span>}</>;
}

function ChangeReview({ lines, value, errors = [], busy, locked, replay, saveError, children }) {
  const id = useId(), editor = useRef(null), heading = useRef(null), form = useRef(null), confirmed = useRef(null);
  const wasReviewing = useRef(false);
  const [reviewed, setReviewed] = useState(null);
  const signature = reviewSignature(value), state = reviewState(lines, errors, busy || locked);
  const reviewing = reviewed === signature && state.changed && !errors.length;
  const currentReplay = replay && { ...replay, data: currentReviewReplay(replay, value) ? replay.data : null };
  useEffect(() => {
    if (reviewing) heading.current?.focus();
    else if (wasReviewing.current) editor.current?.querySelector('button[type="submit"]')?.focus();
    wasReviewing.current = reviewing;
  }, [reviewing]);
  const back = () => setReviewed(null);
  const capture = event => {
    if (confirmed.current === signature && reviewing && !busy && !locked) { confirmed.current = null; return; }
    // Let the existing form display its validation errors; it cannot save an invalid draft.
    if (errors.length) return;
    event.preventDefault(); event.stopPropagation();
    if (!state.canReview) return;
    form.current = event.target;
    setReviewed(signature);
    if (replay && !currentReviewReplay(replay, value)) replay.run({ policy: value, errors: [] });
  };
  return <ReviewContext.Provider value={state}>
    <div ref={editor} className={s.editor} hidden={reviewing} onSubmitCapture={capture}>{children(ReviewButton)}</div>
    {reviewing && <section className={s.review} aria-labelledby={id}>
      <h3 id={id} ref={heading} tabIndex={-1}>Review changes</h3>
      <p>Compare your saved settings with this edit. Nothing changes until you save.</p>
      <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      {saveError && <p role="alert">{saveError}</p>}
      {replay && <>
        <h4>Last 7 days</h4>
        <p aria-live="polite">{replay.busy ? 'Replaying these rules…' : reviewReplaySummary(currentReviewReplay(replay, value) ? replay.data : null)}</p>
        <ReplayResult id={`${id}-replay`} replay={currentReplay} current={value}/>
        <p className="help-text">Inherited rules and Stop state still apply to live calls.</p>
        <ReplayButton replay={replay} disabled={busy} onRun={() => replay.run({ policy: value, errors: [] })}/>
      </>}
      {!replay && <p className="help-text">Approver changes cannot be replayed against past calls. Owners can always approve.</p>}
      <div className="button-row">
        <Button type="button" disabled={busy || locked || !state.canReview} onClick={() => {
          confirmed.current = signature;
          form.current?.requestSubmit();
        }}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button type="button" secondary disabled={busy} onClick={back}>Back</Button>
      </div>
    </section>}
  </ReviewContext.Provider>;
}

export default function RulebookReview({ saved, draft, replay, busy, locked, children }) {
  return <ChangeReview lines={draft.errors.length ? ['Changes need valid fields'] : rulebookReviewLines(saved, draft.policy)}
    value={draft.policy} errors={draft.errors} replay={replay} busy={busy} locked={locked}>{children}</ChangeReview>;
}

export function ApproverReview({ before, after, members, busy, saveError, children }) {
  return <ChangeReview lines={approverReviewLines(before, after, members)} value={after} busy={busy} saveError={saveError}>{children}</ChangeReview>;
}
