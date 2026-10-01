import {Button,Code} from './UI';
import {Mark} from './Logo';

export const sampleRequest=`// Change two lines: the base URL and the key.
const client = new OpenAI({
  baseURL: process.env.ANYROUTE_BASE_URL, // "<your router>/api/v1"
  apiKey: process.env.ANYROUTE_API_KEY,   // "sk-ar-v1-…"
});

const generation = await client.chat.completions.create({
  model: "meta-llama/llama-3.3-70b-instruct",
  messages: [{ role: "user", content: "Hello, Anyroute." }],
});`;

const RECEIPT=[['model','llama-3.3-70b'],['provider','attested host'],['tokens','120 in · 64 out'],['settlement','USDG'],['paid_with','NVDA',true],['daily_cap','user-defined'],['anchor','chain 4663']];

/** A Stock Token call, with the receipt printing out of its slot. */
export function CaseStudy(){return <section className="extension" id="case-study"><div className="container">
  <div className="section-head" data-reveal><div><span className="eyebrow">Case study / pay with a Stock Token</span><h2>From one call<br/>to a clear receipt.</h2></div><p className="lede">An example agent workflow: how a Stock Token pays for inference behind a familiar API, without changing the model request.</p></div>
  <div className="case-panel" data-reveal="scale"><div className="case-copy"><span className="eyebrow">The workflow</span><h3>Your model stays the same.<br/>Your payment gets a new route.</h3><p>A research agent chooses a model, sets a daily cap and requests NVDA as its payment token. Anyroute prices the call in USDG, swaps at oracle fair value and records the token allocation.</p><Button href="/case-study/" light>Read the case study</Button></div>
    <div className="receipt-art" data-inview><div className="eyebrow"><span className="live-square"/> Illustrative receipt</div><div className="slot" aria-hidden="true"/><div className="paper"><div className="paper-head"><span>Anyroute</span><span>gen-1790461071</span></div><dl>{RECEIPT.map(([k,v,g])=><div key={k}><dt>{k}</dt><dd className={g?'green-text':''} style={g?{color:'var(--signal-deep)',fontWeight:600}:undefined}>{v}</dd></div>)}<div className="total"><dt>cost</dt><dd>0.00003248 USDG</dd></div></dl><div className="sig">sig ed25519 · 3q9Zk…WkXg== · key ab214b09</div><div className="barcode" aria-hidden="true"/></div></div></div>
</div></section>}

export const roadmap=[['01','Encrypted chat and SEAL','On-device encryption through the attested gateway, signed receipts, key transparency and per-host receipt anchoring.'],['02','The agent rulebook','Budgets, rules, approvals on /agents and Telegram, receipts, alerts, circuit breakers, progressive autonomy, certificates and opt-in profiles.'],['03','AnyRoute Network','Open for early hosts on the approved Intel TDX build, automatic admission, probation, public host records and live network statistics.'],['04','Files and payments','Private RAG/files, PDF support, the Harness, x402 chat and embeddings, Tor onion access and blind tokens.']];
/** Current features and the next areas of work. */
export function Roadmap(){return <section className="extension muted-surface roadmap" id="roadmap" data-progress><div className="container">
  <div className="section-head" data-reveal><div><span className="eyebrow">Roadmap / live and next</span><h2>A clear route forward.</h2></div><p className="lede">Encrypted chat, the agent rulebook and early-host admission are live at anyroute.tech. Sealed agent hosting is available, but no sealed agent is registered at anyroute.tech yet. Network host payouts and bond slashing are not switched on yet.</p></div>
  <div className="rail" aria-hidden="true"><i/></div>
  <div className="roadmap-grid" data-stagger>{roadmap.map(([n,title,body])=><article className="route-card" key={n} data-reveal><div className="eyebrow">{n}<span className="live-square"/>Live</div><h3>{title}</h3><p>{body}</p><div className="card-ramp"/></article>)}</div>
  <p data-reveal>Agreements between agents are live: escrow and dispute contracts on Robinhood Chain, with disputes ruled by a jury of models on attested hardware.</p>
  <div className="next-stage" data-reveal><span>Agent wallets with on-chain rules; GPU hosts on the network; network payouts.</span><b>Next</b></div>
</div></section>}

/** Why Anyroute exists, beside the mark with a signal climbing its center channel. */
export function About(){return <section className="extension" id="about"><div className="container about">
  <div className="about-mark" data-reveal="fade"><Mark signal title="Anyroute mark"/></div>
  <div className="about-copy" data-reveal><span className="eyebrow">About Anyroute</span><h2 className="h2">Any model. Any provider.<br/>An accountable route.</h2><p>Anyroute is an open inference router for Robinhood Chain. A familiar API is the starting point. Clear payments, provider accountability and portable receipts are the reason to go further.</p><blockquote>A route should tell you more than whether a request succeeded.</blockquote><p>Which provider served it? What did it cost? What evidence supports its privacy claims? Who gets paid? Routing, USDG settlement, signed receipts and attestation checks run in the router, with contracts on Robinhood Chain.</p><div className="button-row" style={{marginTop:32}}><Button href="/docs/">Read the documentation</Button></div></div>
</div></section>}

/** The two-line migration for developers. */
export function Developers(){return <section className="extension muted-surface" id="developers"><div className="container dev">
  <div data-reveal><span className="eyebrow">Built for developers</span><h2 className="h2" style={{margin:'18px 0 24px'}}>A familiar shape.<br/>A different route.</h2><p className="lede">Keep your existing request shape. Point your client at your router’s <code>/api/v1</code> and use an Anyroute key. Streaming, tools, structured output and provider preferences work as you expect.</p><div className="button-row" style={{marginTop:32}}><Button href="/dashboard/#playground">Try the playground</Button><Button href="/docs/" secondary>API documentation</Button></div></div>
  <div data-reveal="scale"><Code label="Quickstart · node">{sampleRequest}</Code></div>
</div></section>}
