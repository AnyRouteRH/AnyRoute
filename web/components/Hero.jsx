'use client';
import {useState} from 'react';
import ContractAddress from './ContractAddress';
import RouteField from './RouteField';
import {Button,Scramble} from './UI';

const hex=n=>Array.from({length:n},()=>'0123456789abcdef'[(Math.random()*16)|0]).join('');
const first={id:1041,model:'llama-3.3-70b',provider:'North Compute',private:false,latency:312,tokens:184,cost:'0.000032',sig:'9f1c…e07a'};

function LiveCard({route}){return <aside className="route-card-live" aria-label="Simulated route preview">
  <div className="rcl-head"><span className="rcl-dot">Route #{route.id}</span><b>Simulated</b></div>
  <dl>
    <div><dt>model</dt><dd><Scramble text={route.model}/></dd></div>
    <div><dt>provider</dt><dd><Scramble text={route.provider}/></dd></div>
    <div><dt>route</dt><dd className={route.private?'ok':''}>{route.private?'private · attested':'standard'}</dd></div>
    <div><dt>latency</dt><dd><Scramble text={`${route.latency} ms`}/></dd></div>
    <div><dt>tokens</dt><dd><Scramble text={String(route.tokens)}/></dd></div>
    <div><dt>cost</dt><dd><Scramble text={`${route.cost} USDG`}/></dd></div>
    <div><dt>receipt</dt><dd className="ok"><Scramble text={`ed25519 ${route.sig}`}/></dd></div>
  </dl>
  <div className="rcl-bar"><i key={route.id} style={{'--dur':'3.1s'}}/></div>
</aside>}

const words=[['Any','model.'],['One','key.'],['Paid','per','call.']];

export default function Hero(){
  const [route,setRoute]=useState(first);
  const onRoute=r=>setRoute({id:r.id,model:r.model,provider:r.provider,private:r.private,latency:r.latency,tokens:r.tokens,cost:(r.tokens*(r.private?.00000024:.00000018)).toFixed(6),sig:`${hex(4)}…${hex(4)}`});
  let i=0;
  return <section className="hero" id="home" data-dark-hero>
    <div className="hero-grid" aria-hidden="true"/><div className="hero-glow" aria-hidden="true"/>
    <RouteField onRoute={onRoute}/>
    <div className="container hero-inner">
      <div className="hero-copy">
        <div className="hero-kicker"><b>▲</b> OpenRouter-compatible · Robinhood Chain</div>
        <h1 className="hero-title"><span className="brackets" aria-hidden="true"/>{words.map((line,l)=><span className="line" key={l}>{line.map((w,k)=><span key={k}><span className={'w'+(l===2?' accent':'')} style={{'--i':i++}}>{w}</span>{k<line.length-1?' ':''}</span>)}</span>)}</h1>
        <div className="hero-sub"><p>Route AI calls through <strong>one API, one USDG balance</strong> and a signed receipt for every generation. Choose your model. Keep control of the route.</p><p>Built on Robinhood Chain. Deposit USDG and start routing.</p></div>
        <div className="button-row"><Button href="/dashboard/">Open dashboard</Button><Button href="/docs/" secondary>Read the docs</Button></div>
        <a className="hero-harness" href="/harness/">Or try every model and its tools on one page<b aria-hidden="true">→</b></a>
        <a className="hero-harness" href="/seal/">Read SEAL, the privacy protocol, and its public spec<b aria-hidden="true">→</b></a>
        <ContractAddress/>
      </div>
      <LiveCard route={route}/>
    </div>
    <div className="hero-status"><div className="container"><span><i/>Robinhood Chain · 4663</span><span>Settlement · USDG</span><span>Receipts · Ed25519, anchored hourly</span><span>Prepaid router fee · 0%</span></div></div>
  </section>;
}
