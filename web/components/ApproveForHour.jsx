'use client';
// K194: the preview checks current role and the original ask-first rule.
import { useEffect, useState } from 'react';
import { Button } from './UI';
import s from './ApproveAndAllow.module.css';
import { approvalHourPath, approveHour } from '../lib/approval-window';
export default function ApproveForHour({ request, id, disabled, onApproved }) {
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const ac = new AbortController(); setPreview(null);
    request(approvalHourPath(id), { signal: ac.signal }).then(r => { if (!ac.signal.aborted) setPreview(r.data); }).catch(() => {});
    return () => ac.abort();
  }, [request, id]);
  async function approve() {
    setBusy(true); setError('');
    try {
      await approveHour(request, id, preview.confirmation);
      window.dispatchEvent(new Event('anyroute:agents-changed'));
      window.dispatchEvent(new Event('anyroute-inbox-changed'));
      onApproved?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!preview) return null;
  return <div style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}><Button secondary className={s.option} disabled={disabled || busy} onClick={approve}>{busy ? 'Saving…' : 'Approve for the next hour'}</Button><p className="help-text">Allow matching requests from this agent for one hour. The same ask-first rule, model, declared tools and target must match. Caps and Stop still apply.</p>{error && <p role="alert" className="error">{error}</p>}</div>;
}
