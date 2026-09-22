const POINTS=[['Provider bonds','Providers bond in USDG. Reliability has a cost, and failures leave evidence.'],['Quality canaries','Canary checks compare declared quantization and quality, with a dispute process before penalties.']];

const LOG=[
  ['14:00:02','ok','pass','quant fingerprint · llama-3.3-70b','fp8 = fp8'],
  ['14:00:05','ok','pass','exact-match canary set','12 / 12'],
  ['14:00:09','ok','pass','empty-200 rate · 24h','0.04%'],
  ['14:00:14','warn','warn','latency p50 drift · 1h','+22%'],
  ['14:00:31','ok','pass','receipt root anchored','0x7c1e…a90b'],
  ['14:01:07','bad','fail','quant fingerprint · qwen3-32b','bf16 ≠ int4'],
  ['14:01:07','bad','fail','3 of 3 canaries mismatched','evidence 0x4be0…'],
  ['14:01:08','warn','open','slash proposal · 25% of bond','dispute 72h'],
];

const STAGES=[['Evidence','done'],['Proposal','done'],['72h dispute','now'],['Slash or refund','']];

/** Bonds and canaries: an illustrative evidence log, the bond at stake and the slash timeline. */
export default function Accountability(){return <section className="section dark" id="accountability"><div className="container split">
  <div className="split-copy">
    <div data-reveal><span className="eyebrow tick">Accountability / bonds and canaries</span><h2 className="h2">Keep your routing honest.</h2><p className="lede">Providers put money behind their claims. Canaries check every model they serve, and each result is kept as evidence before anyone is penalized.</p></div>
    <div className="points" data-stagger>{POINTS.map(([t,b])=><div className="point" key={t} data-reveal><i aria-hidden="true"/><h3>{t}</h3><p>{b}</p></div>)}</div>
  </div>
  <div className="console" data-inview role="figure" aria-label="Sample evidence log with illustrative data">
    <div className="console-head"><span><b>Evidence log</b> · sample</span><span>prov_7f2c<span className="console-extra"> · hourly checks</span></span></div>
    <div className="console-body">{LOG.map(([t,tone,tag,msg,detail],i)=><div className="log" key={i} style={{'--i':i}}><time>{t}</time><span><em className={tone}>{tag}</em>{msg}</span><b>{detail}</b></div>)}</div>
    <div className="bond">
      <div className="bond-row"><span>Provider bond</span><b><span data-count="10000">10,000</span> USDG</b></div>
      <div className="bond-row"><span>At stake in dispute</span><b className="warn">2,500 USDG</b></div>
      <div className="meter" style={{'--v':.75}} aria-hidden="true"><i/></div>
      <div className="timeline" role="list" aria-label="Slash process">{STAGES.map(([s,state],i)=><div role="listitem" key={s} className={state} aria-current={state==='now'?'step':undefined}>0{i+1}<b>{s}</b></div>)}</div>
    </div>
  </div>
</div></section>}
