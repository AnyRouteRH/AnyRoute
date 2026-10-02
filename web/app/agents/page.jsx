import PageFrame from '../../components/PageFrame';
import Agents from './Agents';

export const metadata = { title: 'Agents — Anyroute', description: 'Give your agent a budget and a rulebook. Enforced by AnyRoute’s router for requests through AnyRoute.' };

export default function AgentsPage() {
  return <PageFrame><main id="content" className="page-main">
    <div className="page-title"><span className="eyebrow">AGENT RULEBOOKS</span><h1>Give your agent a budget and a rulebook.</h1><p>Enforced by AnyRoute's router for requests through AnyRoute.</p></div>
    <Agents/>
  </main></PageFrame>;
}
