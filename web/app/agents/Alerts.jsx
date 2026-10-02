'use client';
import { useEffect, useState } from 'react';
import { alertLabel } from '../../lib/agent-alerts';
import { utcTime } from '../../lib/agents';
export default function Alerts({ request, keyHash, refreshVersion, onError }) {
  const [rows,setRows] = useState([]), [busy,setBusy] = useState(true), [revision,setRevision] = useState(0);
  useEffect(() => {
    const ac = new AbortController(); setBusy(true); setRows([]);
    request('/api/v1/agents/'+encodeURIComponent(keyHash)+'/alerts',{signal:ac.signal}).then(r => {
      if (!ac.signal.aborted) { if (!Array.isArray(r.data)) throw new Error('The alerts response could not be read.'); setRows(r.data); }
    }).catch(e => { if (!ac.signal.aborted) onError(e); }).finally(() => { if (!ac.signal.aborted) setBusy(false); });
    return () => ac.abort();
  }, [request,keyHash,refreshVersion,revision,onError]);
  return <section className="control-panel"><h2>Owner alerts</h2><p className="help-text">Newest 100 alerts across the account, kept for up to 90 days. Delivery runs every minute while the worker is active. Cap alerts count charges plus open reservations; each percentage is announced once per rolling hour, day or week. No prompt or answer text is included.</p>
    <p><a href="/dashboard/webhooks/">Manage webhook destinations</a> where signing is enabled.</p> {/* V86. */}
    <button className="text-button" disabled={busy} onClick={() => setRevision(n => n+1)}>Refresh alerts</button>
    {busy ? <p role="status">Reading alerts…</p> : !rows.length && <p>No alerts recorded for this agent.</p>}
    <ol>{rows.map(row => <li key={row.id}><strong>{alertLabel(row)}</strong> · <time dateTime={row.at}>{utcTime(row.at)}</time><p>{({pending:'Delivery pending',delivered:'Delivered to linked channels',failed:'Delivery failed after bounded attempts',feed_only:'Feed only: no selected linked channel'})[row.delivery] || 'Delivery status unavailable'}</p></li>)}</ol>
  </section>;
}
