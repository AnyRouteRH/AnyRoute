const STATS=[
  {value:'4',unit:'',label:'Budget caps per request, hour, day and week.',eyebrow:'Agent rulebook'},
  {value:'15',unit:'min',label:'Single-use ask-first approval window on /agents.',eyebrow:'Owner approval'},
  {value:'5',suffix:'k',unit:'USDG',label:'Minimum USDG bond for bonded network hosts. Slashing is not switched on yet.',eyebrow:'HostBond'},
  {value:'7',unit:'days',label:'Validity of a router-signed track-record certificate with a fresh pseudonym.',eyebrow:'Certificates'},
];
export default function Stats(){return <section className="section tight" aria-label="Anyroute in numbers"><div className="container"><div className="stats" data-stagger>{STATS.map(s=><div className="stat" key={s.eyebrow} data-reveal><strong>{s.prefix}<span data-count={s.value}>{s.value}</span>{s.suffix}<sup>{s.unit}</sup></strong><p>{s.label}</p><div className="eyebrow">{s.eyebrow}</div></div>)}</div></div></section>}
