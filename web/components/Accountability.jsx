const POINTS=[['Approved builds','Early hosts run the approved Intel TDX build in a supported confidential VM. Join with one command using join.mjs.'],['Automatic admission','Fresh quote, signed host policy v1 in the key log, and sanctions screening of operator and payout addresses. New hosts start on probation with a public record.']];

const LOG=[
  ['01','ok','build','approved recipe','Intel TDX'],
  ['02','ok','quote','fresh hardware evidence','attestation'],
  ['03','ok','policy','signed host policy v1','key log'],
  ['04','ok','screen','operator + payout addresses','admission'],
  ['05','warn','join','new host probation','public record'],
];
const STAGES=[['Quote','done'],['Policy','done'],['Screening','done'],['Probation','now']];

/** Network admission steps; hosts post no deposit. */
export default function Accountability(){return <section className="section dark" id="accountability"><div className="container split">
  <div className="split-copy">
    <div data-reveal><span className="eyebrow tick">Accountability / Anyroute Network</span><h2 className="h2">A public record for every host.</h2><p className="lede">The Anyroute Network is open for early hosts running the approved build. Admission checks the hardware and policy before a host serves requests.</p></div>
    <div className="points" data-stagger>{POINTS.map(([t,b])=><div className="point" key={t} data-reveal><i aria-hidden="true"/><h3>{t}</h3><p>{b}</p></div>)}</div>
    <p data-reveal style={{marginTop:24}}><a className="inline-link" href="/network/">Check the approved build and join</a> · <a className="inline-link" href="/hosts/">Inspect host records</a></p>
  </div>
  <div className="console" data-inview role="figure" aria-label="Network host admission steps">
    <div className="console-head"><span><b>Host admission</b> · process</span><span>Intel TDX<span className="console-extra"> · approved build</span></span></div>
    <div className="console-body">{LOG.map(([t,tone,tag,msg,detail],i)=><div className="log" key={i} style={{'--i':i}}><span>{t}</span><span><em className={tone}>{tag}</em>{msg}</span><b>{detail}</b></div>)}</div>
    <div className="bond">
      <div className="bond-row"><span>Deposit required</span><b>None</b></div>
      <div className="bond-row"><span>Payouts</span><b className="warn">Not switched on yet</b></div>
      <div className="meter" style={{'--v':.75}} aria-hidden="true"><i/></div>
      <div className="timeline" role="list" aria-label="Admission process">{STAGES.map(([s,state],i)=><div role="listitem" key={s} className={state} aria-current={state==='now'?'step':undefined}>0{i+1}<b>{s}</b></div>)}</div>
    </div>
  </div>
</div></section>}
