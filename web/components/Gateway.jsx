'use client';
import {useState} from 'react';
import {highlight} from './UI';

const POINTS=[['Bring your own workflow','Keep your SDK, choose providers and configure fallbacks. Cache and guardrails are opt-in.'],['Budget, rules and a kill switch','Set request/hour/day/week caps, models, lanes, tools and working hours. The kill switch stops the next request; the owner resumes.'],['Ask first, then inspect','Approve once on /agents within 15 minutes. Read signed receipts in the per-agent ledger and export CSV or JSON.'],['Alerts, breakers and autonomy','Follow the /agents alert feed, spend-alert webhook or Telegram via AnyRoute’s bot. Circuit breakers and progressive autonomy support spending caps up to 10x.']];

const TOGGLES=[
  ['fallbacks','Fallbacks','routing.provider',true],
  ['budget','Budget cap','limit · reset',true],
  ['rate','Rate limits','rpm · tpm',true],
  ['models','Model allowlist','allowed_models',true],
  ['guardrails','Guardrails','opt-in · pii',false],
  ['team','Team scope','roles · budgets',false],
  ['paywith','Pay with NVDA','stock token default',false],
  ['expiry','Expiry','expires_at',false],
];

const lines=s=>[
  ['{'],
  ['  "name": "support-agent",'],
  [`  "limit": ${s.budget?'250':'null'},`,'budget'],
  [`  "limit_reset": ${s.budget?'"monthly"':'null'},`,'budget'],
  [`  "rpm": ${s.rate?'600':'null'},`,'rate'],
  [`  "tpm": ${s.rate?'400000':'null'},`,'rate'],
  [`  "allowed_models": ${s.models?'["qwen/qwen3-32b", "deepseek/deepseek-r1"]':'null'},`,'models'],
  [`  "team": ${s.team?'"research"':'null'},`,'team'],
  [`  "pay_with_default": ${s.paywith?'"NVDA"':'null'},`,'paywith'],
  [`  "expires_at": ${s.expiry?'"2026-12-31T00:00:00Z"':'null'},`,'expiry'],
  [`  "guardrails": ${s.guardrails?'{ "pii": "redact" }':'null'},`,'guardrails'],
  ['  "routing": {'],
  ['    "provider": {'],
  ['      "sort": "latency",'],
  [`      "allow_fallbacks": ${s.fallbacks}`,'fallbacks'],
  ['    }'],
  ['  }'],
  ['}'],
];

/** Gateway controls on one virtual key: toggles on the left, the key's JSON settings updating live below. */
export default function Gateway(){
  const [on,setOn]=useState(()=>Object.fromEntries(TOGGLES.map(([k,,,v])=>[k,v])));
  const [flash,setFlash]=useState({k:'',n:0});const [msg,setMsg]=useState('');
  const flip=(k,label)=>{const next=!on[k];setOn({...on,[k]:next});setFlash(f=>({k,n:f.n+1}));setMsg(`${label} ${next?'on':'off'}. Key settings updated.`)};
  const count=TOGGLES.filter(([k])=>on[k]).length;
  return <section className="section" id="gateway"><div className="container split reverse">
    <div className="split-copy">
      <div data-reveal><span className="eyebrow tick">Gateway / controls per key</span><h2 className="h2">Batteries included. All removable.</h2><p className="lede">Set boundaries on the key and attach an agent rulebook. AnyRoute’s router enforces it for requests through AnyRoute only.</p></div>
      <div className="points" data-stagger>{POINTS.map(([t,b])=><div className="point" key={t} data-reveal><i aria-hidden="true"/><h3>{t}</h3><p>{b}</p></div>)}</div>
      <p data-reveal style={{marginTop:24}}><a className="inline-link" href="/agents/">Open the agent rulebook</a> · <a className="inline-link" href="/docs/#agent-rulebook">Read the API and MCP tools</a></p>
    </div>
    <div className="panel gateway-panel" data-reveal>
      <div className="panel-bar"><span>POST /api/v1/keys · example</span><span><b>{count}</b> / {TOGGLES.length} on</span></div>
      <div className="toggles" role="group" aria-label="Gateway features for this key">{TOGGLES.map(([k,label,note])=><button type="button" key={k} className="toggle" aria-pressed={on[k]} onClick={()=>flip(k,label)}><span>{label}<small>{note}</small></span><span className="switch" aria-hidden="true"/></button>)}</div>
      <pre className="config" tabIndex={0} role="region" aria-label="Key settings preview, JSON"><code>{lines(on).map(([text,k],i)=>{const hot=k&&k===flash.k;return <span key={hot?`${i}-${flash.n}`:i} className={'ln'+(hot?' flash':'')}>{highlight(text)}</span>})}</code></pre>
      <p className="sr-only" aria-live="polite">{msg}</p>
    </div>
  </div></section>;
}
