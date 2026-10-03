'use client';
import {useEffect,useMemo,useState} from 'react';
import {Button,Code} from './UI';
import {API_BASE} from '../lib/api';
import {TOOLS_PATH,callBody,describeTools,filterTools} from '../lib/tools';
import styles from './ToolsCatalog.module.css';

function Tool({t}){
  return <li className={styles.card} data-state={t.state}>
    <div className={styles.cardHead}><h3>{t.name}</h3><span className={styles.mark} data-state={t.state}>{t.stateLabel}</span></div>
    {t.summary&&<p className={styles.summaryText}>{t.summary}</p>}
    <dl className={styles.facts}>
      <div className={styles.fact}><dt>Address</dt><dd><code>{t.method} {t.resource}</code></dd></div>
      <div className={styles.fact}><dt>Price per call</dt><dd><span>{t.price} in USDG, plus the router’s take</span></dd></div>
      <div className={styles.fact}><dt>Seller wallet</dt><dd><code>{t.payTo||'Not stated'}</code>{t.skill&&<span className={styles.sub}>Paid invocation of a Skills Hub skill.</span>}</dd></div>
    </dl>
    <details className={styles.call}><summary>Call it from your balance</summary><Code label="POST /api/v1/tools/call">{callBody(t)}</Code></details>
  </li>;
}

/** The public catalog of x402 tools, read from GET /api/v1/tools. */
export default function ToolsCatalog(){
  const [load,setLoad]=useState('loading');const [list,setList]=useState([]);const [query,setQuery]=useState('');
  useEffect(()=>{
    const ac=new AbortController();
    fetch(API_BASE+TOOLS_PATH,{signal:ac.signal,headers:{accept:'application/json'}}).then(async res=>{
      if(res.status===404){setLoad('off');return;}
      if(!res.ok)throw new Error(String(res.status));
      const j=await res.json();setList(Array.isArray(j.data)?j.data:[]);setLoad('ok');
    }).catch(e=>{if(e?.name!=='AbortError')setLoad('error')});
    return()=>ac.abort();
  },[]);
  const rows=useMemo(()=>describeTools(list),[list]);
  const shown=useMemo(()=>filterTools(rows,query),[rows,query]);
  return <div className={styles.stack}>
    <section className={styles.section} aria-labelledby="tools-list"><h2 id="tools-list">Listed tools</h2>
      <p className={styles.lead}>Each tool answers an x402 payment request in USDG on Robinhood Chain. The router pays the seller from its own wallet and charges your key the price plus its take, with a signed receipt. Every listed tool gets a paid probe with a known answer each day; three failures in a row delist it.</p>
      <div className="field"><label htmlFor="tool-search">Search tools</label><input id="tool-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="name, summary or address" autoComplete="off" spellCheck="false" maxLength={80}/></div>
      {load==='loading'&&<p className={styles.status} role="status">Reading the router’s tool list…</p>}
      {load==='off'&&<div className={styles.empty} role="status"><h3>The paid tool market is not switched on at this router.</h3><p>Its operator turns it on with TOOLS_MARKET_ENABLED. Until then no tool is listed or paid here.</p></div>}
      {load==='error'&&<div className="error" role="alert">The router could not be reached, so nothing is known about its tools from here. Try again.</div>}
      {load==='ok'&&<p className={styles.status} role="status" aria-live="polite">{rows.length} {rows.length===1?'tool':'tools'} listed{shown.length!==rows.length?` · showing ${shown.length}`:''}</p>}
      {load==='ok'&&shown.length>0&&<ul className={styles.list}>{shown.map(t=><Tool key={t.id} t={t}/>)}</ul>}
      {load==='ok'&&rows.length===0&&<div className={styles.empty}><h3>No tool is listed yet.</h3><p>Any x402 tool can still be called by its address; listing adds a daily canary and a place in this catalog.</p></div>}
      {load==='ok'&&rows.length>0&&shown.length===0&&<div className={styles.empty}><h3>No tool matches.</h3><p>Clear the search.</p></div>}
    </section>
    <section className={styles.section} id="how" aria-labelledby="tools-how"><h2 id="tools-how">How a paid call works</h2>
      <ul className={styles.notes}>
        <li>You send the tool’s address and a max_price. A quote above it, above your rulebook or above the router’s ceiling is refused before anything is paid.</li>
        <li>A hold covers the price plus the take. A usable answer is charged once; a failed, oversized or non-text answer is not, and its hold is released once the payment authorization expires unused.</li>
        <li>Answers are untrusted data. The router hands one to a model only when your rulebook sets tools.pass_to_models and you ask for it.</li>
        <li>Agents can use the same thing over MCP with anyroute_tools_search and anyroute_tools_call.</li>
      </ul>
      <div className={styles.actions}><Button href="/docs/#paid-tools">Read the docs</Button><Button href="/agents/" secondary>Set a rulebook</Button></div>
    </section>
  </div>;
}
