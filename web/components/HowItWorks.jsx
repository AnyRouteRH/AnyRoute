'use client';
import {useEffect,useRef,useState} from 'react';

const STEPS=[['Choose your model.','Use the familiar API request shape. Set your model, provider preferences and budget.','model · provider{} · budget'],['Let Anyroute find the route.','The router filters providers by health, price, data policy and your requirements, with fallbacks ready.','1/price² × uptime × quality'],['Receive a receipt.','Every generation returns itemized usage, cost and a signed receipt, anchored on-chain within the hour.','ed25519 · merkle · 4663']];

/** Three steps on a rail that fills as the section scrolls past. */
export default function HowItWorks(){
  const ref=useRef(null);const [p,setP]=useState(0);
  useEffect(()=>{const el=ref.current;const on=e=>setP(e.detail);el.addEventListener('progress',on);return()=>el.removeEventListener('progress',on)},[]);
  return <section className="section how" id="how-it-works" ref={ref} data-progress><div className="container">
    <div className="section-head" data-reveal><div><span className="eyebrow">How it works</span><h2>Three steps.<br/>No new SDK.</h2></div><p className="lede">Point your client at the router, keep your code, and every call comes back with the route it took and the proof of what it cost.</p></div>
    <div className="how-track"><div className="how-rail" aria-hidden="true"><i/></div>{STEPS.map(([title,body,chip],i)=><div className="how-step" key={title} data-reveal style={{'--i':i}}><span className={'how-dot'+(p>i/3+.05?' on':'')} aria-hidden="true"/><span className="n">STEP 0{i+1}</span><h3>{title}</h3><p>{body}</p><span className="chip">{chip}</span></div>)}</div>
  </div></section>;
}
