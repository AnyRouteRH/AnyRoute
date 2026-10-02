'use client';
import { useState } from 'react';
import { API_BASE } from '../../lib/api.js';
import { firstCallCurl } from '../../lib/first-call.js';
import { Code } from '../UI';
import FirstCallSteps from './FirstCallSteps.js';
import useFirstCall from './useFirstCall.js';
import './first-call.css';
export default function FirstCallQuickstart({ apiKey = '', workspace, account = false }) {
  const [revision, setRevision] = useState(0);
  const snapshot = useFirstCall(apiKey, workspace, revision);
  const connected = !!snapshot.me?.hash;
  const code = firstCallCurl({ account, apiKey: connected ? apiKey : '', baseUrl: API_BASE || 'https://anyroute.tech' });
  return <section className="first-call" aria-label="Get started with the API">
    <FirstCallSteps snapshot={snapshot}/>
    {apiKey ? <><p className="help-text">Progress refreshes every 15 seconds while this page is visible. A call counts when it appears in your account history.</p><button className="text-button" onClick={() => setRevision(value => value + 1)}>Refresh progress</button></> : <p className="help-text">Sign in from your account to see your progress here.</p>}
    {Object.keys(snapshot).some(name => name.endsWith('Error')) && <p className="help-text" role="status">Some account details could not be read. Refresh to try again.</p>}
    <p className="help-text">{account && connected ? 'This example contains your connected key. Keep it safe.' : 'Set ANYROUTE_API_KEY to your key in your shell before running this command.'} Choose a model from <a className="inline-link" href="/models/">the model list</a>.</p>
    <Code label="First API call">{code}</Code>
    <p className="help-text">For ordinary calls, the router reads request text in memory to route it. <a className="inline-link" href="/keep/">See what we keep</a>.</p>
  </section>;
}
