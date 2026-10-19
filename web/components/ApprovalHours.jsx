'use client';
// K194: use the existing Agents request and selection.
import { useEffect, useState } from 'react';
import { intentSummary } from '../lib/agents';
import { Button } from './UI';
import { approvalWindowsPath, approvalHourText, endApprovalHour } from '../lib/approval-window';
export default function ApprovalHours({ request, agents }) {
  const [rows, setRows] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    const read = async () => {
      const groups = await Promise.all(agents.filter(a => !a.approval_only).map(async agent => {
        try { const r = await request(approvalWindowsPath(agent.key_hash), { signal: ac.signal }); return r.data.map(w => ({ ...w, agent })); }
        catch { return []; }
      }));
      if (!ac.signal.aborted) setRows(groups.flat());
    };
    read(); const timer = setInterval(read, 60000);
    window.addEventListener('anyroute:agents-changed', read);
    return () => { ac.abort(); clearInterval(timer); window.removeEventListener('anyroute:agents-changed', read); };
  }, [request, agents, revision]);
  async function end(row) {
    setBusy(true); setError('');
    try { await endApprovalHour(request, row.agent.key_hash, row.id); setRows(old => old.filter(w => w.id !== row.id)); window.dispatchEvent(new Event('anyroute:agents-changed')); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); setRevision(v => v + 1); }
  }
  if (!rows.length && !error) return null;
  return <section id="approval-hours" className="control-panel" aria-label="Approval hours"><h2>Approval hours</h2>{rows.filter(row => Date.parse(row.until) > Date.now()).map(row => <div key={row.id}><p style={{ overflowWrap: 'anywhere' }}>{intentSummary(row.intent)}</p><p>{row.agent.name || 'Unnamed agent'} · {approvalHourText(row.until)}</p><Button secondary disabled={busy} onClick={() => end(row)}>End early</Button></div>)}{error && <p role="alert" className="error">{error}</p>}</section>;
}
