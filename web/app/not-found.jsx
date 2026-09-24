import PageFrame from '../components/PageFrame';
import {Button} from '../components/UI';
export const metadata={title:'Page not found — Anyroute'};
const TRACE=[['01','resolve path','no match',true],['02','try fallbacks','none configured'],['03','respond','404 · not found',true]];
export default function NotFound(){return <PageFrame><main className="page-main not-found" id="content">
  <div className="not-found-grid">
    <div className="page-title" data-reveal><span className="eyebrow">ERROR 404 / NO ROUTE</span><h1>This route doesn’t resolve.</h1><p>The page you asked for isn’t here. It may have moved, or the address may contain a typo.</p><div className="button-row"><Button href="/">Back to Anyroute</Button><Button href="/docs/" secondary>Read the docs</Button></div></div>
    <div className="route-trace" data-reveal="scale" aria-hidden="true"><div className="route-trace-head"><span>Route trace</span><b>404</b></div>{TRACE.map(([n,step,result,bad])=><div className="route-trace-row" key={n}><span>{n}</span><span>{step}</span><b className={bad?'bad':''}>{result}</b></div>)}<div className="route-trace-foot"><i/>Checked against every published page</div></div>
  </div>
</main></PageFrame>}
