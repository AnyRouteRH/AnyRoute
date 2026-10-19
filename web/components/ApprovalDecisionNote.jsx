'use client';
// K186: the same draft follows Approve, Deny, and Approve and allow next time.
import { useEffect, useId, useState } from 'react';
import { setApprovalNote } from '../lib/approval-notes.js';
export default function ApprovalDecisionNote({ request, id, disabled = false }) {
  const field = useId(), [note, setNote] = useState('');
  useEffect(() => { setApprovalNote(request, id, note); return () => setApprovalNote(request, id, ''); }, [request, id, note]);
  return <div className="field" style={{ minWidth: 0, maxWidth: '100%' }}>
    <label htmlFor={field}>Decision note (optional)</label>
    <textarea id={field} rows={2} maxLength={560} value={note} disabled={disabled} aria-describedby={field + '-help'} onChange={event => { if (Array.from(event.target.value).length <= 280) setNote(event.target.value); }} style={{ width: '100%', boxSizing: 'border-box' }}/>
    <p className="help-text" id={field + '-help'}>{Array.from(note).length}/280 characters. Your agent can read this note. Anyroute keeps it with the decision and its history, and never sends it to a model.</p>
  </div>;
}
