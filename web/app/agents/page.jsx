import PageFrame from '../../components/PageFrame';
import Agents from './Agents';

export const metadata = { title: 'Agents — Anyroute', description: 'Give your agent a budget and a rulebook. Enforced by Anyroute’s router for requests through Anyroute.' };

export default function AgentsPage() {
  return <PageFrame><main id="content" className="page-main">
    <div className="page-title"><span className="eyebrow">AGENT RULEBOOKS</span><h1>Give your agent a budget and a rulebook.</h1><p>Enforced by Anyroute's router for requests through Anyroute.</p></div>
    <Agents/>
  </main></PageFrame>;
}
