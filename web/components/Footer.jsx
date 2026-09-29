import SignalField from './SignalField';
import {Button} from './UI';
import {Wordmark} from './Logo';

const COLUMNS=[['Product',[['Models','/models/'],['Arena','/arena/'],['Dashboard','/dashboard/'],['Playground','/dashboard/#playground'],['Case study','/case-study/']]],['Developers',[['API docs','/docs/'],['SDKs','/docs/#sdk'],['Verify a provider','/verify/'],['Proof-time','/status/'],['Quickstart','/#developers'],['Route types','/#routes'],['How it works','/#how-it-works']]],['Anyroute',[['About','/#about'],['Roadmap','/#roadmap'],['Privacy route','/#privacy'],['Data notice','/legal/privacy/'],['Terms','/legal/terms/'],['Support','mailto:Anyroute1@atomicmail.io']]]];

/** Site footer: closing call to action over the signal curtain, link columns and the oversized wordmark. */
export default function Footer(){return <footer className="site-footer">
  <div className="footer-cta"><SignalField/><div className="container" data-reveal><span className="eyebrow tick">Start routing</span><h2 style={{marginTop:24}}>Build with <em>any</em><br/>model.</h2><p>One key, one USDG balance and a receipt for every call. Change two lines and keep your SDK.</p><div className="button-row"><Button href="/dashboard/" light>Open dashboard</Button><Button href="/docs/" secondary>Read the docs</Button></div></div></div>
  <div className="container footer-links"><div className="footer-about"><Wordmark aria-hidden="true"/><p>The open inference router for Robinhood Chain. Any model, any provider, an accountable route.</p></div>{COLUMNS.map(([title,links])=><nav key={title} aria-label={title}><h4>{title}</h4><ul>{links.map(([label,href])=><li key={label}><a href={href}>{label}</a></li>)}</ul></nav>)}</div>
  <div className="footer-giant" aria-hidden="true"><Wordmark/></div>
  <div className="container footer-base"><span><i/>Settled in USDG on Robinhood Chain</span><span>Receipts: Ed25519 · anchored hourly</span><span>© Anyroute</span></div>
</footer>}
