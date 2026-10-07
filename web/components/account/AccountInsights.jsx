'use client';
import ProjectFilter from './ProjectFilter.js'; // C134
import ProjectBreakdown from './ProjectBreakdown.js'; // C134
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { initialInsightRange, insightsPath, insightSeries, provenShare } from '../../lib/insights.js';
import InsightsChart from './InsightsChart.js';
import s from './Insights.module.css';
function Breakdown({ title, rows, keyLabels = false }) {
  return <section className="control-panel"><h3>{title}</h3><div className="insights-table-wrap"><table><caption>{title} · USDG</caption><thead><tr><th scope="col">{keyLabels ? 'Key or agent' : 'Name'}</th><th scope="col">Net spend</th><th scope="col">Calls</th></tr></thead><tbody>{rows.map((row,i)=><tr key={row.id ?? i}><th scope="row">{keyLabels ? row.label : row.id || 'Unknown'}</th><td>{row.cost_usd}</td><td>{row.calls}</td></tr>)}</tbody></table></div>{!rows.length && <p>No records in this range.</p>}</section>;
}
export default function AccountInsights({ apiKey, compareHref = '/cost/' }) {
  const [form,setForm] = useState(initialInsightRange), [query,setQuery] = useState(initialInsightRange);
  const [report,setReport] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [off,setOff] = useState(false), [revision,setRevision] = useState(0);
  useEffect(()=>{
    const controller = new AbortController(); setReport(null);setError('');setOff(false);setBusy(true);
    api(insightsPath(query),{key:apiKey,signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setReport(value);}).catch(e=>{if(!controller.signal.aborted){if(e.status===404)setOff(true);else setError(e.message);}}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[apiKey,query,revision]);
  const field = name => ({value:form[name],onChange:e=>setForm(old=>({...old,[name]:e.target.value}))});
  return <div className={s.insights}>
    <section className="control-panel"><div className="panel-heading"><h2>Insights</h2><a className="inline-link" href="/dashboard/#activity">Open activity</a></div><p>See where your money goes, by date, model, key or agent and lane.</p>
      <form className={s.filters} onSubmit={e=>{e.preventDefault();const days=(Date.parse(form.to)-Date.parse(form.from))/86400000;if(!Number.isFinite(days)||days<=0||days>92){setError('Choose a range of 1 to 92 days.');return;}setQuery({...form});}}>
        <ProjectFilter value={form.project || ''} onChange={project => setForm(old => ({ ...old, project }))}/> {/* C134 */}
        <label>From (UTC)<input type="date" required {...field('from')}/></label><label>Before (UTC)<input type="date" required {...field('to')}/></label><label>Group dates<select {...field('bucket')}><option value="day">Day</option><option value="week">Week · Monday UTC</option></select></label><button className="text-button" type="submit">Read insights</button>
      </form><button className="text-button" disabled={busy} onClick={()=>setRevision(n=>n+1)}>Refresh</button>
      {busy && <p role="status">Reading spend…</p>}{off && <p role="status">Spend insights are not switched on yet.</p>}{error && <p className="error" role="alert">{error}</p>}
    </section>
    {report && <>
      <p className="help-text">{report.scope==='account'?'Account spending across visible keys.':'Spending for this key only.'} {report.from.slice(0,10)} to before {report.to.slice(0,10)}, UTC. Refunds count on the date they were posted, including refunds for earlier calls. Deposits and agreement funds are excluded.</p>
      <section className={'control-panel '+s.stats} aria-label="Spend totals">{[['Net spend',report.totals.cost_usd+' USDG'],['Calls',report.totals.calls],['Average per call',report.totals.average_cost_usd===null?'No calls':report.totals.average_cost_usd+' USDG'],['Calls on proven hardware',provenShare(report.totals)]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
      <p className="help-text">Charged: {report.totals.charged_usd} USDG · Refunded: {report.totals.refunded_usd} USDG. Average is net spend divided by calls, truncated to 12 decimal places. Hardware share counts signed receipts recording a successful hardware check for that call; missing evidence and stored answers do not count. This does not prove answer quality or hide ordinary prompts from the router.</p>
      <section className="control-panel"><h3>Spend over time</h3><p className="help-text">{report.bucket==='week'?'Weeks start Monday UTC; edge weeks cover only the selected range.':'Days use UTC.'} Bars show net spend; refunds can make it negative.</p><InsightsChart rows={insightSeries(report)}/></section>
      <ProjectBreakdown rows={report.projects}/> {/* C134 */}
      <div className={s.grid}><Breakdown title="By model" rows={report.models}/><Breakdown title="By key or agent" rows={report.keys} keyLabels/><Breakdown title="By lane" rows={report.lanes}/><Breakdown title="Top models by cost" rows={report.top_models_by_cost}/><Breakdown title="Top models by calls" rows={report.top_models_by_calls}/></div>
      <p className="help-text">Model and key lists include up to 100 groups ranked by cost and up to 100 ranked by calls. Totals include all visible records. Unknown means no model or lane was recorded.</p>
      <section className="control-panel"><h3>Same abilities, lower price</h3><p>This is a price comparison, not a quality claim. Compare currently live endpoints with the same capability tags, at least the same context window and all your recorded lanes, with the same or stronger recorded disclosure class. Unknown lane or disclosure records have no suggestions. Estimates reprice your input/output token mix and call count at current token and request rates. They exclude refunds, cache discounts, royalties, account fees and extra reasoning, image or search charges. Routing and future usage can change the price.</p>
        {report.suggestions.length ? report.suggestions.map(group=><div className={s.suggestions} key={group.model}><h4>{group.model}</h4><p className="help-text">{group.tokens_in} input tokens · {group.tokens_out} output tokens</p>{group.alternatives.map(model=><div key={model.model}><strong>{model.name}</strong><p>Estimated saving: {model.estimated_saving_usd} USDG over this range ({model.baseline_usd} → {model.estimated_cost_usd} USDG).</p><div className="button-row"><a className="inline-link" href={'/harness/?model='+encodeURIComponent(model.model)}>Try it in the chat</a><a className="inline-link" href={compareHref}>{compareHref==='/cost/'?'Compare on /cost/':'Compare models and prices'}</a></div></div>)}</div>):<p>No lower-price match found for your top models with the recorded lanes and token mix.</p>}
      </section>
    </>}
  </div>;
}
