'use client';
import {useEffect,useMemo,useState} from 'react';
import {Button,Code} from './UI';
import {API_BASE} from '../lib/api';
import {PROVIDERS_PATH,QUICKSTART,QUICKSTART_FLAGS,describeProviders,filterProviders} from '../lib/providers';
import styles from './Providers.module.css';

const FILTERS=[['all','All'],['attested','Attested'],['unverified','Not attested']];

function Card({p}){
  return <li className={styles.card} data-state={p.status}>
    <div className={styles.cardHead}><h3>{p.name}</h3><span className={styles.slug}>{p.id}</span><span className={styles.mark} data-state={p.status}>{p.statusLabel}</span></div>
    <dl className={styles.facts}>
      <div className={styles.fact}><dt>Hardware</dt><dd>{p.tee}</dd></div>
      <div className={styles.fact}><dt>Quote checked by</dt><dd>{p.verifiers.length?<ul className={styles.verifiers}>{p.verifiers.map(v=><li key={v.id}>{v.label}</li>)}</ul>:<span>{p.verifiersNote||'Nobody yet.'}</span>}</dd></div>
      <div className={styles.fact}><dt>Last attestation</dt><dd><span>{p.last}</span>{p.reason&&<span className={styles.sub}>{p.reason}</span>}</dd></div>
      <div className={styles.fact}><dt>Models</dt><dd><span>{p.models} live {p.models===1?'model':'models'}</span><span className={styles.sub}>{p.lifecycle}. Data policy as the provider declares it: {p.declared.training?'may train on prompts':'no training'}, {p.declared.retainsPrompts?'keeps prompts':'does not keep prompts'}. Not verified.</span></dd></div>
    </dl>
    <div className={styles.cardFoot}><a className="inline-link" href={p.href}>Check it yourself<span className="sr-only"> for {p.name}</span></a></div>
  </li>;
}

/** The public provider list, read from GET /api/v1/providers, and how to run a provider. */
export default function Providers(){
  const [load,setLoad]=useState('loading');const [list,setList]=useState([]);const [now,setNow]=useState(0);
  const [status,setStatus]=useState('all');const [query,setQuery]=useState('');
  useEffect(()=>{
    const ac=new AbortController();
    fetch(API_BASE+PROVIDERS_PATH,{signal:ac.signal,headers:{accept:'application/json'}}).then(async res=>{
      if(!res.ok)throw new Error(String(res.status));
      const j=await res.json();setList(Array.isArray(j.data)?j.data:[]);setNow(Date.now());setLoad('ok');
    }).catch(e=>{if(e?.name!=='AbortError')setLoad('error')});
    return()=>ac.abort();
  },[]);
  const view=useMemo(()=>describeProviders(list,now||Date.now()),[list,now]);
  const shown=useMemo(()=>filterProviders(view.rows,{status,query}),[view,status,query]);
  const c=view.counts;
  return <div className={styles.stack}>
    <section className={styles.section} aria-labelledby="p-list"><h2 id="p-list">Providers</h2>
      <p className={styles.lead}>Every provider the router lists, with what the router itself has verified about it. “Attested” means the router checked a hardware quote from that provider recently. It does not show what a provider does with prompts. Anything not checked is marked Unverified, and each row links to the full record.</p>
      <div className={styles.tools}>
        <div className="field"><label htmlFor="provider-search">Search providers</label><input id="provider-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="name or id" autoComplete="off" spellCheck="false" maxLength={80}/></div>
        <div className={styles.filter} role="group" aria-label="Filter by attestation">{FILTERS.map(([v,label])=><button key={v} type="button" aria-pressed={status===v} onClick={()=>setStatus(v)}>{label}</button>)}</div>
      </div>
      {load==='loading'&&<p className={styles.summary} role="status">Reading the router’s provider list…</p>}
      {load==='error'&&<div className="error" role="alert">The router could not be reached, so nothing is known about its providers from here. That is not the same as “unverified”; try again.</div>}
      {load==='ok'&&<p className={styles.summary} role="status" aria-live="polite">{c.total} {c.total===1?'provider':'providers'} · {c.attested} attested · {c.unverified+c.simulated} not attested{c.simulated?` (${c.simulated} simulated)`:''}{shown.length!==c.total?` · showing ${shown.length}`:''}</p>}
      {load==='ok'&&shown.length>0&&<ul className={styles.list}>{shown.map(p=><Card key={p.id} p={p}/>)}</ul>}
      {load==='ok'&&c.total===0&&<div className={styles.empty}><h3>No providers are listed yet.</h3><p>Be the first: the steps are below.</p></div>}
      {load==='ok'&&c.total>0&&shown.length===0&&<div className={styles.empty}><h3>No provider matches.</h3><p>Clear the search or choose All.</p></div>}
    </section>

    <section className={styles.section} id="run" aria-labelledby="p-run"><h2 id="p-run">Run a provider</h2>
      <p className={styles.lead}>Serve an open-weights model from confidential hardware you control. One command measures your weights, writes a pinned deployment for Phala Cloud (CPU or GPU) or your own Intel TDX host, and makes the key your router account will use. Nothing is published or paid for until you deploy and apply.</p>
      <Code label="Terminal · one command, it asks the rest">{QUICKSTART}</Code>
      <ol className={styles.steps}>
        <li><div><strong>Measure and write</strong><span><code>init</code> hashes the weights (a SHA-256 over every file), writes <code>sidecar.yaml</code> and a compose file with every image, the weights and the sidecar source pinned by hash, and stores a router key in a private file. Only the key’s SHA-256 goes in the configuration.</span></div></li>
        <li><div><strong>Deploy</strong><span>On Phala Cloud, <code>phala deploy</code> with the compose file. On your own TDX host, <code>docker compose up -d</code>. The model server has no route out.</span></div></li>
        <li><div><strong>Check it</strong><span><code>doctor</code> reads your endpoint the way a user’s client would: <code>/healthz</code>, the shape of <code>/attest</code>, that the served digest is your weights, that the certificate carries the attestation name and key, and that a response carries a receipt signed by the attested key.</span></div></li>
        <li><div><strong>Apply</strong><span><code>apply --submit</code> files your provider application. An operator reviews it before anything is routed. Once the router has verified your endpoint, it appears in the list above and <a className="inline-link" href="/verify/">the verify page</a> shows the digests it recorded.</span></div></li>
      </ol>
      <Code label="Terminal · without questions">{QUICKSTART_FLAGS}</Code>
      <ul className={styles.gaps}>
        <li>The sidecar attests the Intel TDX virtual machine. It does not collect NVIDIA confidential-computing evidence, so a GPU’s state is not covered.</li>
        <li><code>doctor</code> does not repeat Intel’s signature check on the quote. The router does that, and says so on the verify page.</li>
        <li>Data-policy fields in your application are your own declaration. The router shows them as declared, not verified.</li>
      </ul>
      <div className={styles.actions}><Button href="/docs/#run-a-provider">Read the docs</Button><Button href="/verify/" secondary>Verify a provider</Button></div>
    </section>
  </div>;
}
