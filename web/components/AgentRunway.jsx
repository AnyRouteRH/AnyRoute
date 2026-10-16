'use client';
import RunwayChargeLinks from './RunwayChargeLinks.js'; // J182
// H170: shared renderer for agent cards and the selected agent's rulebook page.
import { useEffect, useState } from 'react';
import { useAccountKey } from './account/useAccountKey';
import { api } from '../lib/api';
import { agentRunwayLines } from '../lib/agent-runway';
import s from './agent-runway.module.css';

export default function AgentRunway({ agent, children }) {
  const [key] = useAccountKey();
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!key || agent.approval_only) return;
    const ac = new AbortController();
    setState(null);
    api('/api/v1/agents/' + encodeURIComponent(agent.key_hash) + '/runway', { key, signal: ac.signal }).then(response => {
      if (!ac.signal.aborted) setState({ key, hash: agent.key_hash, data: response.data });
    }).catch(() => { if (!ac.signal.aborted) setState({ key, hash: agent.key_hash, error: true }); });
    return () => ac.abort();
  }, [key, agent]);
  const current = state?.key === key && state?.hash === agent.key_hash ? state : null;
  return <>{children}{!agent.approval_only && <span className={s.runway} aria-label="Agent budget runway">
    {current?.data ? <>{agentRunwayLines(current.data).map(line => <span key={line}>{line}</span>)}
      <RunwayChargeLinks data={current.data}/> {/* J182 */}
      {current.data.limits.length > 0 && <span className={s.limit}>Estimates use only this key’s charged spend. Rolling windows, session spend and pending requests can change when requests are refused.</span>}
    </> : <span role="status">{current?.error ? 'Budget runway could not be read.' : 'Reading budget runway…'}</span>}
  </span>}</>;
}
