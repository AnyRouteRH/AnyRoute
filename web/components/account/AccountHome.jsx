'use client';
import AccountActivity from './AccountActivity';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { pendingApprovals } from '../../lib/agents.js';
import { homeChecklist, homeSpend } from './account-state.js';
import s from './AccountShell.module.css';
const dollars = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value);
export default function AccountHome({ apiKey, workspace, onReceipt, onRefresh }) {
  const [data, setData] = useState({});
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  useEffect(() => {
    const ac = new AbortController(); setData({});
    const read = async (name, path, parse = r => r.data) => {
      try { const response = await api(path, { key: apiKey, signal: ac.signal }); const value = parse(response); if (!ac.signal.aborted) setData(old => ({ ...old, [name]: value })); }
      catch (e) { if (!ac.signal.aborted) setData(old => ({ ...old, [name + 'Error']: e.message })); }
    };
    read('agents', '/api/v1/agents', r => { if (!Array.isArray(r.data)) throw new Error('The agent list could not be read.'); return r.data; });
    read('approvals', '/api/v1/agents/approvals?status=pending', pendingApprovals);
    read('spend', '/api/v1/spend?period=7d&group_by=day');
    return () => ac.abort();
  }, [apiKey, revision]);
  const spend = homeSpend(data.spend);
  const approvals = data.approvals?.filter(row => Date.parse(row.expires_at) > Date.now());
  const steps = homeChecklist(workspace, data.agents);
  const status = name => data[name + 'Error'] || 'Reading account details…';
  return <div className={s.home}>
    <div className="panel-heading"><h2>Home</h2><button className="text-button" disabled={refreshing} onClick={async () => { setRefreshing(true); setRefreshError(''); try { await onRefresh(); setRevision(r => r + 1); } catch (e) { setRefreshError(e.message); } finally { setRefreshing(false); } }}>Refresh account details</button></div>
    {refreshError && <p className="error" role="alert">{refreshError}</p>}
    <p>Pay for calls from one balance. Follow each call’s receipt to inspect what ran, where, what it cost and the rules recorded for it.</p>
    <div className={s.cards}>
      <section className="control-panel"><h3>Balance</h3><dl><div><dt>Available</dt><dd>{dollars(workspace.credits.available ?? workspace.credits.balance)}</dd></div></dl><a className="inline-link" href="/dashboard/#payments">Add funds and see payment options</a></section>
      <section className="control-panel"><h3>Spend</h3>{spend ? <><dl><div><dt>Today</dt><dd>{dollars(spend.today)}</dd></div><div><dt>This week</dt><dd>{dollars(spend.week)}</dd></div></dl><p className="help-text">UTC days · week starts Monday · {spend.scope === 'account' ? 'all account keys' : 'this key only'}</p></> : <p className="help-text" role="status">{status('spend')}</p>}<a className="inline-link" href="/dashboard/#spend-watch">Watch spending</a></section>
      <section className="control-panel"><h3>Keys</h3>{workspace.keysError ? <p className="help-text">{workspace.keysError}</p> : <p>{workspace.keys.length} account keys · {workspace.keys.filter(key => !key.disabled).length} active</p>}<a className="inline-link" href="/dashboard/#api-keys">Manage keys and budgets</a></section>
      <section className="control-panel"><h3>Agents</h3>{data.agents ? <p>{data.agents.length} agent keys · {data.agents.filter(agent => agent.killed).length} stopped</p> : <p className="help-text" role="status">{status('agents')}</p>}<a className="inline-link" href="/agents/">Manage agent rules</a></section>
      <section className="control-panel"><h3>Waiting for you</h3>{approvals ? <p>{approvals.length} approvals waiting</p> : <p className="help-text" role="status">{status('approvals')}</p>}<a className="inline-link" href="/agents/#approvals">Review approvals</a></section>
      {steps.length > 0 && <section className="control-panel"><h3>Next steps</h3><ul>{steps.map(step => <li key={step.id}><a className="inline-link" href={step.href}>{step.title}</a></li>)}</ul></section>}
    </div>
    <AccountActivity apiKey={apiKey} recent/>
  </div>;
}
