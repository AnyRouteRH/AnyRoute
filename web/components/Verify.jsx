'use client';
import {useEffect,useState} from 'react';
import {CopyButton,Button,Code} from './UI';
import {API_BASE} from '../lib/api';
import {KEYS_PATH,attestationPath,describeAttestation,isEnclaveReceipt,parseReceiptInput,providerIdFromSearch,shortDigest,verifyReceipt} from '../lib/verify';
import {describePrivacy,privacyPath,receiptIdFromSearch} from '../lib/privacy';
import styles from './Verify.module.css';

const WORDS={yes:'Yes',no:'No',partial:'Partly',bad:'Problem',simulated:'Simulated',known:'Reported',unknown:'Unknown',pass:'Passed',fail:'Failed',not_checked:'Not checked'};
const State=({state})=><span className={styles.state} data-state={state}>{WORDS[state]||state}</span>;
const when=(iso)=>{const t=Date.parse(iso||'');return Number.isFinite(t)?new Date(t).toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'):''};

const SDK=`import { AnyRoute } from "@anyroute/client";

const client = new AnyRoute({ baseUrl: "https://<router>", apiKey: process.env.ANYROUTE_API_KEY });

// Reads the router's record and the provider's own /attest, checks the quote binds its TLS key and digests,
// and throws AttestationRefused before anything is sent if a check fails.
const res = await client.chat.completions.create(
  { model: "<model>", messages: [{ role: "user", content: "Hello" }] },
  { attested: { providerId: "<provider id>", attestUrl: "https://<provider>/attest", expected: { modelDigest: "sha256:<digest you expect>" } } },
);
console.log(res.anyroute.receiptVerification.valid);`;

function Lookup({providerId,note}){return <div className={styles.section}>
  <form className={styles.lookup} action="/verify/" method="get">
    <div className="field"><label htmlFor="provider-id">Provider id</label><input id="provider-id" name="p" defaultValue={providerId} placeholder="the id shown next to a model’s provider" autoComplete="off" spellCheck="false" maxLength={128}/></div>
    <Button type="submit">Look up</Button>
  </form>
  {note&&<p className={styles.help} role="status">{note}</p>}
</div>}

/** "What we saw": the router's plain-English label for one answer, looked up by receipt id. */
function Saw({receiptId,asked,load,view}){return <section className={styles.section} aria-labelledby="v-saw"><h2 id="v-saw">What we saw</h2>
  <p className={styles.lead}>A plain-English reading of a receipt: output and usage, who could read the request, who saw your address, how it was paid, what was kept and what hardware answered. The router works it out from the signed receipt, and on every lane it reads the prompt in memory to route it. Enter the id from the <span className="mono">X-Receipt-Id</span> header.</p>
  <form className={styles.lookup} action="/verify/" method="get">
    <div className="field"><label htmlFor="receipt-id">Receipt id</label><input id="receipt-id" name="r" defaultValue={receiptId} placeholder="gen-…" autoComplete="off" spellCheck="false" maxLength={128}/></div>
    <Button type="submit">Show what we saw</Button>
  </form>
  {asked&&!receiptId&&<p className={styles.help} role="status">That is not a valid receipt id. Ids use letters, digits and . _ : -</p>}
  {load==='loading'&&<p className={styles.lead} role="status">Reading the receipt <span className="mono">{receiptId}</span>…</p>}
  {load==='missing'&&<div className={styles.verdict} data-tone="bad" role="status"><div className={styles.verdictHead}><h2>Unknown receipt</h2><span className={styles.who}>{receiptId}</span></div><p>The router has no receipt with this id.</p></div>}
  {load==='error'&&<div className="error" role="alert">The router could not be reached, or did not send a label, so nothing is shown for this receipt. Try again.</div>}
  {view&&<div className={styles.result} role="status">
    <div className={styles.verdict}>
      <div className={styles.verdictHead}><h2>{view.lane}</h2>{view.id&&<span className={styles.who}>{view.id}</span>}</div>
      <ul className={styles.gaps}>{view.summary.map((line,i)=><li key={i}>{line}</li>)}</ul>
    </div>
    {view.rows.length>0&&<div className={styles.panel}><dl className={styles.facts}>{view.rows.map(r=><div className={styles.fact} key={r.key}><dt>{r.title}</dt><dd>{r.text}</dd></div>)}</dl></div>}
    <p className={styles.help}>This is the router’s reading of the receipt. It does not check the receipt’s signature; the checker below does. <span className="mono">privacyLabel(receipt)</span> in <span className="mono">@anyroute/client</span> computes the same label from a receipt you hold.</p>
  </div>}
</section>}

function Attestation({view}){
  const r=view.rows;const m=view.measurement;const log=view.transparencyLog;const reg=view.registry;
  return <>
    <div className={styles.verdict} data-tone={view.verdict.tone} role="status">
      <div className={styles.verdictHead}><h2>{view.verdict.label}</h2>{view.provider&&<span className={styles.who}>{view.provider}</span>}</div>
      <p>{view.verdict.text}</p>
    </div>
    <section className={styles.section} aria-labelledby="v-record"><h2 id="v-record">What the router recorded</h2>
      <div className={styles.panel}><dl className={styles.facts}>
        <div className={styles.fact}><dt>{r.tee.label}</dt><dd><div className={styles.row}><State state={r.tee.state}/><span>{r.tee.value}</span></div></dd></div>
        <div className={styles.fact}><dt>{r.verifiers.label}</dt><dd>{r.verifiers.value.length?r.verifiers.value.map(v=><div className={styles.row} key={v}><State state="yes"/><span>{v}</span></div>):<div className={styles.row}><State state="no"/><span>{r.verifiers.empty}</span></div>}</dd></div>
        <div className={styles.fact}><dt>{r.lastVerified.label}</dt><dd>{r.lastVerified.value?<><div className={styles.row}><State state="yes"/><span>{when(r.lastVerified.value)}</span></div><span className={styles.sub}>{r.lastVerified.relative}. Read when you opened this page; reload to refresh.</span></>:<div className={styles.row}><State state="no"/><span>{r.lastVerified.empty}</span></div>}</dd></div>
        <div className={styles.fact}><dt>Software and model</dt><dd>{m.recorded?<>
          <div className={styles.row}><State state={m.currentlyAttested?'yes':'no'}/><span>{m.currentlyAttested?'These digests are what the provider is running now, as attested.':'Last seen, not currently attested. Do not rely on these for a live request.'}</span></div>
          {m.digests.map(d=><div key={d.key}><span className={styles.sub}>{d.label}</span><div className={styles.digest}><code>{d.value||'not recorded'}</code>{d.value&&<CopyButton text={d.value}/>}</div></div>)}
          <span className={styles.sub}>These are values the provider’s software committed to inside its quote. They are not derived from the hardware registers, and they name a build, not its source code.</span>
        </>:<div className={styles.row}><State state="no"/><span>No measurement is recorded, so the router cannot say which software or model is running.</span></div>}</dd></div>
        <div className={styles.fact}><dt>Transparency log</dt><dd><div className={styles.row}><State state={log.state}/><span>{log.text}</span></div>{log.index!==null&&<span className={styles.sub}>Log index {log.index}{log.integratedAt?`, integrated ${when(log.integratedAt)}`:''}</span>}{log.bundleDigest&&<span className={styles.sub}>Bundle digest {log.bundleDigest}</span>}{log.entryUrl&&<span className={styles.sub}><a href={log.entryUrl} rel="noopener noreferrer">Read the log entry from the log</a></span>}</dd></div>
        <div className={styles.fact}><dt>On-chain registry</dt><dd><div className={styles.row}><State state={reg.state}/><span>{reg.text}</span></div>{reg.tx&&<span className={styles.sub}>Transaction {reg.tx}</span>}{reg.address&&<span className={styles.sub}>Registry {reg.address}</span>}</dd></div>
      </dl></div>
    </section>
    <section className={styles.section} aria-labelledby="v-checks"><h2 id="v-checks">Each check, yes or no</h2>
      <div className={styles.panel}><ul className={styles.list}>{view.checks.map(c=><li key={c.id}><State state={c.state}/><span>{c.label}</span></li>)}</ul></div>
    </section>
    <section className={styles.section} aria-labelledby="v-gaps"><h2 id="v-gaps">Not checked</h2>
      <p className={styles.lead}>Things this record does not establish. A green mark above does not cover any of them.</p>
      <ul className={styles.gaps}>{view.notChecked.map((n,i)=><li key={i}>{n}</li>)}</ul>
    </section>
  </>;
}

const RESULT_HEAD={true:['pass','Signature valid'],false:['fail','Does not verify']};

function ReceiptBox({providerId}){
  const [text,setText]=useState('');const [keyHex,setKeyHex]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [out,setOut]=useState(null);
  async function run(e){
    e.preventDefault();setError('');setOut(null);
    const parsed=parseReceiptInput(text);if(parsed.error){setError(parsed.error);return}
    setBusy(true);
    try{
      let keys=null;
      if(!keyHex.trim()){
        const res=await fetch(API_BASE+KEYS_PATH,{headers:{accept:'application/json'}});
        if(!res.ok)throw new Error('keys '+res.status);
        keys=await res.json();
      }
      setOut({receipt:parsed.receipt,result:await verifyReceipt(parsed.receipt,{keys,publicKeyHex:keyHex.trim()||undefined}),ownKey:!!keyHex.trim()});
    }catch{
      setError('Could not load the router’s published receipt keys. Check your connection, or enter a public key you trust below.');
    }finally{setBusy(false)}
  }
  const r=out?.result;const receipt=out?.receipt;
  const [state,head]=r?(r.checks.some(c=>(c.id==='signature'||c.id==='v2_signature')&&c.status==='not_checked')?['not_checked','Could not be checked here']:RESULT_HEAD[r.valid]):[];
  const named=receipt?.payload?.provider??r?.claims?.node?.provider;
  return <section className={`${styles.section} ${styles.receipt}`} aria-labelledby="v-receipt"><h2 id="v-receipt">Verify a receipt</h2>
    <p className={styles.lead}>Paste a receipt from a response, or from <span className="mono">GET /api/v1/receipts/&lt;id&gt;</span>. It is checked in this browser against the keys the router publishes at <span className="mono">{KEYS_PATH}</span>. A receipt with a v2 (COSE) encoding gets that checked too: signature, chain head and Merkle path. Nothing you paste is sent anywhere.</p>
    <form onSubmit={run}>
      <div className="field"><label htmlFor="receipt-json">Receipt (JSON)</label><textarea id="receipt-json" value={text} onChange={e=>setText(e.target.value)} spellCheck="false" autoComplete="off" placeholder={'{ "payload": { … }, "sig": "…", "key_id": "…" }'}/></div>
      <details className={styles.more}><summary>Check against a key I trust instead</summary><div>
        <p className={styles.help}>For a receipt a provider’s sidecar signed with its own enclave key, the router’s list will not contain the key. Enter that key (64 hex characters, the receipt_pubkey the provider’s quote commits to) to check against it.</p>
        <div className="field" style={{margin:0}}><label htmlFor="receipt-key">Ed25519 public key (hex)</label><input id="receipt-key" value={keyHex} onChange={e=>setKeyHex(e.target.value)} spellCheck="false" autoComplete="off" className="mono" maxLength={70}/></div>
      </div></details>
      <div className={styles.actions} style={{marginTop:18}}><Button type="submit" disabled={busy}>{busy?'Checking…':'Verify receipt'}</Button></div>
    </form>
    {error&&<div className="error" role="alert">{error}</div>}
    {r&&<div className={styles.result} role="status">
      <div className={styles.verdict} data-tone={r.valid?'ok':state==='not_checked'?'warn':'bad'}>
        <div className={styles.verdictHead}><h2>{head}</h2><State state={state}/></div>
        <p>{r.valid?'This receipt’s contents are exactly what the holder of that key signed. That is all it shows: not that the answer was correct, and not what the provider did with your prompt.':state==='not_checked'?'This browser could not run the signature check, so nothing was verified.':'Do not rely on this receipt.'}</p>
      </div>
      <div className={styles.panel}><ul className={styles.list}>{r.checks.map(c=><li key={c.id}><State state={c.status}/><span>{c.detail}</span></li>)}</ul></div>
      {!out.ownKey&&isEnclaveReceipt(receipt)&&<div className={styles.hint}>This receipt was signed by a provider’s enclave key, not by the router, so the router’s key list is not the place to check it. Use “Check against a key I trust instead” with the provider’s attested receipt key, or verify it with an SDK against the provider’s attestation.</div>}
      {providerId&&named&&named!==providerId&&<div className={styles.hint}>This receipt names provider <span className="mono">{String(named)}</span>, not <span className="mono">{providerId}</span>.</div>}
      <ul className={styles.gaps}>{r.notChecked.map((n,i)=><li key={i}>{n}</li>)}</ul>
    </div>}
  </section>;
}

/** The public verify page: what the router has and has not verified about one provider, and a receipt checker. */
export default function Verify(){
  const [providerId,setProviderId]=useState('');const [ready,setReady]=useState(false);const [load,setLoad]=useState('idle');const [data,setData]=useState(null);const [now,setNow]=useState(0);const [asked,setAsked]=useState(false);
  const [receiptId,setReceiptId]=useState('');const [sawAsked,setSawAsked]=useState(false);const [sawLoad,setSawLoad]=useState('idle');const [saw,setSaw]=useState(null);
  useEffect(()=>{
    const raw=new URLSearchParams(location.search);const rid=receiptIdFromSearch(location.search);
    setReceiptId(rid);setSawAsked(raw.has('r')||raw.has('receipt'));
    if(!rid)return;
    const ac=new AbortController();setSawLoad('loading');
    fetch(API_BASE+privacyPath(rid),{signal:ac.signal,headers:{accept:'application/json'}}).then(async res=>{
      if(res.status===404){setSawLoad('missing');return}
      if(!res.ok)throw new Error(String(res.status));
      const v=describePrivacy(await res.json());if(!v)throw new Error('shape');
      setSaw(v);setSawLoad('ok');
    }).catch(e=>{if(e?.name!=='AbortError')setSawLoad('error')});
    return()=>ac.abort();
  },[]);
  useEffect(()=>{
    const raw=new URLSearchParams(location.search);const id=providerIdFromSearch(location.search);
    setProviderId(id);setAsked(raw.has('p')||raw.has('provider'));setReady(true);
    if(!id)return;
    const ac=new AbortController();setLoad('loading');
    fetch(API_BASE+attestationPath(id),{signal:ac.signal,headers:{accept:'application/json'}}).then(async res=>{
      if(res.status===404){setLoad('missing');return}
      if(!res.ok)throw new Error(String(res.status));
      const j=await res.json();setData(j.data);setNow(Date.now());setLoad('ok');
    }).catch(e=>{if(e?.name!=='AbortError')setLoad('error')});
    return()=>ac.abort();
  },[]);
  const view=load==='ok'?describeAttestation(data,now):null;
  return <div className={styles.stack}>
    <Lookup providerId={providerId} note={ready&&asked&&!providerId?'That is not a valid provider id. Ids use letters, digits and . _ : -':''}/>
    {load==='loading'&&<p className={styles.lead} role="status">Reading the router’s record for <span className="mono">{providerId}</span>…</p>}
    {load==='missing'&&<div className={styles.verdict} data-tone="bad" role="status"><div className={styles.verdictHead}><h2>Unknown provider</h2><span className={styles.who}>{providerId}</span></div><p>The router has no live provider with this id. Nothing about it is verified.</p></div>}
    {load==='error'&&<div className="error" role="alert">The router could not be reached, so nothing is known about this provider from here. That is not the same as “not attested”; try again.</div>}
    {view&&<Attestation view={view}/>}
    <Saw receiptId={receiptId} asked={sawAsked} load={sawLoad} view={sawLoad==='ok'?saw:null}/>
    <ReceiptBox providerId={providerId}/>
    <section className={styles.section} aria-labelledby="v-sdk"><h2 id="v-sdk">Check the provider itself</h2>
      <p className={styles.lead}>The record above is the router’s account. The SDKs go further before they send anything: they read the provider’s own <span className="mono">/attest</span>, check that the quote commits to its TLS key and digests, that its certificate name is derived from the quote, and refuse if any of it fails. They do not repeat Intel’s signature check on the quote; the router does that, and the SDK says so in its report.</p>
      <Code label="JavaScript · @anyroute/client">{SDK}</Code>
      <div className={styles.actions}><Button href="/docs/#sdk" secondary>SDK documentation</Button></div>
    </section>
    <section className={styles.section} aria-labelledby="v-registry"><h2 id="v-registry">History and badge</h2>
      <p className={styles.lead}>The registry keeps every measurement the router verified for an attested provider, and every check it ran. Each entry has a badge any site can embed, which re-reads this record from the visitor’s browser and shows Attested only when the checks pass.</p>
      <div className={styles.actions}><Button href={providerId&&view?`/registry/${encodeURIComponent(providerId)}/`:'/registry/'}>{providerId&&view?'Open its registry entry':'Open the registry'}</Button><Button href="/docs/#badge" secondary>Badge docs</Button></div>
    </section>
  </div>;
}
