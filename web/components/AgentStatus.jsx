'use client';
// J176: shared card/detail status; links sit outside the card's selection button.
import { useEffect, useState } from 'react';
import { useAccountKey } from './account/useAccountKey';
import { api } from '../lib/api';
import { agentStatusParts } from '../lib/agent-status';
import s from './AgentStatus.module.css';

export default function AgentStatus({ agent, refreshVersion = 0 }) {
  const [key] = useAccountKey();
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!key || agent.approval_only) return;
    const ac = new AbortController();
    const read = () => api('/api/v1/agents/' + encodeURIComponent(agent.key_hash) + '/status', { key, signal: ac.signal })
      .then(response => { if (!ac.signal.aborted) setState({ key, hash: agent.key_hash, data: response.data }); })
      .catch(() => { if (!ac.signal.aborted) setState({ key, hash: agent.key_hash, error: true }); });
    setState(null); read();
    const timer = setInterval(read, 60_000);
    window.addEventListener('anyroute:agents-changed', read);
    return () => { ac.abort(); clearInterval(timer); window.removeEventListener('anyroute:agents-changed', read); };
  }, [key, agent, refreshVersion]);
  if (!key || agent.approval_only) return null;
  const current = state?.key === key && state?.hash === agent.key_hash ? state : null;
  return <p className={s.line} aria-label={`Status for ${agent.name || 'Unnamed agent'}`}>
    {current?.data ? agentStatusParts(current.data, agent.policies).map((part, index) => <span key={part.kind}>{index > 0 && <span aria-hidden="true"> · </span>}<a href={part.href} title={part.title}>{part.text}</a></span>)
      : <span role="status">{current?.error ? 'Agent status could not be read.' : 'Reading agent status…'}</span>}
  </p>;
}

export function withAgentStatus(QuietAlert) { // J176: extend the existing card setting without changing its callers.
  return function AgentCardStatus(props) {
    return <><AgentStatus agent={props.agent}/><QuietAlert {...props}/></>;
  };
}
