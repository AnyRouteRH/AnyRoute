'use client';
// B124: the inbox API has approval ids, so resolve rules through the existing authenticated lists once per inbox read.
import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ApprovalRulebook from './ApprovalRulebook';
const Rules = createContext(null);
export function InboxRulebooks({ apiKey, page, children }) {
  const [records, setRecords] = useState(null);
  const active = !!apiKey && page?.data.some(item => item.kind === 'approval' && item.can_decide);
  useEffect(() => {
    setRecords(null);
    if (!active) return;
    const controller = new AbortController();
    Promise.all(['/api/v1/agents', '/api/v1/agents/approvals?status=pending'].map(path => api(path, { key: apiKey, signal: controller.signal })))
      .then(([agents, approvals]) => { if (!controller.signal.aborted) setRecords({ agents: agents.data ?? [], approvals: approvals.data ?? [] }); })
      .catch(() => { /* The approval itself remains readable when its current rules are unavailable. */ });
    return () => controller.abort();
  }, [apiKey, active, page?.as_of]);
  return <Rules.Provider value={records}>{children}</Rules.Provider>;
}
export function InboxApprovalRulebook({ approvalId, intent }) {
  const records = useContext(Rules);
  const approval = records?.approvals.find(row => row.id === approvalId);
  return <ApprovalRulebook agent={records?.agents.find(row => row.key_hash === approval?.key_hash)} intent={intent}/>;
}
