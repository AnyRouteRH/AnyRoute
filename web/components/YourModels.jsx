import ModelWatchButton from './model-watch/ModelWatchButton';
import { formatUsd } from '../lib/agents.js';
import { modelPageHref } from '../lib/model-page.js';
import YourModelResults from './YourModelResults.js';

export function YourModelsFilter({ state }) {
  if (!state.signedIn) return null;
  return <div className="button-row"><button type="button" className="text-button" aria-pressed={state.active} onClick={() => state.select(!state.active)}>Your models</button>
    {state.active && <a className="inline-link" href="/docs/#your-models">About your models</a>}
  </div>;
}
export function YourModelsStatus({ state }) {
  if (!state.active) return null;
  return <div aria-live="polite">
    {state.error ? <p role="alert">{state.error} <button type="button" className="text-button" onClick={state.refresh}>Retry</button></p>
      : !state.report ? <p role="status">Reading your models…</p>
      : <><p>{state.report.scope === 'account' ? 'Across your visible account keys.' : 'For this key only.'} Models used in the last 30 days, highest net spend first.</p>
        <p className="help-text">Success counts recorded calls; failures before a call record are excluded. Success does not establish answer quality.</p>
        <button type="button" className="text-button" onClick={state.refresh}>Refresh your models</button></>}
  </div>;
}
export function YourModelStats({ row, model }) {
  if (!row) return null;
  return <div><YourModelResults row={row}/><div className="button-row"><ModelWatchButton model={model}/>
    {row.cheaper_option && <a className="inline-link" href={modelPageHref(row.cheaper_option.model)} title={'View ' + row.cheaper_option.name}>Cheaper option →</a>}
  </div>{row.cheaper_option && <p className="help-text">Same tokens at current catalogue prices: about {formatUsd(row.cheaper_option.estimated_cost_usd)} on {row.cheaper_option.name}. Estimate only; no claim of equal quality.</p>}</div>;
}
