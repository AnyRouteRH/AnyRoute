import PageFrame from '../../components/PageFrame';
import Agents from './Agents';

export const metadata = { title: 'Agents — Anyroute', description: 'Give your agent a budget and a rulebook. Enforced by AnyRoute’s router for requests through AnyRoute.' };

export default function AgentsPage() {
  return <PageFrame><main id="content" className="page-main">
    <div className="page-title"><span className="eyebrow">AGENT RULEBOOKS</span><h1>Give your agent a budget and a rulebook.</h1><p>Enforced by AnyRoute's router for requests through AnyRoute.</p></div>
    <div className="side-layout"><nav className="side-nav" aria-label="Account sections"><span className="side-nav-label">Your account</span><a href="/dashboard/">Dashboard</a><a href="/agents/" aria-current="page">Agents</a><a href="/agents/directory/">Public directory</a><a href="/keep/">What we keep</a></nav><Agents/></div>
  </main></PageFrame>;
}
