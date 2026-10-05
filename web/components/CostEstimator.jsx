"use client";
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { MODEL_CAPABILITIES } from '../lib/model-capabilities.js';
import { modelTagCounts } from '../lib/model-catalog.js';
import { estimateTokens } from '../lib/arena.js';
import { COST_SIZES, COST_SORTS, DEFAULT_COST_STATE, costState, readCostState, costHref, costInputTokens, costRows, formatCost, perMillionRate } from '../lib/cost-estimator.js';
import { CapabilityChips, CapabilityGuide } from './ModelCapabilities';
import { Button, CopyButton } from './UI';
import filters from './ModelCatalog.module.css';
import s from './CostEstimator.module.css';

export default function CostEstimator() {
  const [state, setState] = useState(DEFAULT_COST_STATE);
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [edited, setEdited] = useState(false);
  const [systemEdited, setSystemEdited] = useState(false);
  const [ready, setReady] = useState(false);
  const [share, setShare] = useState('');
  const [query, setQuery] = useState('');
  const [models, setModels] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const restore = () => { setState(readCostState(window.location.search)); setPrompt(''); setSystem(''); setEdited(false); setSystemEdited(false); };
    restore(); setReady(true);
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const input = costInputTokens(state, edited ? prompt : undefined, systemEdited ? system : undefined);
  const systemTokens = systemEdited ? estimateTokens(system) : state.systemTokens;
  useEffect(() => {
    if (!ready) return;
    const href = costHref({ ...state, input, systemTokens });
    window.history.replaceState(null, '', href);
    setShare(window.location.origin + href);
  }, [state, input, systemTokens, ready]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    // Only the public catalogue is requested. Neither text field enters this call.
    api('/api/v1/models', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.data)) throw new Error('The model catalogue could not be read.');
      setModels(result.data);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [attempt]);
  const update = patch => setState(current => costState({ ...current, ...patch }));
  const rows = useMemo(() => costRows(models || [], { ...state, query, input }), [models, state, query, input]);
  const counts = useMemo(() => modelTagCounts(models || [], { query, tags: state.tags }), [models, query, state.tags]);
  const toggle = key => update({ tags: state.tags.includes(key) ? state.tags.filter(tag => tag !== key) : [...state.tags, key] });
  return <div className={s.root}>
    <section className={s.inputs} aria-labelledby="estimate-heading">
      <div className={s.intro}><h2 id="estimate-heading">Set your request size</h2><p>Your prompt and system prompt never leave this browser on this page. The calculator fetches the public model catalogue and computes costs here. Shared links contain choices and token counts, never prompt text.</p></div>
      <div className={s.controls}>
        <label>Input size<select value={state.size} onChange={e => update({ size: e.target.value })}>{COST_SIZES.map(size => <option key={size.key} value={size.key}>{size.label}</option>)}</select></label>
        {state.size === 'document' && <label>About how many pages?<input type="number" min="1" max="1000" step="1" value={state.pages} onChange={e => update({ pages: e.target.value })} /></label>}
        <label>Expected output<select value={[128, 512, 2048].includes(state.output) ? state.output : 'custom'} onChange={e => { if (e.target.value === 'custom') update({ output: 1000 }); else update({ output: Number(e.target.value) }); }}><option value="128">Short · 128 tokens</option><option value="512">Medium · 512 tokens</option><option value="2048">Long · 2,048 tokens</option><option value="custom">Choose token count</option></select></label>
        <label>Output tokens<input type="number" min="0" max="1000000" step="1" value={state.output} onChange={e => update({ output: e.target.value })} /></label>
        <label>Requests per day<input type="number" min="0" max="1000000" step="1" value={state.volume} onChange={e => update({ volume: e.target.value })} /></label>
      </div>
      {state.size === 'prompt' && <label className={s.text}>Paste a prompt<textarea rows="5" maxLength={1000000} value={prompt} onChange={e => { setPrompt(e.target.value); setEdited(true); }} />{!edited && <small>Using the shared input estimate of {state.input.toLocaleString('en-US')} tokens. Paste text to replace it.</small>}</label>}
      <details className={s.system}><summary>Add a system prompt (optional)</summary><label className={s.text}>System prompt<textarea rows="3" maxLength={1000000} value={system} onChange={e => { setSystem(e.target.value); setSystemEdited(true); if (state.size === 'prompt') setEdited(true); }} />{state.size !== 'prompt' && !systemEdited && state.systemTokens > 0 && <small>Shared system prompt estimate: {state.systemTokens.toLocaleString('en-US')} tokens. Add text to replace it.</small>}</label></details>
      <div className={s.summary}><p><strong>{input.toLocaleString('en-US')}</strong> estimated input tokens · <strong>{state.output.toLocaleString('en-US')}</strong> output tokens · <strong>{(state.volume * 30).toLocaleString('en-US')}</strong> requests per 30-day month</p>{share && <CopyButton text={share} label="Copy estimate link" />}</div>
      <p className={s.note}>Token counts are estimates: about one token per four characters, using the same helper as Chat. Presets use 100 input tokens for a question, 1,500 for a coding task, or 500 per document page (about 2,000 characters). Actual token use depends on the model, language and request format.</p>
    </section>

    <section aria-labelledby="cost-results">
      <div className={s.resultHead}><h2 id="cost-results">Compare live models</h2><span role="status">{models && !error ? `${rows.length} of ${models.length} models` : ''}</span></div>
      <div className={s.search}><label>Search model or provider<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label><label>Sort by<select value={state.sort} onChange={e => update({ sort: e.target.value })}>{COST_SORTS.map(sort => <option key={sort.key} value={sort.key}>{sort.label}</option>)}</select></label></div>
      <div className={filters.filters} role="group" aria-label="Filter by capability">{MODEL_CAPABILITIES.map(tag => <button type="button" key={tag.key} title={tag.explanation} aria-pressed={state.tags.includes(tag.key)} disabled={!state.tags.includes(tag.key) && !counts[tag.key]} onClick={() => toggle(tag.key)}>{tag.label}<span>{counts[tag.key]}</span></button>)}</div>
      <CapabilityGuide />
      <p className={s.note}>Prices from the live catalogue; routing may pick another provider</p>
      <p className={s.note}>USD estimates use input and output token rates plus any listed per-request fee. They exclude image, audio, search, cache and separate reasoning charges, conversation history and request-format overhead. They do not reserve a price or check whether your request fits a model’s limits. Amounts round half up to six decimals per request and two per month; monthly totals use the unrounded request cost. Small positive amounts are shown with &lt;.</p>
      {error ? <div className="empty" role="alert"><h3>The model catalogue could not be loaded.</h3><p>{error}</p><Button secondary onClick={() => setAttempt(n => n + 1)}>Retry</Button></div> : !models ? <p className="empty" role="status">Loading the live catalogue…</p> : !rows.length ? <div className="empty"><h3>No matching models</h3><p>{models.length ? 'Try another search or clear the capability filters.' : 'No models are listed right now.'}</p><Button secondary onClick={() => { setQuery(''); update({ tags: [] }); }}>Clear filters</Button></div> : <div className={s.rows}>{rows.map(({ model, cost, cheapest }) => <article key={model.id} className={s.row} data-cheapest={cheapest || undefined}>
        <div className={s.model}><div className={s.modelHeading}><h3>{model.name || model.id}</h3>{cheapest && <span className={s.cheapest}>Among the cheapest</span>}</div><p className={s.providers}>{model.provider_names?.join(', ') || model.provider_name || model.id}</p><CapabilityChips model={model} /><p className={s.rates}>{formatCost(perMillionRate(model.pricing?.prompt))} / 1M input · {formatCost(perMillionRate(model.pricing?.completion))} / 1M output{cost.fee !== null && cost.fee > 0n ? ` · ${formatCost(cost.fee)} request fee` : ''}</p></div>
        <dl className={s.amounts}><div><dt>Input cost</dt><dd>{formatCost(cost.input)}</dd></div><div><dt>Output cost</dt><dd>{formatCost(cost.output)}</dd></div><div><dt>Per request</dt><dd>{formatCost(cost.total)}</dd></div><div><dt>Per month</dt><dd>{formatCost(cost.monthly, 2)}</dd></div></dl>
        <div className={s.links}><a className="text-button" href={'/harness/?model=' + encodeURIComponent(model.id)}>Try it in the chat →</a><a className="text-button" href="/models/">Open in /models →</a></div>
      </article>)}</div>}
    </section>
  </div>;
}
