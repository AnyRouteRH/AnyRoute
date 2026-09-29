'use client';
import {useEffect,useState} from 'react';
import {API_BASE} from '../lib/api';
import {SUMMARY_PATH,describeSummary,pageState} from '../lib/proof-time';
import styles from './ProofTime.module.css';

const REFRESH_MS=60_000;
const Pill=({tone,children})=><span className={styles.pill} data-tone={tone}>{children}</span>;

/** A timeline of equal slices: a tall cell is covered, a low one with a red base is a gap, a hatched one is before the record begins. */
function Bar({w}){
  return <div className={styles.barWrap}>
    <div className={styles.markers} aria-hidden="true">{w.markers.map(m=><i key={m.at} className={styles.marker} style={{left:`${m.left}%`}}/>)}</div>
    <div className={styles.bar} role="img" aria-label={w.summary} data-count={w.cells.length}>
      {w.cells.map((c,i)=><span key={i} className={styles.cell} data-kind={c.kind} style={c.pct!==null?{'--fill':`${c.pct}%`}:undefined}/>)}
    </div>
  </div>;
}

function Window({w,changes}){
  return <section className={styles.window} aria-label={w.label}>
    <div className={styles.windowHead}>
      <h3>{w.label}</h3>
      {w.shareText?<span className={styles.share}>{w.shareText}</span>:<span className={styles.noShare}>{w.state==='empty'?'No record':'Too early'}</span>}
    </div>
    <Bar w={w}/>
    <div className={styles.scale} aria-hidden="true"><span>{w.name==='24h'?'24 h ago':'7 d ago'}</span><span>now</span></div>
    <p className={styles.caption}>{w.caption}</p>
    {w.markers.length>0&&<ul className={styles.changes}>{changes.filter(c=>w.markers.some(m=>m.at===c.at)).map(c=><li key={c.at}><span className={styles.diamond} aria-hidden="true"/>Measurement changed {c.when}: {c.text}</li>)}</ul>}
  </section>;
}

function Provider({v}){
  return <article className={styles.card} aria-labelledby={`p-${v.id}`}>
    <header className={styles.cardHead}>
      <div className={styles.who}><h2 id={`p-${v.id}`}>{v.name}</h2><span className={styles.id}>{v.id}</span></div>
      <Pill tone={v.tone}>{v.label}</Pill>
    </header>
    <p className={styles.verdict}>{v.text}{v.lastVerified&&<> Last verified {v.lastVerified}.</>}</p>
    <div className={styles.windows}>{v.windows.map(w=><Window key={w.name} w={w} changes={v.changes}/>)}</div>
    <dl className={styles.facts}>
      <div><dt>Last failed check</dt><dd data-state={v.failure.state}>{v.failure.state==='seen'?<><strong>{v.failure.when}</strong>. {v.failure.text}</>:v.failure.text}</dd></div>
      <div><dt>Last measurement change</dt><dd data-state={v.change.state==='seen'?'changed':v.change.state}>{v.change.state==='seen'?<><strong>{v.change.when}</strong>. {v.change.text}</>:v.change.text}</dd></div>
      {v.runs&&<div><dt>Checks passed</dt><dd>{v.runs.text}.</dd></div>}
      <div><dt>Hardware</dt><dd>{v.tee}</dd></div>
      {v.probe&&<div><dt>Health probe</dt><dd data-state={v.probe.ok?'none':'seen'}>{v.probe.text}</dd></div>}
      {v.canary&&<div><dt>Canary</dt><dd data-state={v.canary.ok?'none':'seen'}>{v.canary.text}</dd></div>}
    </dl>
    <a className={styles.verify} href={v.verifyHref}>What the router checked for {v.name} →</a>
  </article>;
}

/** The public proof-time page: for each attesting provider, how much of the last 24 hours and 7 days the router held a fresh attestation. */
export default function ProofTime(){
  const [load,setLoad]=useState('loading');const [data,setData]=useState(null);const [note,setNote]=useState('');const [now,setNow]=useState(0);
  useEffect(()=>{
    let ac=new AbortController();
    const run=async()=>{
      ac.abort();ac=new AbortController();
      try{
        const res=await fetch(API_BASE+SUMMARY_PATH,{signal:ac.signal,headers:{accept:'application/json'}});
        if(!res.ok){const s=pageState(res.status);setNote(s.text);setLoad(s.kind==='off'?'off':'error');if(s.kind==='off')setData(null);return}
        const j=await res.json();setData(j.data);setNow(Date.now());setNote('');setLoad('ok');
      }catch(e){if(e?.name==='AbortError')return;setNote(pageState('network').text);setLoad('error')}
    };
    run();
    const t=setInterval(()=>{if(!document.hidden)run()},REFRESH_MS);
    return()=>{clearInterval(t);ac.abort()};
  },[]);
  const view=data?describeSummary(data,now):null;
  return <div className={styles.stack}>
    {load==='loading'&&<p className={styles.lead} role="status">Reading the router’s record…</p>}
    {load==='off'&&<div className={styles.notice} data-tone="warn" role="status">{note}</div>}
    {load==='error'&&<div className="error" role="alert">{note}{view&&' The figures below are from the last successful read.'}</div>}
    {view&&<>
      <p className={styles.lead}>{view.definition} The router keeps {view.historyDays} days of history, so a provider new to the record shows less than a full window, and says so.</p>
      <ul className={styles.legend} aria-label="How to read the bars">
        <li><span className={styles.key} data-kind="full"/>Fresh attestation held for the whole slice</li>
        <li><span className={styles.key} data-kind="none"/>No fresh attestation: a gap</li>
        <li><span className={styles.key} data-kind="nodata"/>Before the record begins: unknown</li>
        <li><span className={styles.diamond} aria-hidden="true"/>Measurement changed</li>
      </ul>
      {view.providers.length===0?<div className={styles.notice} role="status">No provider attests through this router right now, so there is nothing to measure. Providers without hardware attestation are not listed here.</div>
        :<div className={styles.list}>{view.providers.map((v)=><Provider key={v.id} v={v}/>)}</div>}
      <p className={styles.foot}>Read {view.generatedAt?new Date(view.generatedAt).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'):'just now'}; it refreshes every minute while this page is open. Attestation shows what software a provider’s hardware reported running when the router checked. It does not show what happens to a prompt, and time between checks is not verified time.</p>
    </>}
  </div>;
}
