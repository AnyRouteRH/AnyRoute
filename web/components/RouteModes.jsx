'use client';
import {useEffect,useRef,useState} from 'react';
import {Button,CopyButton,highlight} from './UI';

const MODES=[
  {tag:'Routing',title:'Standard inference',attrs:['Model preferences','Price or latency sort','USDG'],label:'chat/completions',
    code:`const res = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct",
  messages,
  provider: { sort: "price", allow_fallbacks: true },
});

res.provider;        // who served it
res.usage.cost;      // what it cost, in USDG
res.receipt.sig;     // Ed25519, anchored hourly`,
    flow:[['Filter','health, price, data policy'],['Route','best provider, fallbacks ready'],['Receipt','signed, itemized, anchored']]},
  {tag:'Privacy',title:'Attested private route',attrs:['TEE evidence','Fail-closed','Receipt'],label:'private route',
    code:`const res = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct:private",
  messages,
});

// Only freshly attested TEE providers qualify.
res.receipt.payload.attestation;  // quote hash
res.provider;                      // the attested host`,
    flow:[['Attest','TDX quote + GPU evidence'],['Select','fresh attestations only'],['Prove','hash in the receipt']]},
  {tag:'Payments',title:'Stock Token payments',attrs:['Daily cap','Oracle fair value','Exact units'],label:'pay with NVDA',
    code:`const res = await fetch(\`\${BASE}/chat/completions\`, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${KEY}\`,
    "X-Pay-With": "NVDA",        // capped session
  },
  body: JSON.stringify({ model, messages }),
});
// receipt.paid_with -> { token, raw_units, fair_price }`,
    flow:[['Accrue','small calls add up'],['Swap','bounded, at fair value'],['Allocate','units per generation']]},
  {tag:'Encryption',title:'End-to-end encrypted chat',attrs:['On-device encryption','Attested gateway','Ciphertext relay'],label:'encrypted chat path',
    code:`// The client encrypts on your device.
// Anyroute's router forwards ciphertext to the attested gateway.
// The gateway handles inference and encrypts the response.
// Follow /docs/#e2ee-phala for the client flow.

// Other request paths are read in memory by the router.
// Attestation alone does not hide prompts from the router.`,
    flow:[['Encrypt','client on your device'],['Forward','ciphertext through the router'],['Infer','attested gateway']]},
];

/** Four kinds of route behind one API. Tabs auto-advance; the panel types out each request. */
export default function RouteModes(){
  const [active,setActive]=useState(0);const [typed,setTyped]=useState(MODES[0].code.length);const [paused,setPaused]=useState(false);const [visible,setVisible]=useState(false);const root=useRef(null);const reduced=useRef(false);
  useEffect(()=>{reduced.current=matchMedia('(prefers-reduced-motion: reduce)').matches;const io=new IntersectionObserver(([e])=>setVisible(e.isIntersecting),{threshold:.25});io.observe(root.current);return()=>io.disconnect()},[]);
  useEffect(()=>{const code=MODES[active].code;if(reduced.current||!visible){setTyped(code.length);return}setTyped(0);let n=0,raf;const step=()=>{n=Math.min(code.length,n+3);setTyped(n);if(n<code.length)raf=requestAnimationFrame(step)};raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf)},[active,visible]);
  useEffect(()=>{if(paused||!visible||reduced.current)return;const t=setTimeout(()=>setActive(a=>(a+1)%MODES.length),6500);return()=>clearTimeout(t)},[active,paused,visible]);
  const mode=MODES[active];const done=typed>=mode.code.length;
  const onKey=e=>{if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();const next=(active+(e.key==='ArrowDown'?1:MODES.length-1))%MODES.length;setActive(next);root.current.querySelectorAll('[role=tab]')[next].focus()};
  return <section className="section muted-surface" id="routes" ref={root}><div className="container">
    <div className="section-head" data-reveal><div><span className="eyebrow">Route types</span><h2>One API.<br/>Every kind of route.</h2></div><p className="lede">The same request shape reaches a standard model, an attested host or a Stock Token payment. Encrypted chat uses on-device encryption through the attested gateway; ordinary requests are read in memory by the router.</p></div>
    <div className="modes" data-paused={paused} onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onFocus={()=>setPaused(true)} onBlur={()=>setPaused(false)} data-reveal>
      <div className="mode-tabs" role="tablist" aria-label="Route types" aria-orientation="vertical" onKeyDown={onKey}>{MODES.map((m,i)=><button key={m.title} className="mode-tab" role="tab" id={`mode-tab-${i}`} aria-controls="mode-panel" aria-selected={i===active} tabIndex={i===active?0:-1} onClick={()=>setActive(i)}><span className="num">0{i+1}</span><h3>{m.title}</h3><span className="tag">{m.tag}</span><span className="attrs">{m.attrs.map(a=><span key={a}>{a}</span>)}</span>{i===active&&<span className="progress" key={active} aria-hidden="true"/>}</button>)}
        <div style={{paddingTop:28}}><Button href="/models/" secondary>Explore models</Button><p><a className="inline-link" href="/docs/#e2ee-phala">Encrypted chat documentation</a></p></div></div>
      <div className="mode-panel" role="tabpanel" id="mode-panel" aria-labelledby={`mode-tab-${active}`}>
        <div className="code-bar"><span>{mode.label}</span><CopyButton text={mode.code}/></div>
        <pre><code>{highlight(mode.code.slice(0,typed))}{!done&&<span className="caret" aria-hidden="true"/>}</code></pre>
        <div className="mode-flow" key={active}>{mode.flow.map(([b,t],i)=><div key={b} style={{'--i':i}}><b>{b}</b>{t}</div>)}</div>
      </div>
    </div>
  </div></section>;
}
