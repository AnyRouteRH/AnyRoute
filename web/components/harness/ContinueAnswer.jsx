"use client";
// H166: reply controls inherit the lane, including comparison lanes.
import { createContext, useContext } from 'react';
import { useBranchLane } from './Branches';
import { canContinue } from '../../lib/harness-continue.js';
import { receiptHref } from '../../lib/arena.js';
import s from './ContinueAnswer.module.css';

const ContinueContext = createContext(null);
export const ContinueAnswerProvider = ContinueContext.Provider;
export default function ContinueAnswer({ msg, last, busy }) {
  const continueReply = useContext(ContinueContext);
  const laneId = useBranchLane();
  return <div className={s.controls}>
    {last && canContinue(msg) && <div className={s.note} role="status"><span>This answer was cut off</span><button type="button" className="text-button" disabled={busy} onClick={() => continueReply?.(laneId, msg.id)}>Continue</button></div>}
    {msg.continuationCalls?.length > 1 && <nav className={s.receipts} aria-label="Answer receipts">{msg.continuationCalls.map((call, index) => <span key={index}>{call.receiptId ? <a href={receiptHref(call.receiptId)} target="_blank" rel="noopener noreferrer">Call {index + 1} receipt ↗</a> : <>Call {index + 1} receipt pending</>}{call.cost === undefined && <> · cost pending</>}</span>)}</nav>}
  </div>;
}
