'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../UI';
import { api } from '../../lib/api.js';
import { downloadJson } from '../../lib/statements.js';
import { defaultProofPackRange, PROOF_PACK_LIMITS_PATH, PROOF_PACK_VERIFY_COMMAND, proofPackFilename, proofPackPath, proofPackRangeError, proofPackSummary } from '../../lib/proof-pack.js';
import s from './Statements.module.css';
// U100: shown only once the router says this key may read proof packs (the route answers 404 when statements are off,
// 403 for inference-only keys).
export default function AccountProofPack({ apiKey }) {
  const [limits, setLimits] = useState(null), [range, setRange] = useState(defaultProofPackRange);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(null);
  const request = useRef(null);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; setLimits(null); setSaved(null); setError('');
    api(PROOF_PACK_LIMITS_PATH, { key: apiKey, signal: controller.signal }).then(r => { if (!controller.signal.aborted) setLimits(r.data); }).catch(() => {});
    return () => controller.abort();
  }, [apiKey]);
  useEffect(() => { setSaved(null); setError(''); }, [range.from, range.to]);
  if (!limits) return null;
  async function download(cursor) {
    const problem = proofPackRangeError(range, limits.max_days);
    if (problem) { setError(problem); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const summary = proofPackSummary(await api(proofPackPath({ ...range, cursor }), { key: apiKey, signal: controller.signal }));
      if (controller.signal.aborted) return;
      downloadJson(summary.pack, proofPackFilename(summary.pack)); setSaved(summary);
    } catch (e) { if (!controller.signal.aborted) setError(e.status === 429 ? 'Too many proof packs from this key. Try again within a minute.' : e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="control-panel" aria-labelledby="proof-pack-title"><h2 id="proof-pack-title" tabIndex={-1}>Proof pack</h2>
    <p>One file for a date range that anyone can check with no network: {limits.scope === 'account' ? "the account's calls" : "this key's own calls"} with their signed receipts and Merkle paths, the statements and refund receipts for those dates, and the router's signing keys. Receipts carry hashes, never prompt or answer text.</p>
    <form onSubmit={e => { e.preventDefault(); download(); }} className={s.controls}>
      <div className="field"><label htmlFor="proof-pack-from">From (UTC)</label><input id="proof-pack-from" type="date" required value={range.from} max={range.to} onChange={e => setRange(r => ({ ...r, from: e.target.value }))}/></div>
      <div className="field"><label htmlFor="proof-pack-to">To (UTC, included)</label><input id="proof-pack-to" type="date" required value={range.to} min={range.from} onChange={e => setRange(r => ({ ...r, to: e.target.value }))}/></div>
      <Button type="submit" disabled={busy || !apiKey}>{busy ? 'Preparing…' : 'Download proof pack'}</Button>
    </form>
    <p className="help-text">Up to {limits.max_days} days per pack. A range with more than {limits.max_calls.toLocaleString('en-US')} calls downloads in parts.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {saved && <div role="status"><p>Saved part {saved.part}: {saved.calls} calls, {saved.refunds} refund receipts, {saved.statements} statements, {saved.paths} Merkle paths.</p>
      {saved.next && <Button secondary disabled={busy} onClick={() => download(saved.next)}>Download the next part</Button>}</div>}
    <p className="help-text">Check it with <code>{PROOF_PACK_VERIFY_COMMAND}</code> using scripts/verify-proof-pack.mjs from the Anyroute source, or one receipt at a time in <a href="/verify/">Verify</a>.</p>
  </section>;
}
