import { autonomyLadder } from '../../lib/agent-autonomy';
import { utcTime } from '../../lib/agents';
import s from './autonomy.module.css';
export default function Autonomy({ agent }) {
  const policies = (agent.policies || []).filter(p => p.autonomy);
  if (!policies.length) return null;
  return <section className="control-panel"><h2>Autonomy ladder</h2>
    <p className="help-text">Trust grows after both the elapsed time and clean request requirement are met at each rung. Spending caps alone increase. The router enforces this for requests through AnyRoute.</p>
    {policies.map(p => <article key={p.key_hash}><h3>{p.inherited ? 'Inherited rulebook' : 'Agent rulebook'}</h3>
      <ol className={s.ladder}>{autonomyLadder(p.policy,p.autonomy).map(r => <li key={r.rung} className={r.current ? s.current : ''} aria-current={r.current ? 'step' : undefined}><strong>Rung {r.rung} · caps ×{r.caps_multiplier}</strong><span>{r.rung === 0 ? 'Starting caps' : `${r.after_days} days and ${r.clean_requests} clean requests at the preceding rung`}</span>{r.current && <span>Current rung</span>}</li>)}</ol>
      <p>At this rung since {utcTime(p.autonomy.since)} · {p.autonomy.clean_requests} clean requests.</p>
      {p.autonomy.next ? <p role="status">Next rung: {Math.ceil(p.autonomy.next.days_remaining * 100) / 100} days and {p.autonomy.next.requests_remaining} more clean requests required.</p> : <p role="status">Highest rung reached.</p>}
      <p className="help-text">Return to rung 0 on: {p.policy.autonomy.demote_on.join(', ') || 'no selected events'}. Saving a rulebook restarts the ladder. Output token limits, models, tools, lanes, windows and approvals keep their original rules.</p>
    </article>)}
  </section>;
}
