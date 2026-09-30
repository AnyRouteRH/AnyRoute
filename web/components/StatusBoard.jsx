'use client';
import {useEffect,useState} from 'react';
import {API_BASE} from '../lib/api';
import {ATTESTATION_PATH,FEEDS,REFRESH_MS,SLO_PATH,advisories,describeSlo} from '../lib/status-slo';
import {verifyHref} from '../lib/verify';
import styles from './StatusBoard.module.css';

const Pill=({tone,children})=><span className={styles.pill} data-tone={tone}>{children}</span>;

/** 90 solid bars, one per UTC day, oldest on the left. */
function Strip({cells,lane}){
  return <div className={styles.stripWrap}>
    <div className={styles.strip} role="img" aria-label={`${lane}: daily availability for the last ${cells.length} days`}>
      {cells.map(c=><span key={c.day} className={styles.day} data-kind={c.kind} title={c.text}/>)}
    </div>
    <div className={styles.scale} aria-hidden="true"><span>{cells.length} days ago</span><span>today</span></div>
  </div>;
}

function Lane({v}){
  return <article className={styles.lane} aria-labelledby={`lane-${v.id}`} data-state={v.state.tone}>
    <header className={styles.laneHead}>
      <h3 id={`lane-${v.id}`}>{v.name}</h3>
      <Pill tone={v.state.tone}>{v.state.label}</Pill>
    </header>
    <p className={styles.blurb}>{v.blurb}</p>
    <div className={styles.big}><strong>{v.headline||'No data'}</strong><span>30 days · target {v.target}{v.noisy&&' · noisy'}</span></div>
    <Strip cells={v.strip} lane={v.name}/>
    <dl className={styles.windows}>{v.windows.map(w=><div key={w.name}><dt>{w.label}</dt><dd>{w.pct||'no data'}</dd></div>)}</dl>
    <dl className={styles.facts}>
      <div><dt>Latency p50 / p95</dt><dd>{v.p50||'no data'} / {v.p95||'no data'}</dd></div>
      <div><dt>Error budget</dt><dd>
        {v.budget.pct!==null&&<span className={styles.budget} data-exhausted={v.budget.exhausted?'true':undefined}><i style={{width:`${v.budget.pct}%`}}/></span>}
        <span className={styles.budgetText}>{v.budget.pct!==null?`${v.budget.pct}% left. `:''}{v.budget.text}</span>
      </dd></div>
    </dl>
    {v.noisy&&<p className={styles.noise}>Differentially private: every figure here is summed from noisy hourly totals, never from single requests. The attested and unlinkable lanes share those totals, so they show one combined figure.</p>}
  </article>;
}

function Incident({i}){
  return <li id={i.anchor} className={styles.incident} data-open={i.open?'true':undefined}>
    <div className={styles.incidentHead}><strong>{i.title}</strong><Pill tone={i.open?(i.impact==='critical'?'bad':'warn'):'ok'}>{i.status}</Pill></div>
    <p className={styles.meta}>{i.scope} · started {i.started}{i.resolved&&<> · resolved {i.resolved}</>}</p>
    <ol className={styles.updates}>{i.updates.map((u,k)=><li key={k}><span>{u.at} · {u.status}</span>{u.text}</li>)}</ol>
  </li>;
}

