'use client';
import {useEffect,useRef,useState} from 'react';
import {Button,Code} from './UI';
import {API_BASE} from '../lib/api';
import {HISTORY_QUERY,SUMMARY_PATH,badgeImage,badgeMarkdown,badgeSnippet,describeHistory,describeRegistry,historyPath,measurementVersions,registryIdFrom,verifyHref} from '../lib/registry';
import {describeProvider} from '../lib/proof-time';
import styles from './Registry.module.css';

const origin=()=>API_BASE||(typeof window!=='undefined'?window.location.origin:'');
const when=(iso)=>{const t=Date.parse(iso||'');return Number.isFinite(t)?new Date(t).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'):''};
const Mark=({status,children})=><span className={styles.mark} data-state={status}><i aria-hidden="true"/>{children}</span>;

async function readJson(path,signal){const res=await fetch(API_BASE+path,{signal,headers:{accept:'application/json'}});if(!res.ok){const e=new Error(String(res.status));e.status=res.status;throw e}return res.json()}
const failText=(e)=>e?.status===501?'This router does not keep an attestation history, so there is no registry to show.':e?.status===404?'This router does not list that provider.':'The router could not be reached, so nothing is known from here. That is not the same as unverified; try again.';

/** The live badge, drawn by the same /badge.js a host page loads. */
function BadgePreview({id,theme}){
  const ref=useRef(null);
  useEffect(()=>{
    const box=ref.current;if(!box||!id)return;
    box.replaceChildren();
    const s=document.createElement('script');s.src=origin()+'/badge.js';s.async=true;s.dataset.endpoint=id;s.dataset.theme=theme;
    box.appendChild(s);
    return()=>box.replaceChildren();
  },[id,theme]);
  return <div className={styles.preview} data-theme={theme}><span className={styles.previewLabel}>{theme==='dark'?'On a dark page':'On a light page'}</span><div ref={ref}/></div>;
}

export function BadgeKit({id}){
  const o=origin();
  return <section className={styles.section} aria-labelledby="r-badge"><h2 id="r-badge">Badge</h2>
    <p className={styles.lead}>Put this on your site. The script reads the router’s public record from each visitor’s browser, checks that the attestation is fresh and that the records agree, and shows Attested only when every check passes. The hardware quote itself is verified by the router, and the badge says so.</p>
    <div className={styles.previews}><BadgePreview id={id} theme="light"/><BadgePreview id={id} theme="dark"/></div>
    <Code label="HTML · script badge, checks in the browser">{badgeSnippet(o,id)}</Code>
    <Code label="HTML · image badge, no script">{badgeImage(o,id)}</Code>
    <Code label="Markdown · README or model card">{badgeMarkdown(o,id)}</Code>
  </section>;
}

/** /registry/: every provider the router attests, with its current measurement and how long it held a fresh attestation. */
export function RegistryList(){
  const [load,setLoad]=useState('loading');const [rows,setRows]=useState([]);const [err,setErr]=useState('');
  useEffect(()=>{
    const ac=new AbortController();
    readJson(SUMMARY_PATH,ac.signal).then(j=>{setRows(describeRegistry(j.data,Date.now()));setLoad('ok')}).catch(e=>{if(e?.name!=='AbortError'){setErr(failText(e));setLoad('error')}});
    return()=>ac.abort();
  },[]);
  const attested=rows.filter(r=>r.status==='attested').length;
  return <div className={styles.stack}>
    <section className={styles.section} aria-labelledby="r-list"><h2 id="r-list">Attested endpoints</h2>
      <p className={styles.lead}>Every provider that attests through this router, read live from its proof-time record. Each entry keeps the measurements the router verified over time, so a change of software shows up as a new version on the record.</p>
      {load==='loading'&&<p className={styles.summary} role="status">Reading the router’s record…</p>}
      {load==='error'&&<div className="error" role="alert">{err}</div>}
      {load==='ok'&&<p className={styles.summary} role="status">{rows.length} {rows.length===1?'endpoint':'endpoints'} on record · {attested} attested now</p>}
      {load==='ok'&&rows.length===0&&<div className={styles.empty}><h3>No provider attests through this router yet.</h3><p>Providers without hardware attestation are listed on <a className="inline-link" href="/providers/">the providers page</a>.</p></div>}
      {load==='ok'&&rows.length>0&&<ul className={styles.rows}>{rows.map(r=><li key={r.id}><a className={styles.row} href={r.href}>
        <span className={styles.who}><strong>{r.name}</strong><span className={styles.id}>{r.id}</span></span>
        <Mark status={r.status}>{r.label}</Mark>
        <span className={styles.cell}><span className={styles.k}>Measurement</span><span className={styles.v}>{r.version||r.versionNote}</span></span>
        <span className={styles.cell}><span className={styles.k}>Fresh, 7 days</span><span className={styles.v}>{r.share?<>{r.share} <small>{r.shareNote}</small></>:r.shareNote}</span></span>
        <span className={styles.cell}><span className={styles.k}>Last change</span><span className={styles.v}>{r.lastChange}</span></span>
      </a></li>)}</ul>}
    </section>
    <section className={styles.section} aria-labelledby="r-embed"><h2 id="r-embed">Show it on your site</h2>
      <p className={styles.lead}>Each entry has an embeddable badge that checks the record from the visitor’s browser, and an image variant for places that do not run scripts.</p>
      <Code label="HTML">{badgeSnippet(origin()||'https://<router>','<provider id or model id>')}</Code>
      <div className={styles.actions}><Button href="/docs/#badge">Badge docs</Button><Button href="/verify/" secondary>Verify a provider</Button></div>
    </section>
  </div>;
}

/** /registry/<id>/: one provider's measurement history, newest first, and its badge. */
export function RegistryEntry(){
  const [id,setId]=useState(null);const [load,setLoad]=useState('loading');const [err,setErr]=useState('');
  const [view,setView]=useState(null);const [events,setEvents]=useState([]);const [next,setNext]=useState(null);const [more,setMore]=useState(false);const [now,setNow]=useState(0);
  useEffect(()=>{setId(registryIdFrom(window.location.pathname,window.location.search))},[]);
  useEffect(()=>{
    if(id===null)return;
    if(!id){setErr('No provider id in the address. Pick one from the registry.');setLoad('error');return}
    const ac=new AbortController();
    Promise.all([readJson(SUMMARY_PATH,ac.signal),readJson(historyPath(id)+HISTORY_QUERY,ac.signal)]).then(([s,h])=>{
      const t=Date.now();const p=(s.data?.providers||[]).find(x=>x.provider===id);
      setView(p?describeProvider(p,s.data,t):null);setEvents(h.data||[]);setNext(h.next||null);setNow(t);setLoad('ok');
    }).catch(e=>{if(e?.name!=='AbortError'){setErr(failText(e));setLoad('error')}});
    return()=>ac.abort();
  },[id]);
  const older=async()=>{
    if(!next)return;setMore(true);
    try{const h=await readJson(historyPath(id)+HISTORY_QUERY+'&before='+encodeURIComponent(next));setEvents(ev=>[...ev,...(h.data||[])]);setNext(h.next||null)}catch{setErr('The older part of the record could not be read. Try again.')}finally{setMore(false)}
  };
  const spans=describeHistory(events,now||Date.now());
  const versions=measurementVersions(events);
  return <div className={styles.stack}>
    {load==='loading'&&<p className={styles.summary} role="status">Reading the router’s record…</p>}
    {load==='error'&&<div className="error" role="alert">{err} <a className="inline-link" href="/registry/">Back to the registry</a></div>}
    {load==='ok'&&<>
      <section className={styles.section} aria-labelledby="r-now">
        <div className={styles.head}><h2 id="r-now">{view?.name||id}</h2><span className={styles.id}>{id}</span>{view?<Mark status={view.status}>{view.label}</Mark>:<Mark status="unverified">Not on record</Mark>}</div>
        <p className={styles.lead}>{view?<>{view.text}{view.lastVerified&&<> Last verified {view.lastVerified}.</>}</>:'This provider is not in the proof-time record: the router does not attest it now. Its earlier history, if any, is below.'}</p>
        {view&&<dl className={styles.facts}>
          {view.windows.map(w=><div key={w.name}><dt>{w.label}</dt><dd><strong>{w.shareText||(w.state==='empty'?'No record':'Too early')}</strong><span>{w.caption}</span></dd></div>)}
          <div><dt>Hardware</dt><dd><strong>{view.tee}</strong></dd></div>
          <div><dt>Last failed check</dt><dd><span>{view.failure.state==='seen'?`${view.failure.when}. ${view.failure.text}`:view.failure.text}</span></dd></div>
        </dl>}
        <div className={styles.actions}><Button href={verifyHref(id)}>What the router checked</Button><Button href="/status/" secondary>Proof-time</Button></div>
      </section>

      <section className={styles.section} aria-labelledby="r-versions"><h2 id="r-versions">Measurement versions</h2>
        <p className={styles.lead}>Each distinct software measurement the router verified in the part of the record read so far, newest first. Show older checks to read further back. A measurement is the compose hash, or the image digest when there is none.</p>
        {versions.length?<ol className={styles.versions}>{versions.map((v,i)=><li key={v.version}><span className={styles.vnum}>{i===0?'Latest':'Earlier'}</span><code title={v.version}>{v.short}</code><span>{v.runs} verified {v.runs===1?'check':'checks'}, {when(v.first)} to {when(v.last)}</span></li>)}</ol>
          :<p className={styles.empty}>No verified measurement in this part of the record.</p>}
      </section>

      <section className={styles.section} aria-labelledby="r-history"><h2 id="r-history">History</h2>
        <p className={styles.lead}>Every attestation check the router ran, newest first. Runs of the same result are folded into one line; a failure or a measurement change is always its own line.</p>
        {spans.length?<ol className={styles.timeline}>{spans.map(s=><li key={s.from+s.to+s.kind} data-kind={s.kind}>
          <span className={styles.when}>{s.when}</span>
          <div><strong>{s.title}</strong><span>{s.text}</span>{s.kind==='changed'&&s.digests.length>0&&<dl className={styles.digests}>{s.digests.map(d=><div key={d.key}><dt>{d.label}</dt><dd><code>{d.value}</code></dd></div>)}</dl>}</div>
        </li>)}</ol>:<p className={styles.empty}>Nothing recorded yet.</p>}
        {next&&<div className={styles.actions}><button type="button" className="text-button" onClick={older} disabled={more}>{more?'Reading…':'Show older checks'}</button></div>}
      </section>

      <BadgeKit id={id}/>
    </>}
  </div>;
}
