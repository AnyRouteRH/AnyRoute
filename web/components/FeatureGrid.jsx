import {Mark} from './Logo';

const P=d=><path d={d} pathLength="1"/>;
const ICONS={
  api:<>{P('M16 12L8 24L16 36')}{P('M32 12L40 24L32 36')}{P('M27 10L21 38')}</>,
  usdg:<><circle cx="24" cy="24" r="16" pathLength="1"/>{P('M29.5 17.5H22a3.5 3.5 0 0 0 0 7h4a3.5 3.5 0 0 1 0 7h-7.5M24 13.5v4M24 31.5v4')}</>,
  receipt:<>{P('M11 6h26v36l-4.3-3-4.4 3-4.3-3-4.3 3-4.4-3-4.3 3z')}{P('M17 15h14M17 21h14M17 27h8')}<rect className="fill" x="27" y="26" width="5" height="5"/></>,
  pay:<><rect x="6" y="11" width="36" height="26" pathLength="1"/>{P('M6 19h36M12 30h8M24 30h4')}<rect className="fill" x="33" y="27" width="5" height="5"/></>,
  keys:<><circle cx="15" cy="24" r="7.5" pathLength="1"/>{P('M22.5 24H42M36 24v7M30.5 24v5')}</>,
  shield:<>{P('M24 5.5l15 6v11.5c0 9.3-6.4 16.3-15 19.5C15.4 39.3 9 32.3 9 23V11.5z')}{P('M17.5 24l4.5 4.5 9-10')}</>,
  bond:<><rect x="7" y="15" width="34" height="24" pathLength="1"/>{P('M16 15V9h16v6M7 25h34')}<rect className="fill" x="21" y="22" width="6" height="6"/></>,
  stock:<>{P('M6 39h36')}{P('M9 32l8.5-9.5 7 5.5L38 12.5')}{P('M30.5 12.5H38V20')}</>,
  fallback:<>{P('M5 24h14')}{P('M19 24c7 0 8-12 17-12h7M19 24c7 0 8 12 17 12h7')}{P('M39 8l4 4-4 4M39 32l4 4-4 4')}</>,
  otel:<>{P('M5 29h8l4.5-12 6 21 5-16 3.5 7H43')}</>,
  royalty:<><circle cx="24" cy="24" r="16" pathLength="1"/>{P('M24 8v32M24 24l11.5 11')}</>,
  team:<><circle cx="16.5" cy="17" r="6" pathLength="1"/><circle cx="33" cy="19" r="5" pathLength="1"/>{P('M5 39c1-7.5 5-11.5 11.5-11.5S27 31.5 28 39M28.5 39c.6-5 3.2-8.3 7.5-8.3s6.9 3.3 7.5 8.3')}</>,
};

const FEATURES=[
  {k:'intro',wide:true,inverse:true,label:'Anyroute',title:'The open routing layer',body:<>Any model, any provider, any route. One familiar API for your next generation of agents. <mark>Know where every call goes and what it costs</mark>, down to the receipt.</>},
  {k:'api',label:'Open API',title:'Familiar request shapes',body:<>Keep the clients and request shapes your team already knows. Change the base URL and key, with <mark>OpenRouter-compatible routing preferences</mark> built in.</>},
  {k:'usdg',label:'USDG credits',title:'Prepaid, with a 0% router fee',body:<>One balance for every model and provider. <mark>Pay in USDG</mark> and withdraw what you don’t use, self-custodially.</>},
  {k:'receipt',wide:true,label:'Signed receipts',title:'Portable proof per call',body:<>See the model, provider, tokens and cost behind each generation. <mark>A signed receipt travels with the response</mark>, anchored on Robinhood Chain every hour for independent verification.</>},
  {k:'pay',label:'Agent payments',title:'HTTP 402, built for agents',body:<>A request can begin without an account. <mark>Receive a 402 quote, pay, then retry</mark> with a payment proof.</>},
  {k:'keys',label:'Agent rulebook',title:'Rules before every request',body:<>Cap spending per request, hour, day and week. Choose models, lanes, tools and working hours. <mark>Ask first or stop the next request with a kill switch.</mark> <a className="inline-link" href="/agents/">Manage your agents</a>.</>},
  {k:'shield',label:'Encrypted chat',title:'Encrypt on your device',body:<>End-to-end encrypted chat runs through the attested gateway. <mark>The router forwards ciphertext on this path.</mark> Other requests are read in memory to route them. <a className="inline-link" href="/docs/#e2ee-phala">Read how it works</a>.</>},
  {k:'bond',label:'AnyRoute Network',title:'Open for early hosts',body:<>Run the approved build in a supported Intel TDX confidential VM. <mark>Fresh attestation and host policy govern admission.</mark> <a className="inline-link" href="/network/">Join the network</a> or inspect <a className="inline-link" href="/hosts/">public host records</a>.</>},
  {k:'stock',wide:true,inverse:true,label:'Stock Tokens',title:'A different way to pay',body:<>Choose a registered Stock Token and set a daily cap. Small calls accrue before a bounded swap at oracle fair value. <mark>The receipt records the exact token units</mark> allocated to each generation.</>},
  {k:'fallback',label:'Fallback routing',title:'Keep the request moving',body:<>Filter by price, latency, quantization and data policy. <mark>Unhealthy providers leave the pool</mark>, with fallbacks built in.</>},
  {k:'otel',label:'Open telemetry',title:'Your usage, your tools',body:<>Keep usage visible across your existing systems with <mark>OpenTelemetry export and usage records</mark>.</>},
  {k:'royalty',label:'Agent track record',title:'Receipts you can inspect',body:<>Per-agent ledgers export signed receipts as CSV or JSON. <mark>Router-signed certificates use a fresh pseudonym and last seven days.</mark> They are verifiable, not anonymous.</>},
  {k:'team',label:'Team controls',title:'Built for shared work',body:<>Roles, budgets and access for the people building with you: <mark>one routing layer for a shared workspace</mark>.</>},
];

export default function FeatureGrid(){return <section className="section" id="features"><div className="container">
  <div className="section-head" data-reveal><div><span className="eyebrow">Features / what a route tells you</span><h2>Everything a call should come with.</h2></div><p className="lede">Routing, payments, proof and privacy in one layer. Keep your SDK; get a receipt, a budget and a choice of how to pay.</p></div>
  <div className="feature-grid" data-stagger>{FEATURES.map((f,i)=><article key={f.k} className={'feature'+(f.wide?' wide':'')+(f.inverse?' inverse':'')} data-reveal data-spot>
    <div className="feature-top">{f.k==='intro'?<Mark signal className="feature-mark"/>:<svg className="feature-icon" viewBox="0 0 48 48" aria-hidden="true">{ICONS[f.k]}</svg>}<span className="feature-index">{String(i+1).padStart(2,'0')}</span></div>
    <span className="eyebrow">{f.label}</span><h3>{f.title}</h3><p>{f.body}</p>
  </article>)}</div>
</div></section>}
