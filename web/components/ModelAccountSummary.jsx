'use client';
// J178: use the same account connection, watch control and comparison selection.
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAccountKey } from './account/useAccountKey';
import ModelWatchButton from './model-watch/ModelWatchButton';
import { ModelCompareButton } from './ModelComparePicks';
import { Button } from './UI';
import { modelChatHref } from '../lib/model-page.js';
import ModelAccountResults from './ModelAccountResults.js';
import s from './account/Savings.module.css';
import { modelSummaryPath } from '../lib/model-account-summary.js';

function ConnectedSummary({ model, apiKey }) {
  const [report, setReport] = useState(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError('');
    api(modelSummaryPath(model.id), { key: apiKey, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not read your model activity. Check your account connection and try again.'); });
    return () => controller.abort();
  }, [model.id, apiKey, revision]);
  return <section className={'control-panel ' + s.savings} aria-labelledby="your-model-title">
    <div className="panel-heading"><h2 id="your-model-title">You and this model</h2><button className="text-button" type="button" onClick={() => setRevision(n => n + 1)}>Refresh</button></div>
    {!report && !error && <p role="status">Reading your model activity…</p>}
    {error && <p role="alert">{error}</p>}
    {report && <ModelAccountResults report={report} model={model}/>}
    <div className="button-row"><ModelWatchButton model={model}/><ModelCompareButton model={model}/><Button href={modelChatHref(model.id)}>Try in Chat</Button></div>
  </section>;
}
export default function ModelAccountSummary({ model }) {
  const [key] = useAccountKey();
  return key ? <ConnectedSummary key={key + model.id} apiKey={key} model={model}/> : null;
}
