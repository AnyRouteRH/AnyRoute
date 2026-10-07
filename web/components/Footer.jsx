import ThemeToggle from './ThemeToggle'; // C126
import SignalField from './SignalField';
import {Button} from './UI';
import {Wordmark} from './Logo';

import {GROUPS,TASKS} from '../lib/site-map';
// Footer-only links that aren't tools in the menus: page sections, SDKs, a few search-only pages and support.
const EXTRA={build:[['SDKs','/docs/#sdk'],['Playground','/dashboard/#playground'],['Registry','/registry/']],verify:[['Badge','/docs/#badge'],['Proof-time','/status/#proof-time']],learn:[['Quickstart','/#developers'],['How it works','/#how-it-works'],['Route types','/#routes'],['Privacy route','/#privacy'],['Support','mailto:Anyroute1@atomicmail.io']]};
const COLUMNS=GROUPS.map(group=>[group.title,[...TASKS.filter(task=>task.group===group.id&&task.menu).map(task=>[task.title,task.href]),...(EXTRA[group.id]||[])]]);

/** Site footer: closing call to action over the signal curtain, link columns and the oversized wordmark. */
export default function Footer(){return <footer className="site-footer">
  <div className="footer-cta"><SignalField/><div className="container" data-reveal><span className="eyebrow tick">Start routing</span><h2 style={{marginTop:24}}>Build with <em>any</em><br/>model.</h2><p>One key, one prepaid balance and a receipt for every call. Change two lines and keep your SDK.</p><div className="button-row"><Button href="/dashboard/" light>Open dashboard</Button><Button href="/docs/" secondary>Read the docs</Button></div></div></div>
  <div className="container footer-links"><div className="footer-about"><Wordmark aria-hidden="true"/><p>The open inference router for Robinhood Chain. Any model, any provider, an accountable route.</p></div>{COLUMNS.map(([title,links])=><nav key={title} aria-label={title}><h4>{title}</h4><ul>{links.map(([label,href])=><li key={label}><a href={href}>{label}</a></li>)}</ul></nav>)}</div>
  <div className="container"><ThemeToggle/></div> {/* C126 */}
  <div className="footer-giant" aria-hidden="true"><Wordmark/></div>
  <div className="container footer-base"><span><i/>Built on Robinhood Chain</span><span>Receipts: Ed25519 · signed per call</span><span>© Anyroute</span></div>
</footer>}
