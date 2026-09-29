'use client';
import {useEffect,useRef,useState} from 'react';
import {Scramble} from './UI';

const POINTS=[['Attested private route','Private requests select only freshly attested TEE providers. The attestation hash is in the receipt.'],['Data policy per provider','Read the provider’s data policy before routing. Privacy claims should be backed by verifiable evidence.']];
const STEPS=['Request :private','Quote verified','Route selected','Receipt signed'];
const hex=n=>Array.from({length:n},()=>'0123456789abcdef'[(Math.random()*16)|0]).join('');
const FIRST={quote:'sha256:9c41e0b2…a1f307e2',nonce:'0x5e2a…c91d'};
const DONE=STEPS.length+1;

/** Private route walkthrough: the attestation card steps through its checks while visible, and shows the end state under reduced motion. */
export default function Privacy(){
  const ref=useRef(null);const [step,setStep]=useState(DONE);const [ev,setEv]=useState(FIRST);
  useEffect(()=>{
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    setStep(0);let timers=[],cycle=0,visible=false;
    const clear=()=>{timers.forEach(clearTimeout);timers=[]};
    const run=()=>{clear();setStep(0);if(cycle++)setEv({quote:`sha256:${hex(8)}…${hex(8)}`,nonce:`0x${hex(4)}…${hex(4)}`});[600,1500,2400,3300,4100].forEach((t,i)=>timers.push(setTimeout(()=>setStep(i+1),t)));timers.push(setTimeout(run,8000))};
    const io=new IntersectionObserver(([e])=>{if(e.isIntersecting&&!visible){visible=true;run()}else if(!e.isIntersecting&&visible){visible=false;clear()}},{threshold:.35});
    io.observe(ref.current);return()=>{io.disconnect();clear()};
  },[]);
  const rows=[
    ['request','llama-3.3-70b:private',1],
    ['tee','intel tdx + nvidia cc',2],
    ['nonce',`${ev.nonce} · bound`,2],
    ['quote',<Scramble text={ev.quote}/>,2],
    ['freshness','attested 4 min ago',2],
    ['data policy',<>training{'\u00a0'}<b>no</b> · retains{'\u00a0'}prompts{'\u00a0'}<b>no</b> · zdr{'\u00a0'}<b>yes</b></>,3],
    ['receipt',<>attestation <Scramble text={ev.quote}/></>,4],
  ];
  const done=step>=DONE;
  return <section className="section muted-surface" id="privacy"><div className="container split">
    <div className="split-copy">
      <div data-reveal><span className="eyebrow tick">Privacy / attested routes</span><h2 className="h2">Privacy with a receipt.</h2><p className="lede">A private request goes only to a provider whose TEE evidence was verified minutes ago. If the evidence is missing or stale, the request fails closed.</p></div>
      <div className="points" data-stagger>{POINTS.map(([t,b])=><div className="point" key={t} data-reveal><i aria-hidden="true"/><h3>{t}</h3><p>{b}</p></div>)}</div>
      <p data-reveal style={{marginTop:24}}><a className="inline-link" href="/verify/">Check what the router has verified about any provider</a></p>
    </div>
    <div data-reveal><div ref={ref} className={'attest'+(done?' done':'')} role="figure" aria-label="Example private route: attestation checks from request to signed receipt">
      <div className="panel-bar"><span>Private route · example</span><span>fail-closed</span></div>
      <div className="attest-steps" role="list">{STEPS.map((s,i)=><div key={s} role="listitem" className={step>i?'on':''}>{s}</div>)}</div>
      <div className="attest-body shielded">
        <svg className="shield" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M24 5.5l15 6v11.5c0 9.3-6.4 16.3-15 19.5C15.4 39.3 9 32.3 9 23V11.5z"/><path className="check" d="M17.5 24l4.5 4.5 9-10" pathLength="1"/></svg>
        <dl>{rows.map(([k,v,at])=>{const wait=step<at;return <div key={k} className={'attest-row'+(wait?' wait':'')}><dt>{k}</dt><dd>{wait?'pending':v}</dd></div>})}</dl>
      </div>
      <div className={'verdict'+(done?' ok':'')}><i aria-hidden="true">✓</i><span>{done?'Attestation verified · route allowed':'Verifying attestation…'}</span></div>
    </div></div>
  </div></section>;
}