/** The public status page: per-lane SLOs, per-surface figures, incidents and attestation advisories, refreshed every 30 s. */
export default function StatusBoard(){
  const [slo,setSlo]=useState(null);const [att,setAtt]=useState(null);const [load,setLoad]=useState('loading');
  useEffect(()=>{
    let ac=new AbortController();
    const get=async(path)=>{const r=await fetch(API_BASE+path,{signal:ac.signal,headers:{accept:'application/json'}});if(!r.ok)throw new Error(String(r.status));return (await r.json()).data};
    const run=async()=>{
      ac.abort();ac=new AbortController();
      const [s,a]=await Promise.allSettled([get(SLO_PATH),get(ATTESTATION_PATH)]);
      if(s.status==='fulfilled'){setSlo(s.value);setLoad('ok')}else if(s.reason?.name!=='AbortError')setLoad('error');
      if(a.status==='fulfilled')setAtt(a.value);
    };
    run();
    const t=setInterval(()=>{if(!document.hidden)run()},REFRESH_MS);
    return()=>{clearInterval(t);ac.abort()};
  },[]);
  const view=describeSlo(slo);
  const notes=att?advisories(att):null;
  return <div className={styles.stack}>
    {load==='loading'&&<p className={styles.lead} role="status">Reading the router’s record…</p>}
    {load==='error'&&<div className="error" role="alert">The status record could not be read just now.{view&&' The figures below are from the last successful read.'}</div>}
    {view&&<>
      <section className={styles.now} data-tone={view.headline.tone} aria-live="polite"><span className={styles.dot} aria-hidden="true"/><h2>{view.headline.text}</h2></section>
      {view.open.length>0&&<section aria-labelledby="open-h"><h2 id="open-h" className={styles.h}>Open incidents</h2><ul className={styles.incidents}>{view.open.map(i=><Incident key={i.id} i={i}/>)}</ul></section>}
      <section aria-labelledby="lanes-h">
        <h2 id="lanes-h" className={styles.h}>Lanes</h2>
        <ul className={styles.legend} aria-label="How to read the bars">
          <li><span className={styles.key} data-kind="ok"/>At or above target</li>
          <li><span className={styles.key} data-kind="dip"/>Below target</li>
          <li><span className={styles.key} data-kind="bad"/>Under 95%</li>
          <li><span className={styles.key} data-kind="none"/>No data</li>
        </ul>
        <div className={styles.lanes}>{view.lanes.map(v=><Lane key={v.id} v={v}/>)}</div>
      </section>
      <section aria-labelledby="surfaces-h">
        <h2 id="surfaces-h" className={styles.h}>API surfaces · public lane · 24 hours</h2>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th scope="col">Surface</th><th scope="col">State</th><th scope="col">Availability</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">5xx rate</th></tr></thead>
          <tbody>{view.surfaces.map(s=><tr key={s.id}><th scope="row">{s.name}</th><td><Pill tone={s.state.tone}>{s.state.label}</Pill></td><td>{s.day}</td><td>{s.p50}</td><td>{s.p95}</td><td>{s.errors}</td></tr>)}</tbody>
        </table></div>
        <p className={styles.note}>Latency is time to first token for streams and to the full answer otherwise, read as the top of a fixed bucket. Private lanes have no per-surface figures: their noisy totals are not split by surface.</p>
      </section>
      <section aria-labelledby="tcb-h">
        <h2 id="tcb-h" className={styles.h}>Attestation advisories</h2>
        {notes===null?<p className={styles.note}>The attestation record is not available on this router.</p>
          :notes.length===0?<p className={styles.calm}>No advisories. Every attesting provider holds a current verification and no measured software changed in the last 7 days.</p>
          :<ul className={styles.advisories}>{notes.map((n,k)=><li key={k} data-tone={n.tone}>{n.text} <a href={verifyHref(n.provider)}>Verify</a></li>)}</ul>}
      </section>
      <section aria-labelledby="history-h">
        <h2 id="history-h" className={styles.h}>Incident history · 90 days</h2>
        {view.history.length?<ul className={styles.incidents}>{view.history.map(i=><Incident key={i.id} i={i}/>)}</ul>:<p className={styles.calm}>No incidents in the last 90 days.</p>}
        <p className={styles.note}>Follow incidents by <a href={API_BASE+FEEDS.atom}>Atom</a> or <a href={API_BASE+FEEDS.rss}>RSS</a>. Read {view.generatedAt?new Date(view.generatedAt).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'):'just now'}; this page refreshes every 30 seconds while it is open.</p>
      </section>
    </>}
  </div>;
}
