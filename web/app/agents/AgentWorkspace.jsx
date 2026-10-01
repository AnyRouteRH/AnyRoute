'use client';
import { useState } from 'react';
import Activity from './Activity';
import SealedAgent from './SealedAgent';
export default function AgentWorkspace({ agent, request, refreshVersion, children }) {
  const [tab, setTab] = useState('rulebook');
  return <><SealedAgent agent={agent} request={request}/><div className="button-row" role="tablist" aria-label="Agent views"><button type="button" role="tab" id="agent-rulebook-tab" aria-selected={tab === 'rulebook'} aria-controls="agent-view" onClick={() => setTab('rulebook')}>Rulebook</button><button type="button" role="tab" id="agent-activity-tab" aria-selected={tab === 'activity'} aria-controls="agent-view" onClick={() => setTab('activity')}>Activity &amp; receipts</button></div><div id="agent-view" role="tabpanel" aria-labelledby={tab === 'activity' ? 'agent-activity-tab' : 'agent-rulebook-tab'}>{tab === 'activity' ? <Activity agent={agent} request={request} refreshVersion={refreshVersion}/> : children}</div></>;
}
