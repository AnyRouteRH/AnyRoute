'use client';
import { useEffect, useState } from 'react';
import ApproveAndAllow from '../../components/ApproveAndAllow'; // B118
import { Button } from '../../components/UI';
import { pendingApprovals, decideAgentApproval, intentSummary, formatUsd, picoUsd, utcTime } from '../../lib/agents';

export default function Approvals({ request, agents, onError }) {
  const [rows,setRows] = useState([]);
  const [busy,setBusy] = useState('');
  const [revision,setRevision] = useState(0);
  const [loading,setLoading] = useState(true);
  useEffect(() => {
    const ac = new AbortController();
    const read = async () => {
      try {
        const data = await request('/api/v1/agents/approvals?status=pending',{ signal:ac.signal });
        if (!ac.signal.aborted) setRows(pendingApprovals(data));
      } catch(error) { if (!ac.signal.aborted) onError(error); }
      finally { if (!ac.signal.aborted) setLoading(false); }
    };
    read(); const timer = setInterval(read,15000);
    return () => { ac.abort(); clearInterval(timer); };
  }, [request,revision,onError]);
  const decide = async (id,action) => {
    setBusy(id);
    try { await decideAgentApproval(request,id,action); setRows(old => old.filter(r => r.id !== id)); }
    catch(error) { onError(error); }
    finally { setBusy(''); setRevision(r => r+1); }
  };
  return <section className="control-panel"><div className="button-row"><h2>Waiting for you</h2><Button secondary disabled={!!busy} onClick={() => setRevision(r => r+1)}>Refresh approvals</Button></div>
    <p className="help-text">Your agent asks you first above its approval threshold. Approval authorizes one matching request up to this estimated ceiling; the agent must retry before expiry. Other rulebook restrictions still apply.</p>
    {!rows.length && <p role="status">{loading ? 'Reading approvals…' : 'No pending approvals.'}</p>}
    {rows.map(row => <article key={row.id}><h3>{agents.find(a => a.key_hash === row.key_hash)?.name || 'Unnamed agent'} · up to {formatUsd(picoUsd(row.max_cost_pico))}</h3><p style={row.intent?.kind === 'action' ? { overflowWrap: 'anywhere' } : undefined}>{intentSummary(row.intent)}</p><p>Expires {utcTime(row.expires_at)}</p><div className="button-row"><Button disabled={!!busy || Date.parse(row.expires_at) <= Date.now()} onClick={() => decide(row.id,'approve')}>Approve</Button><Button secondary disabled={!!busy || Date.parse(row.expires_at) <= Date.now()} onClick={() => decide(row.id,'deny')}>Deny</Button></div><ApproveAndAllow request={request} id={row.id} disabled={!!busy || Date.parse(row.expires_at) <= Date.now()} onApproved={() => { setRows(old => old.filter(r => r.id !== row.id)); setRevision(r => r+1); }}/></article>)}
  </section>;
}
