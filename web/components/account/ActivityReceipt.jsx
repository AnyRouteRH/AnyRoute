'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
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
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Show signed receipt</summary>{error ? <p role="alert">{error}</p> : receipt ? <pre className="activity-receipt">{JSON.stringify(receipt, null, 2)}</pre> : <p role="status">Reading receipt…</p>}</details>;
}
