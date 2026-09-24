const STATS=[
  {value:'0',unit:'%',label:'Router fee on prepaid calls. One USDG balance for every model.',eyebrow:'Prepaid'},
  {value:'1',unit:'%',prefix:'≤',label:'Maximum margin when an agent pays per call with HTTP 402.',eyebrow:'Per call'},
  {value:'10',suffix:'k',unit:'USDG',label:'Bond every provider posts before it serves live traffic.',eyebrow:'Provider bond'},
  {value:'72',unit:'h',label:'Dispute window before any slash, with refunds on the evidence.',eyebrow:'Accountability'},
];
export default function Stats(){return <section className="section tight" aria-label="Anyroute in numbers"><div className="container"><div className="stats" data-stagger>{STATS.map(s=><div className="stat" key={s.eyebrow} data-reveal><strong>{s.prefix}<span data-count={s.value}>{s.value}</span>{s.suffix}<sup>{s.unit}</sup></strong><p>{s.label}</p><div className="eyebrow">{s.eyebrow}</div></div>)}</div></div></section>}
