'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import ProofBadge from '../ProofBadge';
export default function ActivityReceipt({ row, apiKey }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setReceipt(null); setError('');
    api(row.receipt_url, { key: apiKey, signal: controller.signal }).then(value => { if (!controller.signal.aborted) setReceipt(value); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [open, apiKey, row.receipt_url]);
  // U76: the badge comes from the recorded receipt id until the signed receipt is read, then from the receipt itself.
  return <><ProofBadge evidence={receipt ? { source: 'receipt', data: receipt } : { source: 'ledger', data: { receipt_id: row.receipt_id } }}/>
    <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Show signed receipt</summary>{error ? <p role="alert">{error}</p> : receipt ? <pre className="activity-receipt">{JSON.stringify(receipt, null, 2)}</pre> : <p role="status">Reading receipt…</p>}</details></>;
}
